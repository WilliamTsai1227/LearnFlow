#!/usr/bin/env bash
set -euo pipefail

# 本地 build 並 push 到 Docker Hub
# 用法：
#   export DOCKERHUB_USER=your_username
#   export IMAGE_TAG=latest        # 或 0.1.0
#   ./deploy/scripts/build-and-push.sh

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DOCKERHUB_USER="${DOCKERHUB_USER:?請設定 DOCKERHUB_USER}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

BACKEND_IMAGE="${DOCKERHUB_USER}/learnflow-backend:${IMAGE_TAG}"
NGINX_IMAGE="${DOCKERHUB_USER}/learnflow-nginx:${IMAGE_TAG}"

echo "==> Build backend: ${BACKEND_IMAGE}"
docker build --platform linux/amd64 -f "${ROOT_DIR}/deploy/Dockerfile" -t "${BACKEND_IMAGE}" "${ROOT_DIR}"

echo "==> Build nginx: ${NGINX_IMAGE}"
docker build -f "${ROOT_DIR}/deploy/Dockerfile.nginx" -t "${NGINX_IMAGE}" "${ROOT_DIR}"

echo "==> Push images"
docker push "${BACKEND_IMAGE}"
docker push "${NGINX_IMAGE}"

echo ""
echo "完成。EC2 上設定 .env 後執行："
echo "  docker compose -f docker-compose.prod.yml pull"
echo "  docker compose -f docker-compose.prod.yml up -d"
