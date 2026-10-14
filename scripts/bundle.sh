#!/usr/bin/env bash
# Builds dist/l2.tar.gz: host scripts plus the bridge app. L2 hosts unpack it into /opt/nadcab/l2.
set -euo pipefail
cd "$(dirname "$0")/.."

(cd app/web && npm ci && npm run build)
(cd app/server && npm ci --omit=dev)

rm -rf dist
mkdir -p dist/l2/app
cp -R host dist/l2/host
cp -R app/server dist/l2/app/server
rm -rf dist/l2/app/server/.data
cp -R app/web/dist dist/l2/app/web
cp app/run.sh dist/l2/app/run.sh
chmod +x dist/l2/host/*.sh dist/l2/app/run.sh
tar -czf dist/l2.tar.gz -C dist/l2 .
echo "Built $(pwd)/dist/l2.tar.gz"
