#!/usr/bin/env bash
# One command, laptop to running app: a local Kubernetes cluster (kind), the NGINX ingress controller,
# and DeepScan from the published Docker Hub images. Needs docker, kind and kubectl.
#   ./scripts/kind-up.sh          → http://localhost:8088
set -euo pipefail
cd "$(dirname "$0")/.."
kind get clusters 2>/dev/null | grep -qx deepscan || kind create cluster --config k8s/local/kind-cluster.yaml
kubectl config use-context kind-deepscan >/dev/null
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl -n ingress-nginx wait --for=condition=ready pod -l app.kubernetes.io/component=controller --timeout=300s
./scripts/deploy.sh
echo
echo "DeepScan is up:  http://localhost:8088"
