#!/usr/bin/env bash
# Scripted GTP migration rehearsal (gtp-launch P4, A11-S12; gate G40). LOCAL ONLY.
#
#   npm run rehearse:gtp [-- --allow-skip-public]
#
# Env: REHEARSE_MODE=docker|native|auto (default auto: docker if `docker info` works),
#      REHEARSE_SKIP_NPM_CI=1 to skip step 0 (npm ci), REHEARSE_ROWS (default 300).
# Ports: 54326 Central Postgres, 54327 legacy fixture Postgres, 54328 image server, 3508 next dev.
# Never touches a non-local database: every URL below is 127.0.0.1, and rehearse-assert.ts
# re-checks them with assertLocalDb. No .env file is read or written; env is exported inline.
# The cleanup trap kills ONLY the PIDs this script started.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
ROOT=$(pwd)
ALLOW_SKIP_PUBLIC=0
for a in "$@"; do
  case "$a" in
    --allow-skip-public) ALLOW_SKIP_PUBLIC=1 ;;
    *) echo "rehearse-gtp: unknown flag $a" >&2; exit 2 ;;
  esac
done
MODE=${REHEARSE_MODE:-auto}
if [ "$MODE" = auto ]; then
  if docker info >/dev/null 2>&1; then MODE=docker; else MODE=native; fi
fi
echo "[rehearse] mode=$MODE"
PIDS=()
NATIVE_DIR=""
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  if [ "$MODE" = docker ]; then
    docker compose -f scripts/migrate/fixtures/gtp-legacy/docker-compose.legacy.yml down -v >/dev/null 2>&1 || true
    PGPASSWORD=password psql -h 127.0.0.1 -p 54326 -U postgres -d postgres -qc "DROP DATABASE IF EXISTS gtp_rehearsal WITH (FORCE)" >/dev/null 2>&1 || true
  elif [ -n "$NATIVE_DIR" ]; then
    for d in central legacy; do [ -d "$NATIVE_DIR/$d" ] && runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$NATIVE_DIR/$d" -m immediate stop >/dev/null 2>&1 || true; done
    rm -rf "$NATIVE_DIR"
  fi
}
trap cleanup EXIT

# Step 0: dependencies.
if [ "${REHEARSE_SKIP_NPM_CI:-0}" != 1 ]; then npm ci --no-audit --no-fund; fi

# Step 1-3: databases.
if [ "$MODE" = docker ]; then
  docker compose up -d >/dev/null
  docker compose -f scripts/migrate/fixtures/gtp-legacy/docker-compose.legacy.yml up -d >/dev/null
  for i in $(seq 1 60); do pg_isready -h 127.0.0.1 -p 54326 -q && pg_isready -h 127.0.0.1 -p 54327 -q && break; sleep 1; done
  sleep 2
  PGPASSWORD=password psql -h 127.0.0.1 -p 54326 -U postgres -d postgres -qc "DROP DATABASE IF EXISTS gtp_rehearsal WITH (FORCE)"
  PGPASSWORD=password psql -h 127.0.0.1 -p 54326 -U postgres -d postgres -qc "CREATE DATABASE gtp_rehearsal"
else
  # Native PG16 as an unprivileged user in a world-traversable temp dir (E6).
  NATIVE_DIR=$(mktemp -d /tmp/gtp-rehearse-XXXXXX)
  chmod 755 "$NATIVE_DIR"
  chown postgres "$NATIVE_DIR"
  for spec in "central:54326" "legacy:54327"; do
    d=${spec%%:*}; port=${spec##*:}
    runuser -u postgres -- /usr/lib/postgresql/16/bin/initdb -D "$NATIVE_DIR/$d" -U postgres --auth=trust >/dev/null
    runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$NATIVE_DIR/$d" -o "-p $port -k $NATIVE_DIR -c listen_addresses=127.0.0.1" -l "$NATIVE_DIR/$d.log" start >/dev/null
  done
  psql -h 127.0.0.1 -p 54326 -U postgres -d postgres -qc "ALTER USER postgres PASSWORD 'password'" -c "CREATE DATABASE gtp_rehearsal"
  psql -h 127.0.0.1 -p 54327 -U postgres -d postgres -qc "ALTER USER postgres PASSWORD 'password'" -c "CREATE DATABASE gtp_legacy"
fi

export DATABASE_URL=postgresql://postgres:password@127.0.0.1:54326/gtp_rehearsal
export DATABASE_DIRECT_URL=$DATABASE_URL
export PAYLOAD_SECRET=rehearsal-only-payload-secret-0000000000000000
export CENTRAL_SIGNING_SECRET=rehearsal-only-signing-secret-000000000000000
export SEED_ADMIN_EMAIL=admin@example.invalid SEED_ADMIN_PASSWORD=rehearsal-only-password SEED_ENGINE_TOKEN=rehearsal-engine-token
export LEGACY_FIXTURE_ADMIN_URL=postgres://postgres:password@127.0.0.1:54327/gtp_legacy
export LEGACY_GTP_DB_URL=postgres://gtp_migrator:password@127.0.0.1:54327/gtp_legacy
export LEGACY_GTP_DB_SSL=disable
export REHEARSE_OUT="$ROOT/scripts/migrate/out/rehearse"
export MIGRATE_LOAD_TIMEOUT_MS=${MIGRATE_LOAD_TIMEOUT_MS:-60000}
export NEXT_TELEMETRY_DISABLED=1

# Legacy fixture + images.
node --import tsx scripts/migrate/fixtures/gtp-legacy/seed-gtp-legacy-fixture.ts --rows "${REHEARSE_ROWS:-300}"
node --import tsx scripts/migrate/fixtures/gtp-legacy/serve-fixture-images.ts >/tmp/gtp-rehearse-images.log 2>&1 &
PIDS+=($!)

# Central schema + Phase 1 gtp fixture (push once on the fresh local DB, then off for every tool run).
SEED_LOG=$(mktemp)
for i in 1 2 3 4; do
  # The seed has no load watchdog: a loader stall exits 0 silently, so success = the tenant line was printed.
  PAYLOAD_DB_PUSH=true SEED_INCLUDE_GTP=true timeout 300 node --import tsx scripts/seed.ts >"$SEED_LOG" 2>&1 || true
  grep -q "created tenant gtp" "$SEED_LOG" && break
  echo "[rehearse] seed attempt $i did not finish; retrying" >&2
  PGPASSWORD=password psql -h 127.0.0.1 -p 54326 -U postgres -d postgres -qc "DROP DATABASE IF EXISTS gtp_rehearsal WITH (FORCE)" -c "CREATE DATABASE gtp_rehearsal"
done
grep -q "created tenant gtp" "$SEED_LOG" || { echo "[rehearse] seed did not create tenant gtp" >&2; tail -20 "$SEED_LOG" >&2; exit 1; }
export GTP_READ_TOKEN=$(sed -n 's/.*created tenant gtp .*READ TOKEN (copy now): \([0-9a-f]*\).*/\1/p' "$SEED_LOG")
rm -f "$SEED_LOG"
export PAYLOAD_DB_PUSH=false

# Public API server (next dev on 3508) for the public parity part.
unset PUBLIC_BASE || true
node "$ROOT/node_modules/next/dist/bin/next" dev -p 3508 >/tmp/gtp-rehearse-next.log 2>&1 &
PIDS+=($!)
for i in $(seq 1 240); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $GTP_READ_TOKEN" "http://localhost:3508/api/public/site" || true)
  [ "$code" = 200 ] && { export PUBLIC_BASE=http://localhost:3508; break; }
  sleep 2
done
if [ -z "${PUBLIC_BASE:-}" ]; then
  if [ "$ALLOW_SKIP_PUBLIC" = 1 ]; then echo "[rehearse] public API server unavailable: SKIPPED (printed in the UNPROVEN list)"; export ALLOW_SKIP_PUBLIC=1;
  else echo "[rehearse] public API server unavailable; pass --allow-skip-public to continue without the public parity part" >&2; exit 1; fi
fi
export ALLOW_SKIP_PUBLIC

node --import tsx scripts/migrate/fixtures/gtp-legacy/rehearse-assert.ts
