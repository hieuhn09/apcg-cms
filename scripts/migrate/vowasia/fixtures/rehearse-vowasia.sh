#!/usr/bin/env bash
# Scripted VowAsia phase-B rehearsal (Amendment 4 §4.4 item 13; Hybrid gate G19). LOCAL ONLY.
#
#   REHEARSE_MODE=native npm run rehearse:vowasia
#
# Native PostgreSQL 16 only (/usr/lib/postgresql/16/bin, runuser, a postgres OS user).
# Ports: 54346 fake legacy DB, 54347 local Central, 3519 fake image host (3518 is
# reserved for a Central dev server and must be free; it is not started).
# ONE run, ALONE, in the background (no other probe, rehearsal or npm ci at the same time).
# `npm ci` is OFF (set REHEARSE_NPM_CI=1 to run it). Every database URL below is a
# literal 127.0.0.1 URL; rehearse-assert.ts re-checks them with assertLocalDb.
# Snapshot, image store, runs dir and both database clusters live in ONE fresh
# `mktemp -d /tmp/vowasia-rehearse-XXXXXX` (outside the repo), removed at the end.
# The cleanup trap stops ONLY the servers this script started.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
ROOT=$(pwd)
MODE=${REHEARSE_MODE:-native}
if [ "$MODE" != native ]; then echo "[rehearse] only REHEARSE_MODE=native is supported; refusing." >&2; exit 2; fi
PGBIN=/usr/lib/postgresql/16/bin
if [ ! -x "$PGBIN/initdb" ] || ! command -v runuser >/dev/null || ! command -v psql >/dev/null || ! id postgres >/dev/null 2>&1; then
  echo "[rehearse] UNPROVEN: needs native PostgreSQL 16 in $PGBIN, psql, runuser and a postgres OS user." >&2
  exit 3
fi
for p in 54346 54347 3518 3519; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then echo "[rehearse] port $p is already in use; refusing (another rehearsal or server?)." >&2; exit 2; fi
done
WORK=$(mktemp -d /tmp/vowasia-rehearse-XXXXXX)
PIDS=()
STARTED=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  for d in "${STARTED[@]:-}"; do [ -n "$d" ] && runuser -u postgres -- "$PGBIN/pg_ctl" -D "$d" -m immediate -w stop >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
  echo "[rehearse] cleanup done (servers stopped, $WORK removed)"
}
trap cleanup EXIT INT TERM
chmod 755 "$WORK"
mkdir -p "$WORK/pg"
chown postgres "$WORK/pg"
chmod 755 "$WORK/pg"

if [ "${REHEARSE_NPM_CI:-0}" = 1 ]; then npm ci --no-audit --no-fund; fi

# Two throwaway clusters.
for spec in "legacy:54346" "central:54347"; do
  d=${spec%%:*}; port=${spec##*:}
  runuser -u postgres -- "$PGBIN/initdb" -D "$WORK/pg/$d" -U postgres --auth=trust >/dev/null
  runuser -u postgres -- "$PGBIN/pg_ctl" -D "$WORK/pg/$d" -o "-p $port -k $WORK/pg -c listen_addresses=127.0.0.1" -l "$WORK/pg/$d.log" -w start >/dev/null
  STARTED+=("$WORK/pg/$d")
done
psql -h 127.0.0.1 -p 54346 -U postgres -d postgres -qc "ALTER USER postgres PASSWORD 'password'" -c "CREATE DATABASE vowasia_legacy"
psql -h 127.0.0.1 -p 54347 -U postgres -d postgres -qc "ALTER USER postgres PASSWORD 'password'" -c "CREATE DATABASE vowasia_rehearsal"

export DATABASE_URL=postgresql://postgres:password@127.0.0.1:54347/vowasia_rehearsal
export DATABASE_DIRECT_URL=$DATABASE_URL
export PAYLOAD_SECRET=rehearsal-only-payload-secret-0000000000000000
export CENTRAL_SIGNING_SECRET=rehearsal-only-signing-secret-000000000000000
export SEED_ADMIN_EMAIL=admin@example.invalid SEED_ADMIN_PASSWORD=rehearsal-only-password SEED_ENGINE_TOKEN=rehearsal-engine-token
export LEGACY_VOWASIA_DB_URL=postgres://vowasia_migrator:password@127.0.0.1:54346/vowasia_legacy
export LEGACY_VOWASIA_DB_SSL=disable
export LEGACY_FIXTURE_ADMIN_URL=postgres://postgres:password@127.0.0.1:54346/vowasia_legacy
export REHEARSE_WORK=$WORK
export MIGRATE_LOAD_TIMEOUT_MS=${MIGRATE_LOAD_TIMEOUT_MS:-90000}
export NEXT_TELEMETRY_DISABLED=1
unset R2_BUCKET R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY || true

# Bootstrap (1): Central schema + base data with the UNCHANGED scripts/seed.ts (push once on the fresh local DB).
SEED_LOG="$WORK/seed.log"
for i in 1 2 3 4; do
  PAYLOAD_DB_PUSH=true timeout 300 node --import tsx scripts/seed.ts >"$SEED_LOG" 2>&1 || true
  grep -q "\[seed\] done" "$SEED_LOG" && break
  echo "[rehearse] seed attempt $i did not finish; retrying" >&2
done
grep -q "\[seed\] done" "$SEED_LOG" || { echo "[rehearse] seed did not finish" >&2; tail -20 "$SEED_LOG" >&2; exit 1; }
export PAYLOAD_DB_PUSH=false

# Bootstrap (2): tenant vowasia (local only); (3): the 49 taxonomy rows through the OWNER script (rehearses OB1).
for i in 1 2 3 4; do
  if timeout 300 node --import tsx scripts/migrate/vowasia/fixtures/rehearse-bootstrap.ts >"$WORK/bootstrap.log" 2>&1; then break; fi
  echo "[rehearse] bootstrap attempt $i failed; retrying" >&2
done
grep -q '^RESULT ' "$WORK/bootstrap.log" || { echo "[rehearse] bootstrap failed" >&2; tail -20 "$WORK/bootstrap.log" >&2; exit 1; }
for i in 1 2 3 4; do
  if timeout 300 npm run -s audit:add-vowasia-taxonomy -- --apply >"$WORK/taxonomy.log" 2>&1; then break; fi
  echo "[rehearse] taxonomy attempt $i failed; retrying" >&2
done
cat "$WORK/taxonomy.log" | tail -5

# Bootstrap (4): fake legacy DB + overlay; fake image host.
node --import tsx scripts/migrate/vowasia/fixtures/vowasia-legacy/seed-vowasia-legacy-fixture.ts --overlay "$WORK/overlay.json" --bulk "${REHEARSE_BULK:-120}"
node --import tsx scripts/migrate/vowasia/fixtures/vowasia-legacy/serve-images.ts >"$WORK/images.log" 2>&1 &
PIDS+=($!)
for i in $(seq 1 60); do (exec 3<>/dev/tcp/127.0.0.1/3519) 2>/dev/null && break; sleep 1; done

node --import tsx scripts/migrate/vowasia/fixtures/rehearse-assert.ts
