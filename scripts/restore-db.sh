#!/usr/bin/env bash
# Restores a backup made by backup-db.sh.
#
# The restore drill (do it once a month): into a separate, empty database
# named by RESTORE_DATABASE_URL (in the environment or .env) — the live one
# is not touched:
#   createdb rivo_restore_test          # once
#   RESTORE_DATABASE_URL=postgresql://USER:PASS@localhost:5432/rivo_restore_test \
#     bash scripts/restore-db.sh backups/rivo-20261007-033000.dump
#
# A real recovery, into DATABASE_URL itself (everything in it is replaced;
# stop the server first, and you are asked to type the database's name):
#   bash scripts/restore-db.sh backups/rivo-20261007-033000.dump --into-live
set -euo pipefail
cd "$(dirname "$0")/.."

FILE="${1:-}"
MODE="${2:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
	echo "usage: bash scripts/restore-db.sh <backup.dump> [--into-live]" >&2
	exit 2
fi
pg_restore --list "$FILE" > /dev/null || { echo "$FILE is not a readable backup" >&2; exit 1; }

if [ "$MODE" = "--into-live" ]; then
	URL="$(node scripts/db-url.mjs DATABASE_URL)"
	DB="$(node -e 'console.log(new URL(process.argv[1]).pathname.slice(1))' "$URL")"
	echo "This replaces EVERYTHING in the database \"$DB\" with the backup $FILE."
	read -r -p "Type the database name to go on: " ANSWER
	[ "$ANSWER" = "$DB" ] || { echo "Not confirmed: nothing changed."; exit 1; }
else
	URL="$(node scripts/db-url.mjs RESTORE_DATABASE_URL)"
	LIVE="$(node scripts/db-url.mjs DATABASE_URL 2>/dev/null || true)"
	if [ -n "$LIVE" ] && [ "$URL" = "$LIVE" ]; then
		echo "RESTORE_DATABASE_URL is the live database: use --into-live for that on purpose." >&2
		exit 1
	fi
fi

pg_restore --clean --if-exists --no-owner --no-acl --single-transaction --dbname="$URL" "$FILE"

echo "restored $FILE"
if command -v psql > /dev/null; then
	psql "$URL" -Atc 'SELECT (SELECT count(*) FROM "User") || '"' users, '"' || (SELECT count(*) FROM "Message") || '"' messages, last migration: '"' || (SELECT migration_name FROM "_prisma_migrations" ORDER BY finished_at DESC NULLS LAST LIMIT 1)' 2>/dev/null || true
fi
