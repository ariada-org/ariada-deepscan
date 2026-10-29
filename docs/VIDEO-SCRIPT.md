# Video script (≈ 8 minutes)

| Time | Show | Say |
|---|---|---|
| 0:00 – 1:00 | README diagram | The problem: accessibility scanners look at pages, not repositories, and cannot say which change broke what. DeepScan = GitHub App + AI agent with RAG + deterministic verifier. |
| 1:00 – 2:30 | Diagram, then `k8s/services.yaml` | The six microservices and the database: who calls whom over REST, the queue in Postgres (SKIP LOCKED), the type-safe contracts. |
| 2:30 – 3:30 | Terminal | `./scripts/deploy.sh`, `kubectl -n deepscan get pods,svc,pvc,hpa,ingress` |
| 3:30 – 4:45 | Dashboard | Scan the demo repository: the ribbon fills in, each file shows which agent pod analysed it; open `index.html` and explain verified / needs review / rejected. |
| 4:45 – 5:30 | Terminal + dashboard | `kubectl -n deepscan patch hpa analysis-agent -p '{"spec":{"minReplicas":6}}'`, rescan: more pod colours, shorter time. |
| 5:30 – 6:15 | Logs | `kubectl logs -l app.kubernetes.io/name=analysis-agent -f`: tool calls (`search_wcag`, `run_rules`), a schema violation (invented WCAG criterion) repaired by the model, the verifier rejecting a hallucinated snippet. |
| 6:15 – 6:45 | Terminal | `kubectl delete pod postgres-0`; after the restart the scans are still there (PVC). |
| 6:45 – 7:30 | GitHub PR (or the simulator log) | Check run fails on 1 new issue, inline comment, summary; pre-existing issues do not block. Browser extension outlines the findings on the live site. |
| 7:30 – 8:30 | `k8s/` YAML | Deployment (probes, resources, securityContext), StatefulSet + volumeClaimTemplates, Ingress, HPA, NetworkPolicy. Close with security and the scaling assumption. |
