#!/usr/bin/env bash
# Local Postgres (with pgvector) for development without Docker.
set -euo pipefail
DIR=${PGDATA_DIR:-/tmp/deepscan-pg}
BIN=$(ls -d /usr/lib/postgresql/*/bin | tail -1)
if [ ! -d "$DIR" ]; then
  mkdir -p "$DIR" && chown postgres "$DIR" 2>/dev/null || true
  su postgres -c "$BIN/initdb -D $DIR -U postgres --auth=trust" >/dev/null
fi
su postgres -c "$BIN/pg_ctl -D $DIR -l $DIR/log -o '-p 5432 -k /tmp' start" || true
sleep 2
psql -h /tmp -U postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='deepscan'" | grep -q 1 || \
  psql -h /tmp -U postgres -c "CREATE ROLE deepscan LOGIN SUPERUSER PASSWORD 'deepscan'"
psql -h /tmp -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='deepscan'" | grep -q 1 || \
  psql -h /tmp -U postgres -c "CREATE DATABASE deepscan OWNER deepscan"
echo "postgres://deepscan:deepscan@localhost:5432/deepscan"
