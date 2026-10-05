#!/usr/bin/env bash
# Backs up Rivo: the database (pg_dump, compressed) and the uploaded profile
# pictures, into backups/ (or BACKUP_DIR). Each dump is read back once to be
# sure it is usable; backups older than BACKUP_KEEP_DAYS (14) are removed.
#
#   bash scripts/backup-db.sh          (or: npm run db:backup)
#   BACKUP_DIR=/var/backups/rivo BACKUP_KEEP_DAYS=30 bash scripts/backup-db.sh
#
# Every night at 03:30 (crontab -e):
#   30 3 * * * cd /path/to/Rivo && bash scripts/backup-db.sh >> backups/backup.log 2>&1
#
# Needs pg_dump and pg_restore of the same major version as the server
# (Ubuntu/Debian: apt install postgresql-client-16).
#
# The messages in a dump are encrypted with the keys in .env (KEK_V1 …):
# without them a dump cannot be read. Keep a copy of .env somewhere safe,
# apart from the dumps.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077 # the dumps hold user data: readable by this user only

# a setting from the environment, else from .env
setting() {
	node --input-type=module -e 'const n = process.argv[1]; if (!process.env[n]) { try { (await import("dotenv")).config(); } catch {} } console.log(process.env[n] ?? "");' "$1"
}
DIR="${BACKUP_DIR:-$(setting BACKUP_DIR)}"
DIR="${DIR:-backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-$(setting BACKUP_KEEP_DAYS)}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$DIR"

URL="$(node scripts/db-url.mjs DATABASE_URL)"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$DIR/rivo-$STAMP.dump"

pg_dump --format=custom --compress=6 --no-owner --no-acl --file="$FILE.part" "$URL"
# a damaged file is noticed now, not on the day it is needed
pg_restore --list "$FILE.part" > /dev/null
mv "$FILE.part" "$FILE"

AVATARS="public/assets/images/user-profiles"
if [ -d "$AVATARS" ] && [ -n "$(find "$AVATARS" -type f ! -name '.gitkeep' -print -quit 2>/dev/null)" ]; then
	tar -czf "$DIR/rivo-$STAMP-avatars.tar.gz" -C "$(dirname "$AVATARS")" "$(basename "$AVATARS")"
fi

find "$DIR" -maxdepth 1 -type f -name 'rivo-*' -mtime +"$KEEP_DAYS" -delete

echo "$(date '+%Y-%m-%d %H:%M:%S') backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
