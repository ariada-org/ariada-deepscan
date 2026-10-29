#!/usr/bin/env bash
# Deploy to the current kubectl context. Creates k8s/secrets/*.env on first run (random DB password).
set -euo pipefail
cd "$(dirname "$0")/.."
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
kubectl apply -k k8s/
kubectl -n deepscan rollout status statefulset/postgres --timeout=180s
for d in rag-service verifier github-connector findings-api analysis-agent dashboard; do
  kubectl -n deepscan rollout status "deploy/$d" --timeout=300s
done
echo
echo "Dashboard:  kubectl -n deepscan port-forward svc/dashboard 8080:8080   then open http://localhost:8080"
echo "(or the ingress controller's address, if ingress-nginx is installed)"
