#!/usr/bin/env bash
# One command, laptop to running app: a local Kubernetes cluster (kind), the NGINX ingress controller,
# and DeepScan from the published Docker Hub images. Needs docker, kind and kubectl.
#   ./scripts/kind-up.sh                 → asks which model to use, then http://localhost:8088
#   ./scripts/kind-up.sh mock|host|cluster   (or LLM=... ) to skip the question
set -euo pipefail
cd "$(dirname "$0")/.."
LLM=${1:-${LLM:-}}
if [ -z "$LLM" ] && [ -t 0 ]; then
  cat <<'EOF'
Which model should the analysis agents use?
  1) mock     no model at all: a scripted stand-in, starts in seconds, no GPU or key needed
  2) host     Ollama on this machine (fastest; uses its GPU; needs https://ollama.com installed)
  3) cluster  Ollama as a pod inside the cluster (CPU only, small model, slow; nothing to install)
EOF
  read -r -p "Choice [1]: " c
  case "${c:-1}" in 1|mock) LLM=mock ;; 2|host) LLM=host ;; 3|cluster) LLM=cluster ;; *) echo "unknown choice: $c" >&2; exit 1 ;; esac
fi
export LLM=${LLM:-mock}
kind get clusters 2>/dev/null | grep -qx deepscan || kind create cluster --config k8s/local/kind-cluster.yaml
kubectl config use-context kind-deepscan >/dev/null
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl -n ingress-nginx wait --for=condition=ready pod -l app.kubernetes.io/component=controller --timeout=300s
./scripts/deploy.sh
echo
echo "DeepScan is up:  http://localhost:8088   (model: $LLM)"
