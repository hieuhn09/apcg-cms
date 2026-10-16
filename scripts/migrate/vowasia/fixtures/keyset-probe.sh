#!/usr/bin/env bash
# VowAsia phase A probe (Hybrid gate G6). LOCAL ONLY, disposable, runs ALONE.
#
#   npm run probe:migrate-vowasia      (= bash scripts/migrate/vowasia/fixtures/keyset-probe.sh)
#
# Starts a throwaway native PostgreSQL 16 on 127.0.0.1:${VOWASIA_PROBE_PORT:-54336}
# (port range 54331-54339; the GTP rehearsal uses 54326-54328), in a fresh
# `mktemp -d` directory, as the `postgres` OS user via runuser. Then
# keyset-probe.ts: keyset reads (uuid and integer site ids), the owner SQL
# (02 apply + role checks + 03 removal, 02b syntax), and discover through the
# read-only role. The EXIT trap stops ONLY the server this script started and
# deletes the temp directory, also on failure. It never connects anywhere else:
# never a legacy or Central database. Do not run it next to `npm ci` or a rehearsal.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
PORT=${VOWASIA_PROBE_PORT:-54336}
case "$PORT" in 5433[1-9]) ;; *) echo "[probe] port must be in 54331-54339; refusing." >&2; exit 2 ;; esac
PGBIN=/usr/lib/postgresql/16/bin
if [ ! -x "$PGBIN/initdb" ] || ! command -v runuser >/dev/null || ! command -v psql >/dev/null || ! id postgres >/dev/null 2>&1; then
  echo "[probe] UNPROVEN: needs native PostgreSQL 16 in $PGBIN, psql, runuser and a postgres OS user." >&2
  exit 3
fi
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "[probe] port $PORT is already in use; refusing (another probe or server?)." >&2
  exit 2
fi
DIR=$(mktemp -d /tmp/vowasia-probe-XXXXXX)
STARTED=0
cleanup() {
  if [ "$STARTED" = 1 ]; then runuser -u postgres -- "$PGBIN/pg_ctl" -D "$DIR/pg" -m immediate -w stop >/dev/null 2>&1 || true; fi
  rm -rf "$DIR"
  echo "[probe] cleanup done (server stopped, temp dir removed)"
}
trap cleanup EXIT INT TERM
chmod 755 "$DIR"
chown postgres "$DIR"
runuser -u postgres -- "$PGBIN/initdb" -D "$DIR/pg" -U postgres --auth=trust >/dev/null
runuser -u postgres -- "$PGBIN/pg_ctl" -D "$DIR/pg" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/pg.log" -w start >/dev/null
STARTED=1
VOWASIA_PROBE_PORT=$PORT VOWASIA_PROBE_DIR=$DIR node --import tsx scripts/migrate/vowasia/fixtures/keyset-probe.ts
