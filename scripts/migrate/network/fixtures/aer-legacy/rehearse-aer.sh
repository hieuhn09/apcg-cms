#!/usr/bin/env bash
# Scripted end-to-end rehearsal of the network-legacy tools for tenant aer. LOCAL ONLY.
#
#   npm run rehearse:network-aer
#
# Two throwaway native PG16 clusters (central 55426, legacy 55427) + a local image
# server (55428) under REHEARSE_DIR (default: a fresh mktemp dir). Exercises the REAL
# owner SQL files (01 discover, 02 role+views, 02p password, 03 drop) on the fixture,
# then discover -> export -> validate-mapping -> import (dry, --limit, --resume) ->
# rewrite-links -> timestamps-fix -> redirects -> verify, then a second (delta) run
# with a NEW run id. Every URL is 127.0.0.1; the tools re-check with their guards.
set -euo pipefail
cd "$(dirname "$0")/../../../../.."
ROOT=$(pwd)
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
DIR=${REHEARSE_DIR:-$(mktemp -d /tmp/aer-rehearse-XXXXXX)}
mkdir -p "$DIR"; chmod 755 "$DIR"; chown postgres "$DIR" 2>/dev/null || true
FX=scripts/migrate/network/fixtures/aer-legacy
SQL=scripts/migrate/network/sql
OUT="$ROOT/scripts/migrate/out/rehearse-network-aer"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  for d in central legacy; do [ -d "$DIR/$d" ] && runuser -u postgres -- "$PGBIN/pg_ctl" -D "$DIR/$d" -m immediate stop >/dev/null 2>&1 || true; done
  rm -rf "$DIR/central" "$DIR/legacy"
}
trap cleanup EXIT
step() { echo; echo "=== [rehearse-aer] $*"; }
fail() { echo "[rehearse-aer] FAIL: $*" >&2; exit 1; }

step "1 databases"
for spec in central:55426 legacy:55427; do
  d=${spec%%:*}; port=${spec##*:}
  rm -rf "$DIR/$d"
  runuser -u postgres -- "$PGBIN/initdb" -D "$DIR/$d" -U postgres --auth=trust >/dev/null
  runuser -u postgres -- "$PGBIN/pg_ctl" -D "$DIR/$d" -o "-p $port -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/$d.log" start >/dev/null
done
psql -h 127.0.0.1 -p 55426 -U postgres -d postgres -qc "ALTER USER postgres PASSWORD 'password'" -c "CREATE DATABASE aer_rehearsal" >/dev/null
psql -h 127.0.0.1 -p 55427 -U postgres -d postgres -qc "ALTER USER postgres PASSWORD 'password'" >/dev/null
LEG_ADMIN=postgres://postgres:password@127.0.0.1:55427/postgres
LPSQL=(psql "$LEG_ADMIN" -X -q -t -A -v ON_ERROR_STOP=1)

export AER_FIXTURE_ADMIN_URL=$LEG_ADMIN AER_FIXTURE_IMAGES_DIR="$DIR/images"
step "2 legacy fixture"
node --import tsx $FX/seed-aer-fixture.ts

step "3 owner SQL 01 (discover, single result)"
"${LPSQL[@]}" -f $SQL/01-discover-aer.sql > "$DIR/01.out"
grep -q '^1 site match|rows matching asiaeconomicreview|1$' "$DIR/01.out" || { cat "$DIR/01.out"; fail "01 did not find exactly one site"; }
grep '^1 site match|' "$DIR/01.out"; grep '^2 articles by status|TOTAL' "$DIR/01.out"; grep '^4 dates|created_at with non-zero' "$DIR/01.out"
[ "$(grep -c . "$DIR/01.out")" = "$(sed -n 's/^99 total rows|[^|]*|//p' "$DIR/01.out")" ] || fail "01 row count mismatch"

step "4 owner SQL 02 (role + views) and 02p (password)"
[ "$("${LPSQL[@]}" -f $SQL/02-create-readonly-role-views.sql | tail -1)" = "SELF-CHECK OK|72" ] || fail "02 self-check"
"${LPSQL[@]}" -f $SQL/02-create-readonly-role-views.sql >/dev/null 2>&1 && fail "02 must refuse a second run"
PW=$("${LPSQL[@]}" -f $SQL/02p-set-password.sql | tail -1 | cut -d'|' -f1)
[[ "$PW" =~ ^[0-9a-f]{48}$ ]] || fail "02p password shape"
export LEGACY_DB_URL="postgres://aer_migrator:$PW@127.0.0.1:55427/postgres" LEGACY_DB_SSL=disable
psql "$LEGACY_DB_URL" -X -q -t -A -c "SELECT count(*) FROM public.articles" >/dev/null 2>&1 && fail "aer_migrator must not read public.articles"
psql "$LEGACY_DB_URL" -X -q -t -A -c "SELECT count(*) FROM secret_table_a" >/dev/null 2>&1 && fail "aer_migrator must not read the decoy table"
[ "$(psql "$LEGACY_DB_URL" -X -q -t -A -c 'SELECT count(*) FROM aer_ro.articles')" = 72 ] || fail "aer_ro.articles count"
echo "role fence OK (public.* and decoy refused; aer_ro.articles = 72)"

step "5 image server + Central schema + aer tenant fixture"
GTP_FIXTURE_IMAGES_DIR="$DIR/images" GTP_FIXTURE_IMAGES_PORT=55428 node --import tsx scripts/migrate/fixtures/gtp-legacy/serve-fixture-images.ts >"$DIR/images.log" 2>&1 &
PIDS+=($!)
export DATABASE_URL=postgresql://postgres:password@127.0.0.1:55426/aer_rehearsal DATABASE_DIRECT_URL=postgresql://postgres:password@127.0.0.1:55426/aer_rehearsal
export PAYLOAD_SECRET=rehearsal-only-payload-secret-0000000000000000 CENTRAL_SIGNING_SECRET=rehearsal-only-signing-secret-000000000000000
export SEED_ADMIN_EMAIL=admin@example.invalid SEED_ADMIN_PASSWORD=rehearsal-only-password SEED_ENGINE_TOKEN=rehearsal-engine-token
export MIGRATE_LOAD_TIMEOUT_MS=${MIGRATE_LOAD_TIMEOUT_MS:-90000} NEXT_TELEMETRY_DISABLED=1
for i in 1 2 3 4; do
  PAYLOAD_DB_PUSH=true timeout 300 node --import tsx scripts/seed.ts >"$DIR/seed.log" 2>&1 || true
  grep -q "created tenant\|exists (id" "$DIR/seed.log" && break
  echo "seed attempt $i stalled; retrying"
done
grep -q "created tenant\|exists (id" "$DIR/seed.log" || { tail -20 "$DIR/seed.log"; fail "seed"; }
export PAYLOAD_DB_PUSH=false
for i in 1 2 3; do node --import tsx $FX/central-setup.ts setup >"$DIR/setup.log" 2>&1 && grep -q '^RESULT' "$DIR/setup.log" && break; done
grep '^RESULT' "$DIR/setup.log" || { tail "$DIR/setup.log"; fail "central setup"; }

rm -rf "$OUT"
N=(npm run -s migrate:network --)
COMMON=(--tenant aer --site 00000000-0000-0000-0000-0000000ae001)
OV=(--mapping-overlay $FX/overlay.fixture.json --out "$OUT")
MAPF=(--mapping $FX/aer.mapping.fixture.json)

step "6 validate-mapping (committed mapping: OK with PROVISIONAL list; --require-final must refuse)"
"${N[@]}" validate-mapping --tenant aer --structural-only | head -3
if "${N[@]}" validate-mapping --tenant aer --structural-only --require-final >/dev/null 2>&1; then fail "--require-final must refuse the provisional AER mapping"; fi
echo "--require-final refused (expected)"
"${N[@]}" validate-mapping --tenant aer "${MAPF[@]}" --mapping-overlay $FX/overlay.fixture.json --require-final

step "7 discover + export (read-only, by site id; legacy slug is not 'aer')"
"${N[@]}" discover "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}" | tail -2
"${N[@]}" export "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}"
"${N[@]}" discover --tenant aer --site aer "${MAPF[@]}" "${OV[@]}" >/dev/null 2>&1 && fail "a wrong legacy slug must be refused"
echo "wrong legacy slug refused (expected)"

step "8 import: dry run, then --apply --limit 20, then --resume (create-only)"
"${N[@]}" import "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}" --rehearsal --run-id aer-dry-1 | grep -E 'rows considered|imported by|body images|authors \(plan'
"${N[@]}" import "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}" --rehearsal --apply --limit 20 --run-id aer-real-1 | grep -E 'rows considered|stop:'
"${N[@]}" import "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}" --rehearsal --apply --resume --run-id aer-real-1 | tee "$DIR/import1.md" | grep -E 'rows considered|heroMissing|body images|tags created|failed:|stop:'

step "9 rewrite-links, timestamps-fix (owner psql, direct URL), redirects, verify"
"${N[@]}" rewrite-links --tenant aer --run-id aer-real-1 --apply --out "$OUT" --rehearsal | tail -2
"${N[@]}" timestamps-fix --tenant aer --run-id aer-real-1 --out "$OUT"
psql "$DATABASE_DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -f "$OUT/aer-real-1/timestamps-fix.sql"
"${N[@]}" redirects --tenant aer --run-id aer-real-1 --known-routes $FX/known-routes.json "${MAPF[@]}" "${OV[@]}" --rehearsal | tail -3
"${N[@]}" verify "${COMMON[@]}" --run-id aer-real-1 "${MAPF[@]}" "${OV[@]}" --rehearsal --batch 7 | tee "$DIR/verify1.log" | grep -E '^\[verify\]'
grep -q '^\[verify\] PASS' "$DIR/verify1.log" || fail "verify aer-real-1"

step "10 second run (delta): 5 new legacy rows, NEW run id, create-only"
node --import tsx $FX/seed-aer-fixture.ts --delta 5
"${N[@]}" import "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}" --rehearsal --run-id aer-dry-2 | tee "$DIR/dry2.md" | grep -E 'rows considered'
grep -q 'planned for create: 5;' "$DIR/dry2.md" || fail "delta dry run must plan exactly 5 new rows"
"${N[@]}" import "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}" --rehearsal --apply --run-id aer-real-2 | grep -E 'rows considered|failed:'
"${N[@]}" verify "${COMMON[@]}" --run-id aer-real-2 "${MAPF[@]}" "${OV[@]}" --rehearsal | tee "$DIR/verify2.log" | grep -E '^\[verify\] (PASS|FAIL)'

step "11 Central counts + owner SQL 03 (drop)"
node --import tsx $FX/central-setup.ts counts | grep '^RESULT'
[ "$("${LPSQL[@]}" -f $SQL/03-drop-role-and-views.sql | tail -1)" = "CLEANUP OK" ] || fail "03 cleanup"
echo "03: CLEANUP OK"
echo; echo "[rehearse-aer] ALL STEPS PASSED"
