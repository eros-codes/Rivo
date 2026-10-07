#!/usr/bin/env bash
# Brings a running Rivo server up to what is on GitHub (docs/DEPLOY.md →
# Updating): the code, its packages, the database's migrations, the app's
# build, then a restart and a health check.
#
#   bash scripts/deploy.sh
#
# Stops at the first step that fails. Rivo keeps running meanwhile and
# restarts at the end (a page opened during the build may need a reload).
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n━━ %s\n' "$*"; }

if [ ! -f .env ]; then
	echo "No .env here: see docs/DEPLOY.md → The settings." >&2
	exit 1
fi
if [ "${NODE_ENV:-}" = "production" ]; then
	# npm would leave out the build tools (devDependencies) and the build would fail;
	# production is set where Rivo runs: in .env and in the service
	echo "NODE_ENV=production is set in this shell: unset it (unset NODE_ENV) and run again." >&2
	exit 1
fi

step "code (git pull)"
git pull --ff-only

step "packages (npm ci)"
npm ci --no-audit --no-fund

step "database migrations"
npx prisma migrate deploy

step "build"
npm run build

step "restart"
sudo systemctl restart rivo

step "health"
for _ in $(seq 1 30); do
	if curl -fsS http://127.0.0.1:3000/api/health; then
		printf '\n\nRivo is up.\n'
		exit 0
	fi
	sleep 1
done
echo "Rivo did not answer within 30 s. Its log: journalctl -u rivo -n 50" >&2
exit 1
