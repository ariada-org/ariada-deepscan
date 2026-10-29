#!/usr/bin/env bash
# Build multi-arch images (linux/amd64 + linux/arm64) for every service, push them to Docker Hub
# and point k8s/kustomization.yaml at them.
#   DOCKERHUB_USER=yourname TAG=1.0.0 ./scripts/build-push.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DOCKERHUB_USER:?set DOCKERHUB_USER}"
TAG=${TAG:-1.0.0}
PLATFORMS=${PLATFORMS:-linux/amd64,linux/arm64}
SERVICES="github-connector analysis-agent rag-service verifier findings-api dashboard"
docker buildx inspect deepscan >/dev/null 2>&1 || docker buildx create --name deepscan --use
for s in $SERVICES; do
  echo "==> $s"
  docker buildx build --platform "$PLATFORMS" --build-arg SERVICE="$s" -t "docker.io/$DOCKERHUB_USER/deepscan-$s:$TAG" --push .
done
# rewrite image names in the kustomization
sed -i.bak -E "s#newName: docker.io/[^/]+/deepscan-#newName: docker.io/$DOCKERHUB_USER/deepscan-#; s#newTag: .*#newTag: \"$TAG\"#" k8s/kustomization.yaml && rm -f k8s/kustomization.yaml.bak
echo "Pushed. Deploy with: kubectl apply -k k8s/"
