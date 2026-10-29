#!/usr/bin/env bash
# Deploy to the current kubectl context. Creates k8s/secrets/*.env on first run (random DB password).
# LLM picks the model behind the analysis agents (default mock):
#   LLM=mock     scripted stand-in, no model, no key; the verifier still rejects its planted mistakes
#   LLM=host     Ollama running on this machine (uses its GPU); HOST_IP overrides the detected address
#   LLM=cluster  Ollama as a pod inside the cluster, CPU only, small model; slow but self-contained
set -euo pipefail
cd "$(dirname "$0")/.."
LLM=${LLM:-mock}
case "$LLM" in
  mock) DIR=k8s ;;
  host) DIR=overlays/llm-host ;;
  cluster) DIR=overlays/llm-cluster ;;
  *) echo "LLM must be mock, host or cluster (got '$LLM')" >&2; exit 1 ;;
esac
if [ ! -f k8s/secrets/db.env ]; then
  PW=$(openssl rand -hex 16)
  sed -e "s/change-me/$PW/g" k8s/secrets/db.env.example > k8s/secrets/db.env
  echo "created k8s/secrets/db.env with a random database password"
fi
for f in github llm; do
  [ -f "k8s/secrets/$f.env" ] || { cp "k8s/secrets/$f.env.example" "k8s/secrets/$f.env"; echo "created k8s/secrets/$f.env (fill in to enable the GitHub App / a real LLM)"; }
done
if grep -q YOUR_DOCKERHUB_USER k8s/kustomization.yaml; then
  echo "Run  DOCKERHUB_USER=<you> ./scripts/build-push.sh  first (or edit the images in k8s/kustomization.yaml)."; exit 1
fi

model=$(sed -nE 's/^ *OPENAI_MODEL: *([^ #]+).*/\1/p' k8s/config.yaml)
if [ "$LLM" = host ]; then
  curl -sf http://localhost:11434/api/tags >/dev/null || {
    echo "LLM=host needs Ollama running on this machine (https://ollama.com, then 'ollama serve')." >&2
    echo "On Linux start it with OLLAMA_HOST=0.0.0.0 so the cluster can reach it." >&2; exit 1; }
  curl -sf http://localhost:11434/api/tags | grep -q "\"$model\"" || { echo "pulling $model into the host's Ollama"; ollama pull "$model"; }
  if [ -z "${HOST_IP:-}" ]; then
    # kind: Docker Desktop names the host host.docker.internal; on Linux it is the kind network's gateway
    node=$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}')
    HOST_IP=$(docker exec "$node" getent ahostsv4 host.docker.internal 2>/dev/null | awk 'NR==1{print $1}' || true)
    [ -n "$HOST_IP" ] || HOST_IP=$(docker network inspect kind -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -m1 -E '^[0-9.]+$' || true)
    [ -n "$HOST_IP" ] || { echo "could not find the host's address from the cluster; set HOST_IP" >&2; exit 1; }
  fi
  sed "s/HOST_IP/$HOST_IP/g" overlays/llm-host/host-endpoint.yaml.in > overlays/llm-host/host-endpoint.yaml
  echo "model: $model on the host's Ollama at $HOST_IP:11434"
fi

# Switching modes: remove what another mode left behind, so "ollama" means exactly one thing.
ns=deepscan
if kubectl get namespace "$ns" >/dev/null 2>&1; then
  [ "$LLM" = cluster ] || kubectl -n "$ns" delete deployment/ollama pvc/ollama-models networkpolicy/ollama --ignore-not-found --wait=false >/dev/null
  [ "$LLM" = host ] || kubectl -n "$ns" delete endpointslice/ollama-host --ignore-not-found >/dev/null
  [ "$LLM" != mock ] || kubectl -n "$ns" delete service/ollama networkpolicy/agent-egress-ollama --ignore-not-found >/dev/null
  # a Service keeps its selector across apply; recreate it when moving between host and cluster
  if kubectl -n "$ns" get service/ollama >/dev/null 2>&1; then
    has_selector=$(kubectl -n "$ns" get service/ollama -o jsonpath='{.spec.selector}')
    { [ "$LLM" = host ] && [ -n "$has_selector" ]; } || { [ "$LLM" = cluster ] && [ -z "$has_selector" ]; } \
      && kubectl -n "$ns" delete service/ollama >/dev/null
  fi
fi

kubectl apply -k "$DIR"
kubectl -n "$ns" rollout status statefulset/postgres --timeout=180s
if [ "$LLM" = cluster ]; then
  echo "waiting for the in-cluster Ollama to download its model (first run only)..."
  kubectl -n "$ns" rollout status deploy/ollama --timeout=1200s
fi
# the agents read LLM_PROVIDER at start-up, so a mode change needs fresh pods
kubectl -n "$ns" rollout restart deploy/analysis-agent >/dev/null
for d in rag-service verifier github-connector findings-api analysis-agent dashboard; do
  kubectl -n "$ns" rollout status "deploy/$d" --timeout=300s
done
if [ "$LLM" != mock ]; then
  kubectl -n "$ns" exec deploy/analysis-agent -- node -e \
    "const u=process.env.OPENAI_BASE_URL.replace(/\\/v1\\/?\$/,'')+'/api/tags';fetch(u).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(j=>{console.log('agent reaches the model at '+u+': '+j.models.map(m=>m.name).join(', '));process.exit(0)},e=>{console.error('agent cannot reach '+u+': '+e.message);process.exit(1)})"
fi
echo
echo "Model: LLM=$LLM"
echo "Dashboard:  kubectl -n deepscan port-forward svc/dashboard 8080:8080   then open http://localhost:8080"
echo "(or the ingress controller's address, if ingress-nginx is installed)"
