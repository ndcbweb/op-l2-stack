#!/bin/bash
# (Re)creates the bridge site, status API and relayer container from l2.env. Only the keys the app needs are passed in.
set -euo pipefail

ENV_FILE=${ENV_FILE:-/opt/nadcab/l2/l2.env}
set -a
. "$ENV_FILE"
set +a

DATA=${DATA_DIR:-/var/lib/nadcab-l2}
APP_DIR=${APP_DIR:-/opt/nadcab/l2}
[ -f "$APP_DIR/app/run.sh" ] || exit 0
install -d -m 0755 "$DATA/status" "$DATA/node" "$DATA/app"

umask 077
{
  for key in L1_RPC_URL L1_PUBLIC_RPC_URL L1_CHAIN_ID L1_NAME L1_EXPLORER_URL NATIVE_SYMBOL NATIVE_NAME \
    L2_CHAIN_ID CHAIN_NAME L2_PUBLIC_RPC_URL L2_EXPLORER_URL L2_BLOCK_TIME PROPOSAL_INTERVAL RELAYER_KEY; do
    printf '%s=%s\n' "$key" "${!key:-}"
  done
  echo "PORT=${PORT:-80}"
} > "$APP_DIR/app.env"
umask 022

docker rm -f nadcab-l2-app >/dev/null 2>&1 || true
docker run -d --name nadcab-l2-app --restart unless-stopped --network host --memory 400m \
  --log-opt max-size=20m --log-opt max-file=3 --env-file "$APP_DIR/app.env" \
  -v "$APP_DIR/app:/app:ro" -v "$DATA/status:/l2/status:ro" -v "$DATA/node:/l2/node:ro" -v "$DATA/app:/data" \
  node:22-alpine sh /app/run.sh >/dev/null
