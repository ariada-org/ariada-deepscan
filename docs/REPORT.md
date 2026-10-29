# Build Something — Ariada DeepScan

*PA2577 Applied Cloud Computing and Big Data · Alekszandr Bricskin*

- Source code and Kubernetes deployment: https://github.com/ariada-org/ariada-deepscan (`k8s/` holds the manifests; images on Docker Hub as `<dockerhub-user>/deepscan-<service>:1.0.0`)
- Video: `<link to the recording>`

## 1. What the software does

Ariada DeepScan is a GitHub App that audits a whole repository for web-accessibility problems against WCAG 2.2. It also audits every pull request incrementally. It is aimed at teams that must comply with accessibility law (EU Accessibility Act, Section 508) and that today rely on page-by-page browser scanners, which only see rendered pages. They do not see the repository, and they cannot say *which change* introduced a problem.

For every markup or style file (HTML, JSX/TSX, Vue, Svelte, CSS) the system does three things:

1. Runs **deterministic rules**, e.g. missing `alt`, unlabeled form fields, icon-only buttons, colour contrast computed from CSS, focus outline removed, viewport zoom disabled.
2. Lets an **LLM agent** look for issues that need judgement, such as non-descriptive alt text, placeholder-only instructions or colour-only error states. The agent grounds itself by calling tools: a **built-in RAG** over WCAG 2.2, the Understanding documents, Techniques, Failures and ARIA practices, plus read-only access to related files.
3. Sends every AI finding through a **deterministic verifier**:
   - **verified**: a rule reproduces it;
   - **rejected**: the snippet does not exist, the criterion does not apply to the element, or a rule contradicts the claim;
   - **unverifiable**: the code is real, but the issue is semantic and needs a human.

Every finding gets a structural **fingerprint** that is stable across line shifts. Pull requests are compared with the scan of their base commit, which classifies each finding as **new**, **fixed** or **pre-existing**. Only new, verified findings of blocking severity fail the GitHub check. Results are published as a Check Run with annotations, inline review comments and a summary comment. They are also shown in a web dashboard that displays the repository tree while it is being scanned, and in a browser extension that outlines the issues on the live website.

**Scale assumption.** The demo repository has 13 analysable files, which does not need scaling. To make the architecture meaningful, assume a SaaS that serves organisations with thousands of repositories and hundreds of pull requests per day, where each file costs an LLM round trip of several seconds. In the default configuration the mock LLM simulates this latency (`MOCK_DELAY_MS`).

## 2. Architecture

![Architecture](assets/architecture.png)

![Dashboard during a scan: each cell is a file, coloured by the agent pod that analysed it](assets/dashboard.png)

### Components and their microservices

| Component | Responsibility | Microservice |
|---|---|---|
| GitHub integration | Receives and authenticates webhooks; obtains installation tokens from the App's private key; snapshots repository trees and PR file lists; publishes check runs, reviews and comments; signs users in. It is the only component that holds GitHub secrets. | `github-connector` |
| Analysis | Takes file jobs from the queue; runs the LLM tool loop; caches results by content hash; writes findings. | `analysis-agent` |
| Knowledge base | Hybrid retrieval (PostgreSQL full-text + pgvector embeddings, fused with Reciprocal Rank Fusion) over 158 WCAG documents; criterion details. | `rag-service` |
| Verification and policy | Rules engine over a framework-neutral element model (HTML via parse5, JSX/TSX via Babel, Vue/Svelte templates, CSS via PostCSS); verification of candidates; fingerprints; PR policy gate. Stateless and CPU-bound. | `verifier` |
| Read model | Trees with per-file status, scan progress, findings, version diffs, plugin feed; authorisation of the viewer. | `findings-api` |
| User interface | Dashboard SPA; strict CSP; local proxy for `/api` and `/gh`. | `dashboard` |
| Persistence | Repositories, scans, the job queue, findings, baselines, exemptions, the RAG corpus, sessions. | PostgreSQL 16 + pgvector (StatefulSet with a PersistentVolumeClaim) |
| Type-safe contract layer | Zod schemas shared by every service and the browser. They generate the TypeScript types, the JSON Schemas of the LLM tools and the OpenAPI documents, and they validate every boundary at runtime. | library `packages/contracts` (not a service: a network hop just to validate would be an anti-pattern) |

### How the services interact

- **Webhook receiver + asynchronous request-reply.** GitHub expects an answer within 10 s. The connector verifies the HMAC, stores the delivery (deduplicated by `X-GitHub-Delivery`) and answers `202` at once. A background worker processes deliveries.
- **Queue-based load levelling with competing consumers.** A scan becomes one row per file in `scan_jobs`. Agent replicas claim rows with `SELECT … FOR UPDATE SKIP LOCKED` and a lease (`locked_until`). If a pod dies, its job becomes claimable again when the lease expires (max 3 attempts). The last finisher marks the scan complete under a row lock on the scan, so concurrent finishers cannot race.
- **Synchronous REST for tools.** The agent calls the connector (`read_file`, `list_related`), the RAG (`search_wcag`, `get_sc`) and the verifier (`run_rules`, `verify`). Every response is validated against its contract by the typed REST client.
- **CQRS-lite.** Writes go through the connector and the agents. All reads for the UI, the plugin and the publisher go through `findings-api`.
- **Gateway routing.** One Ingress maps `/` to the dashboard, `/api` to findings-api and `/gh` to the connector. `/internal/*` is never routed.
- **Cache-aside.** Installation tokens are cached for 55 minutes, file contents by blob SHA, and analysis results by `hash(prompt version, model, content)`. Unchanged files therefore cost no LLM call on the next scan.
- **Generator–verifier.** The LLM proposes and deterministic code decides. The type layer, the verifier and the human reviewer are three successive filters against hallucinations.

### Deployment

Each microservice is a Deployment with its own Service, its own HorizontalPodAutoscaler, readiness and liveness probes, and resource requests and limits. They are built from a single multi-stage Dockerfile: esbuild bundles each service into one file, which runs on `node:22-alpine` as a non-root user. Images are multi-arch (amd64/arm64) on Docker Hub.

PostgreSQL is a StatefulSet whose `volumeClaimTemplate` keeps data across pod and cluster restarts. The RAG corpus is loaded by an init container of `rag-service`; it is idempotent and runs under a Postgres advisory lock, as do the schema migrations. Configuration lives in a ConfigMap. Secrets are three Kustomize-generated Secrets: database, GitHub App and LLM, each mounted only into the services that need it. The namespace enforces the Pod Security *restricted* profile.

### Testing

- 20 unit tests: rules and verifier, contract layer, webhook signatures and sanitising. Typecheck of all services, including the browser code.
- End-to-end: the bundled services ran against PostgreSQL + pgvector. A full scan of the demo repository was split across three agent replicas. Postgres was restarted in the middle of a scan; all services reconnected and the scan completed.
- The GitHub App flow (installation → baseline scan → pull request → failing check run, inline review comments, summary comment) was tested against a GitHub API simulator (`scripts/fake-github.mjs`). Forged signatures get 401; repeated deliveries are ignored.
- CI (`.github/workflows/ci.yml`) builds all images, deploys `k8s/` to a kind Kubernetes cluster, scans the demo repository through the dashboard, checks that both agent replicas took jobs, and deletes the Postgres pod to show that the data survives on the PVC.

![Browser extension outlining verified findings on the demo site](assets/extension-overlay.png)

## 3. Benefits, challenges and mitigations

### Benefits

- **Independent scaling where the cost is.** LLM latency dominates, so only `analysis-agent` needs many replicas; `verifier` and `rag-service` scale on CPU. A burst of pull requests grows the queue, not the error rate.
- **Resilience.** Agents are stateless and jobs are leased, so killing a pod delays a file instead of losing it. GitHub always gets a fast `202`, and a failed GitHub call is retried from the stored delivery.
- **Trustworthy AI output.** Precision is measured (verified / unverifiable / rejected per scan), and only verified findings can block a merge. That is the business precondition for teams accepting an AI gate.
- **Cost control.** Deterministic rules handle the cheap, certain cases. The content-hash cache and PR-only analysis (changed files only) cut LLM spend, which is the main variable cost of the product.
- **Replaceable model.** The provider interface supports Anthropic, any OpenAI-compatible endpoint (including a self-hosted Ollama for customers who cannot send code to a third party) and a mock.

### Challenges and what was done or can be done

| Challenge | Mitigation (done / possible) |
|---|---|
| PostgreSQL is a single point of failure and a shared bottleneck (queue + data + vectors). | Done: connection pooling, short transactions, partial indexes for the queue, advisory-lock migrations. Possible: managed Postgres with a standby, read replicas for `findings-api`, a dedicated broker (NATS/SQS) for the queue. |
| CPU-based HPA is a poor signal for I/O-bound agents. | Possible: KEDA scaling on the length of `scan_jobs` (a SQL scaler). |
| LLM latency, rate limits and cost. | Done: bounded turns and tool calls per file, retries with backoff, caching, rules first, changed files only on PRs. |
| GitHub API rate limits per installation. | Done: cached tokens and blobs, file contents of public repositories via the raw CDN, annotations batched by 50. Possible: ETag conditional requests, honouring `Retry-After`. |
| Static analysis cannot see runtime DOM, computed styles or dynamic values. | Done: rules return "cannot decide" for dynamic values instead of guessing. Possible: a worker type that renders pages in a headless browser. |
| Webhooks need a public endpoint. | Ingress + TLS in the cloud; a tunnel (cloudflared) for local clusters. |
| Fingerprints change when a file is renamed. | Renames show up as fixed + new. Possible: map renames from the PR file list. |

### Security

| Threat | Mitigation |
|---|---|
| Forged webhooks | HMAC-SHA256 over the raw body with constant-time comparison; delivery-ID de-duplication against replay; size limit. |
| Leaked or over-privileged GitHub credentials | GitHub App instead of personal tokens: short-lived (1 h) installation tokens scoped to the installation, minimal permissions (contents read, checks/pull requests write). The private key exists only in the connector's Secret. NetworkPolicy allows egress to the internet only from the connector and the agent. |
| Kubernetes Secrets are only base64-encoded | Possible: Sealed Secrets or External Secrets with a cloud KMS, and encryption at rest for etcd. Secrets are split by need-to-know: database credentials go to the four DB clients, the GitHub App key only to the connector and the LLM key only to the agent. `k8s/secrets/*.env` is git-ignored, and `deploy.sh` generates it with random passwords. |
| Untrusted repository content | Never executed: only parsed. File size and file count limits. Tool paths are branded `RepoPath` values (no absolute paths, no `..`) and must exist in the snapshot. |
| Prompt injection via repository content | The file is passed as data with an explicit instruction to ignore embedded instructions. Tools are read-only, scoped to one snapshot, and include no network tools. Budgets on turns and tool calls. Every claim is re-verified. Text posted to GitHub comes from a fixed template, and LLM text is sanitised (no HTML, links or @-mentions). |
| Hallucinated or malformed model output | Zod validation of every tool call, with the error returned to the model as a repair loop; the closed WCAG enum; the deterministic verifier. |
| SSRF through "scan this URL" | Only `https://github.com/{owner}/{repo}` is accepted (regex + brand type). File contents are fetched from fixed GitHub hosts. Egress to private ranges and `169.254.169.254` is blocked by NetworkPolicy. |
| Unauthorised access to private results | Sign in with GitHub. The session stores the user's installation IDs; findings of App-installed repositories are only visible to users with access to that installation, and missing access returns 404, not 403. Cookies are httpOnly, SameSite=Lax and Secure under HTTPS, with an OAuth `state` check. The user's OAuth token is discarded after login. |
| Abuse of anonymous scans | Public scans can be disabled; a per-IP rate limit and an optional API key. Possible: a shared rate limit (Redis) and a global request rate at the Ingress (an annotation is set). |
| Browser attacks on the dashboard | Strict CSP (no inline scripts), `X-Frame-Options: DENY`, `nosniff`, no `innerHTML` with data (DOM APIs only). |
| Lateral movement in the cluster | Default-deny NetworkPolicies, with only the calls in the diagram allowed. Pods run non-root with a read-only root filesystem, all capabilities dropped and the RuntimeDefault seccomp profile. Service-account tokens are not mounted. |
| Supply chain | A single bundled JS file per image, no package manager at runtime, frozen lockfile. Possible: image scanning (Trivy) and signing (cosign) in CI. |

## 4. Business implications of the design

- **Pay for what is used.** Cost scales with the number of changed files analysed by the LLM, and the queue makes that work elastic. Price per active repository or per analysed file maps directly onto the cost driver.
- **Trust as a feature.** The verified/unverifiable split turns AI output into something an organisation can gate merges on and show to auditors. The fingerprint baseline means a team with an existing backlog can adopt the gate without being blocked on day one.
- **Data residency and model choice.** The provider abstraction allows an on-premise or EU-hosted model, which is a sales requirement in regulated sectors.
- **Lock-in.** The system is portable: plain Kubernetes, PostgreSQL and REST. The only external dependencies are GitHub and the LLM API.

## 5. Use of generative AI

*(Adapt to the course GenAI policy.)* Generative AI (Claude) was used as a programming assistant while designing and implementing this project. All code was reviewed, run and tested by the author; the design decisions and their justification are the author's.
