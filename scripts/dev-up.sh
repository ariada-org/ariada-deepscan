#!/usr/bin/env bash
# Run every service locally with tsx (no Docker/Kubernetes). Needs Postgres+pgvector on localhost:5432.
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL=${DATABASE_URL:-postgres://deepscan:deepscan@localhost:5432/deepscan}
export LOG_LEVEL=${LOG_LEVEL:-info}
LOGS=${LOGS:-/tmp/deepscan-logs}; mkdir -p "$LOGS"
run() { local name=$1 port=$2; shift 2; (cd "services/$name" && env PORT=$port POD_NAME="$name-local" "$@" npx tsx src/index.ts >"$LOGS/$name.log" 2>&1 &) ; echo "started $name on :$port (log $LOGS/$name.log)"; }
(cd services/rag-service && npx tsx src/ingest.ts >"$LOGS/rag-ingest.log" 2>&1)
run verifier 8081
run rag-service 8082
run github-connector 8083 FIXTURES_DIR="$PWD/fixtures" FINDINGS_API_URL=http://localhost:8084 VERIFIER_URL=http://localhost:8081 PUBLIC_URL=http://localhost:8080
run findings-api 8084
run analysis-agent 8085 CONNECTOR_URL=http://localhost:8083 RAG_URL=http://localhost:8082 VERIFIER_URL=http://localhost:8081 WORKER_CONCURRENCY=${WORKER_CONCURRENCY:-3} MOCK_DELAY_MS=${MOCK_DELAY_MS:-300}
run dashboard ${DASHBOARD_PORT:-8080} CONNECTOR_URL=http://localhost:8083 FINDINGS_API_URL=http://localhost:8084
