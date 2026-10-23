#!/usr/bin/env bash
# Scripted end-to-end rehearsal of the network-legacy tools for tenant abb. LOCAL ONLY.
#
#   npm run rehearse:network-abb
#
# Two throwaway native PG16 clusters (central 55436, legacy 55437) + a local image
# server (55438) under REHEARSE_DIR (default: a fresh mktemp dir). Exercises the REAL
# owner SQL files (01 discover, 02 role+views, 02p password, 03 drop) on the fixture,
# then discover -> export -> validate-mapping -> import (dry, --limit, --resume) ->
# rewrite-links -> timestamps-fix -> redirects -> verify, then a second (delta) run
# with a NEW run id. Every URL is 127.0.0.1; the tools re-check with their guards.
set -euo pipefail
cd "$(dirname "$0")/../../../../.."
ROOT=$(pwd)
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
DIR=${REHEARSE_DIR:-$(mktemp -d /tmp/abb-rehearse-XXXXXX)}
mkdir -p "$DIR"; chmod 755 "$DIR"; chown postgres "$DIR" 2>/dev/null || true
FX=scripts/migrate/network/fixtures/abb-legacy
SQL=scripts/migrate/network/sql
OUT="$ROOT/scripts/migrate/out/rehearse-network-abb"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  for d in central legacy; do [ -d "$DIR/$d" ] && runuser -u postgres -- "$PGBIN/pg_ctl" -D "$DIR/$d" -m immediate stop >/dev/null 2>&1 || true; done
  rm -rf "$DIR/central" "$DIR/legacy"
}
trap cleanup EXIT
step() { echo; echo "=== [rehearse-abb] $*"; }
fail() { echo "[rehearse-abb] FAIL: $*" >&2; exit 1; }

step "1 databases"
for spec in central:55436 legacy:55437; do
  d=${spec%%:*}; port=${spec##*:}
  rm -rf "$DIR/$d"
  runuser -u postgres -- "$PGBIN/initdb" -D "$DIR/$d" -U postgres --auth=trust >/dev/null
  runuser -u postgres -- "$PGBIN/pg_ctl" -D "$DIR/$d" -o "-p $port -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/$d.log" start >/dev/null
done
psql -h 127.0.0.1 -p 55436 -U postgres -d postgres -qc "ALTER USER postgres PASSWORD 'password'" -c "CREATE DATABASE abb_rehearsal" >/dev/null
psql -h 127.0.0.1 -p 55437 -U postgres -d postgres -qc "ALTER USER postgres PASSWORD 'password'" >/dev/null
LEG_ADMIN=postgres://postgres:password@127.0.0.1:55437/postgres
LPSQL=(psql "$LEG_ADMIN" -X -q -t -A -v ON_ERROR_STOP=1)

export ABB_FIXTURE_ADMIN_URL=$LEG_ADMIN ABB_FIXTURE_IMAGES_DIR="$DIR/images"
step "2 legacy fixture"
node --import tsx $FX/seed-abb-fixture.ts

step "3 owner SQL 01 (discover, single result)"
"${LPSQL[@]}" -f $SQL/01-discover-abb.sql > "$DIR/01.out"
grep -q '^1 site match|rows matching asiabeautybrief|1$' "$DIR/01.out" || { cat "$DIR/01.out"; fail "01 did not find exactly one site"; }
grep '^1 site match|' "$DIR/01.out"; grep '^2 articles by status|TOTAL' "$DIR/01.out"; grep '^4 dates|created_at with non-zero' "$DIR/01.out"
[ "$(grep -c . "$DIR/01.out")" = "$(sed -n 's/^99 total rows|[^|]*|//p' "$DIR/01.out")" ] || fail "01 row count mismatch"

step "4 owner SQL 02 (role + views) and 02p (password)"
[ "$("${LPSQL[@]}" -f $SQL/02-create-readonly-role-views-abb.sql | tail -1)" = "SELF-CHECK OK|64" ] || fail "02 self-check"
"${LPSQL[@]}" -f $SQL/02-create-readonly-role-views-abb.sql >/dev/null 2>&1 && fail "02 must refuse a second run"
PW=$("${LPSQL[@]}" -1 -f $SQL/02p-set-password-abb.sql | tail -1 | cut -d'|' -f1)
[[ "$PW" =~ ^[0-9a-f]{48}$ ]] || fail "02p password shape"
export LEGACY_DB_URL="postgres://abb_migrator:$PW@127.0.0.1:55437/postgres" LEGACY_DB_SSL=disable
psql "$LEGACY_DB_URL" -X -q -t -A -c "SELECT count(*) FROM public.articles" >/dev/null 2>&1 && fail "abb_migrator must not read public.articles"
psql "$LEGACY_DB_URL" -X -q -t -A -c "SELECT count(*) FROM secret_table_a" >/dev/null 2>&1 && fail "abb_migrator must not read the decoy table"
[ "$(psql "$LEGACY_DB_URL" -X -q -t -A -c 'SELECT count(*) FROM abb_ro.articles')" = 64 ] || fail "abb_ro.articles count"
echo "role fence OK (public.* and decoy refused; abb_ro.articles = 64)"

step "5 image server + Central schema + abb tenant fixture"
GTP_FIXTURE_IMAGES_DIR="$DIR/images" GTP_FIXTURE_IMAGES_PORT=55438 node --import tsx scripts/migrate/fixtures/gtp-legacy/serve-fixture-images.ts >"$DIR/images.log" 2>&1 &
PIDS+=($!)
export DATABASE_URL=postgresql://postgres:password@127.0.0.1:55436/abb_rehearsal DATABASE_DIRECT_URL=postgresql://postgres:password@127.0.0.1:55436/abb_rehearsal
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
COMMON=(--tenant abb --site 00000000-0000-0000-0000-0000000ab001)
OV=(--mapping-overlay $FX/overlay.fixture.json --out "$OUT")
MAPF=(--mapping $FX/abb.mapping.fixture.json)

step "6 validate-mapping (committed mapping is FINAL, owner 23-10-26: --require-final must pass)"
"${N[@]}" validate-mapping --tenant abb --structural-only | head -3
"${N[@]}" validate-mapping --tenant abb --structural-only --require-final >/dev/null || fail "--require-final must accept the FINAL ABB mapping"
echo "--require-final accepted the committed mapping (expected)"
"${N[@]}" validate-mapping --tenant abb "${MAPF[@]}" --mapping-overlay $FX/overlay.fixture.json --require-final

step "7 discover + export (read-only, by site id; legacy slug is not "abb")"
"${N[@]}" discover "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}" | tail -2
"${N[@]}" export "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}"
"${N[@]}" discover --tenant abb --site abb "${MAPF[@]}" "${OV[@]}" >/dev/null 2>&1 && fail "a wrong legacy slug must be refused"
echo "wrong legacy slug refused (expected)"
"${N[@]}" discover --tenant abb --site asiabeautybrief "${MAPF[@]}" "${OV[@]}" | tail -1
echo "real legacy slug asiabeautybrief accepted"

step "8 import: dry run, then --apply --limit 20, then --resume (create-only)"
"${N[@]}" import "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}" --rehearsal --run-id abb-dry-1 | grep -E 'rows considered|imported by|body images|authors \(plan'
"${N[@]}" import "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}" --rehearsal --apply --limit 20 --run-id abb-real-1 | grep -E 'rows considered|stop:'
"${N[@]}" import "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}" --rehearsal --apply --resume --run-id abb-real-1 | tee "$DIR/import1.md" | grep -E 'rows considered|heroMissing|body images|tags created|failed:|stop:'

step "9 rewrite-links, timestamps-fix (owner psql, direct URL), redirects, verify"
"${N[@]}" rewrite-links --tenant abb --run-id abb-real-1 --apply --out "$OUT" --rehearsal | tail -2
"${N[@]}" timestamps-fix --tenant abb --run-id abb-real-1 --out "$OUT"
psql "$DATABASE_DIRECT_URL" -X -q -v ON_ERROR_STOP=1 -f "$OUT/abb-real-1/timestamps-fix.sql"
"${N[@]}" redirects --tenant abb --run-id abb-real-1 --known-routes $FX/known-routes.json "${MAPF[@]}" "${OV[@]}" --rehearsal | tail -3
"${N[@]}" verify "${COMMON[@]}" --run-id abb-real-1 "${MAPF[@]}" "${OV[@]}" --rehearsal --batch 7 | tee "$DIR/verify1.log" | grep -E '^\[verify\]'
grep -q '^\[verify\] PASS' "$DIR/verify1.log" || fail "verify abb-real-1"

step "10 second run (delta): 5 new legacy rows, NEW run id, create-only"
node --import tsx $FX/seed-abb-fixture.ts --delta 5
"${N[@]}" import "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}" --rehearsal --run-id abb-dry-2 | tee "$DIR/dry2.md" | grep -E 'rows considered'
grep -q 'planned for create: 5;' "$DIR/dry2.md" || fail "delta dry run must plan exactly 5 new rows"
"${N[@]}" import "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}" --rehearsal --apply --run-id abb-real-2 | grep -E 'rows considered|failed:'
"${N[@]}" verify "${COMMON[@]}" --run-id abb-real-2 "${MAPF[@]}" "${OV[@]}" --rehearsal | tee "$DIR/verify2.log" | grep -E '^\[verify\] (PASS|FAIL)'

step "10b re-run (idempotency): NEW run id must plan 0 creates and create 0 duplicates"
"${N[@]}" import "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}" --rehearsal --run-id abb-dry-3 | tee "$DIR/dry3.md" | grep -E 'rows considered'
grep -q 'planned for create: 0;' "$DIR/dry3.md" || fail "a re-run must plan 0 creates"
BEFORE=$(node --import tsx $FX/central-setup.ts counts | sed -n 's/^RESULT .*"articles":\([0-9]*\).*/\1/p')
"${N[@]}" import "${COMMON[@]}" "${MAPF[@]}" "${OV[@]}" --rehearsal --apply --run-id abb-real-3 | grep -E 'rows considered|failed:'
AFTER=$(node --import tsx $FX/central-setup.ts counts | sed -n 's/^RESULT .*"articles":\([0-9]*\).*/\1/p')
[ -n "$BEFORE" ] && [ "$BEFORE" = "$AFTER" ] || fail "re-run changed the article count ($BEFORE -> $AFTER)"
DUP=$(psql "$DATABASE_DIRECT_URL" -X -q -t -A -c "SELECT count(*) FROM (SELECT l.slug FROM articles a JOIN articles_locales l ON l._parent_id = a.id GROUP BY a.tenant_id, l._locale, l.slug HAVING count(*) > 1) d")
[ "$DUP" = 0 ] || fail "duplicate slugs in Central: $DUP"
echo "re-run: articles $BEFORE -> $AFTER, duplicate slugs 0"

step "11 Central counts + owner SQL 03 (drop)"
node --import tsx $FX/central-setup.ts counts | grep '^RESULT'
[ "$("${LPSQL[@]}" -f $SQL/03-drop-role-and-views-abb.sql | tail -1)" = "CLEANUP OK" ] || fail "03 cleanup"
echo "03: CLEANUP OK"
echo; echo "[rehearse-abb] ALL STEPS PASSED"
