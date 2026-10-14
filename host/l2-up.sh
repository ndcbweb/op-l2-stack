#!/bin/bash
# Deploys an OP Stack L2 onto its parent chain from l2.env and runs the sequencer stack on this host.
# Safe to rerun: every stage leaves a marker and is skipped once done, and op-deployer resumes from state.json.
set -euo pipefail

ENV_FILE=${ENV_FILE:-/opt/nadcab/l2/l2.env}
set -a
. "$ENV_FILE"
set +a

DATA=${DATA_DIR:-/var/lib/nadcab-l2}
APP_DIR=${APP_DIR:-/opt/nadcab/l2}
REGISTRY=us-docker.pkg.dev/oplabs-tools-artifacts/images
DEPLOYER_IMG=$REGISTRY/op-deployer:v0.8.1
RETH_IMG=$REGISTRY/op-reth:v2.6.0
NODE_IMG=$REGISTRY/op-node:v1.19.9
BATCHER_IMG=$REGISTRY/op-batcher:v1.17.2
PROPOSER_IMG=$REGISTRY/op-proposer:v1.16.6
FOUNDRY_IMG=ghcr.io/foundry-rs/foundry:stable
APP_IMG=node:22-alpine
# op-service bids at least 1 gwei tip by default, which is far above market on most parent chains.
MIN_TIP_GWEI=${MIN_TIP_GWEI:-0.01}

install -d -m 0755 "$DATA/deployer" "$DATA/reth" "$DATA/node" "$DATA/status" "$DATA/app"

# status <stage> <detail> [wei still needed]
status() {
  python3 - "$DATA/status/status.json" "$1" "$2" "${3:-}" <<'PY'
import json, os, sys, time
path, stage, detail, need = sys.argv[1:5]
body = {"stage": stage, "detail": detail, "at": int(time.time())}
if need:
    body["needWei"] = need
open(path + ".tmp", "w").write(json.dumps(body))
os.replace(path + ".tmp", path)
PY
  echo "[nadcab-l2] $1: $2"
}
fail() {
  status failed "$1"
  exit 1
}
trap 'fail "step failed on line $LINENO"' ERR

cast() { docker run --rm --network host --entrypoint cast "$FOUNDRY_IMG" "$@"; }
deployer() { docker run --rm --network host -v "$DATA/deployer:/work" "$DEPLOYER_IMG" op-deployer "$@"; }
wei_gte() { python3 -c "import sys; sys.exit(0 if int('$1') >= int('$2') else 1)"; }

run() {
  local name=$1
  shift
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --restart unless-stopped --network host --log-opt max-size=20m --log-opt max-file=3 "$@" >/dev/null
}

for image in "$APP_IMG" "$FOUNDRY_IMG" "$DEPLOYER_IMG" "$RETH_IMG" "$NODE_IMG" "$BATCHER_IMG" "$PROPOSER_IMG"; do
  for attempt in 1 2 3 4 5; do
    docker image inspect "$image" >/dev/null 2>&1 && break
    status pulling "$image"
    docker pull -q "$image" >/dev/null && break
    sleep 10
  done
done

DEPLOYER_ADDRESS=$(cast wallet address --private-key "$DEPLOYER_KEY")
BATCHER_ADDRESS=$(cast wallet address --private-key "$BATCHER_KEY")
PROPOSER_ADDRESS=$(cast wallet address --private-key "$PROPOSER_KEY")
SEQUENCER_ADDRESS=$(cast wallet address --private-key "$SEQUENCER_KEY")
RELAYER_ADDRESS=""
[ -n "${RELAYER_KEY:-}" ] && RELAYER_ADDRESS=$(cast wallet address --private-key "$RELAYER_KEY")
export DEPLOYER_ADDRESS BATCHER_ADDRESS PROPOSER_ADDRESS SEQUENCER_ADDRESS RELAYER_ADDRESS
python3 -c "import json, os; print(json.dumps({k.split('_')[0].lower(): os.environ[k] for k in ('OWNER_ADDRESS', 'DEPLOYER_ADDRESS', 'BATCHER_ADDRESS', 'PROPOSER_ADDRESS', 'SEQUENCER_ADDRESS', 'RELAYER_ADDRESS')}))" > "$DATA/status/addresses.json"

# ---------- 0. bridge site, status API and withdrawal relayer (answers on port 80 from the start) ----------
bash "$APP_DIR/host/app-up.sh"

# ---------- 1. wait for the owner's funding to land on the one-time deployer ----------
if [ ! -f "$DATA/deployer/.applied" ]; then
  while :; do
    balance=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$L1_RPC_URL" 2>/dev/null || echo 0)
    wei_gte "$balance" "$DEPLOYER_MIN_WEI" && break
    status waiting-funds "Send the setup funds to $DEPLOYER_ADDRESS" "$(python3 -c "print(int('$DEPLOYER_MIN_WEI') - int('$balance'))")"
    sleep 15
  done
fi

# ---------- 2. deploy the L1 contracts ----------
if [ ! -f "$DATA/deployer/.applied" ]; then
  if [ ! -f "$DATA/deployer/intent.toml" ]; then
    deployer init --l1-chain-id "$L1_CHAIN_ID" --l2-chain-ids "$L2_CHAIN_ID" --workdir /work --intent-type custom
    python3 "$APP_DIR/host/intent.py" "$DATA/deployer/intent.toml"
  fi
  for attempt in 1 2 3; do
    status deploying-l1 "Deploying the rollup contracts on the parent chain (attempt $attempt of 3)"
    if deployer apply --workdir /work --l1-rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_KEY" --no-verify; then
      touch "$DATA/deployer/.applied"
      break
    fi
    sleep 30
  done
  [ -f "$DATA/deployer/.applied" ] || fail "The rollup contract deployment failed, see the host log"
fi

# ---------- 3. genesis and rollup config ----------
if [ ! -f "$DATA/node/rollup.json" ]; then
  status genesis "Writing the L2 genesis and rollup config"
  deployer inspect genesis --workdir /work "$L2_CHAIN_ID" > "$DATA/node/genesis.json"
  deployer inspect l1 --workdir /work "$L2_CHAIN_ID" > "$DATA/node/l1-addresses.json"
  deployer inspect rollup --workdir /work "$L2_CHAIN_ID" > "$DATA/node/rollup.json.tmp"
  mv "$DATA/node/rollup.json.tmp" "$DATA/node/rollup.json"
fi
[ -f "$DATA/node/jwt.txt" ] || openssl rand -hex 32 > "$DATA/node/jwt.txt"

# ---------- 4. fund the batcher, proposer and relayer, refund the rest to the owner ----------
if [ ! -f "$DATA/deployer/.funded" ]; then
  budgets=("$BATCHER_ADDRESS:${BATCHER_FUND_WEI:-0}" "$PROPOSER_ADDRESS:${PROPOSER_FUND_WEI:-0}")
  [ -n "$RELAYER_ADDRESS" ] && budgets+=("$RELAYER_ADDRESS:${RELAYER_FUND_WEI:-0}")
  while :; do
    balance=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$L1_RPC_URL" 2>/dev/null || echo 0)
    gas_price=$(cast gas-price --rpc-url "$L1_RPC_URL" 2>/dev/null || echo 0)
    owed=0
    for pair in "${budgets[@]}"; do
      have=$(cast balance "${pair%%:*}" --rpc-url "$L1_RPC_URL" 2>/dev/null || echo 0)
      owed=$(python3 -c "print(int('$owed') + max(0, int('${pair##*:}') - int('$have')))")
    done
    shortfall=$(python3 -c "print(max(0, int('$owed') + int('$gas_price') * 2 * 21000 * 5 - int('$balance')))")
    [ "$shortfall" = "0" ] && break
    status waiting-topup "Contracts are deployed; send a little more to $DEPLOYER_ADDRESS for operator gas" "$shortfall"
    sleep 15
  done
  status funding "Funding the batcher, proposer and relayer"
  for pair in "${budgets[@]}"; do
    to=${pair%%:*}
    have=$(cast balance "$to" --rpc-url "$L1_RPC_URL")
    need=$(python3 -c "print(max(0, int('${pair##*:}') - int('$have')))")
    [ "$need" != "0" ] && cast send --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_KEY" "$to" --value "$need" >/dev/null
  done
  balance=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$L1_RPC_URL")
  gas_price=$(cast gas-price --rpc-url "$L1_RPC_URL")
  refund=$(python3 -c "print(max(0, int('$balance') - int('$gas_price') * 2 * 21000 * 2))")
  if [ "$refund" != "0" ]; then
    cast send --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_KEY" "$OWNER_ADDRESS" --value "$refund" --gas-limit 21000 --gas-price "$((gas_price * 2))" >/dev/null || true
  fi
  touch "$DATA/deployer/.funded"
fi

# ---------- 5. parent-chain spec for op-node (built in for Ethereum networks only) ----------
NODE_L1_CONFIG=()
case "$L1_CHAIN_ID" in
  1 | 11155111 | 17000 | 560048) ;;
  *)
    cat > "$DATA/node/l1-chain-config.json" <<JSON
{"chainId":$L1_CHAIN_ID,"homesteadBlock":0,"eip150Block":0,"eip155Block":0,"eip158Block":0,"byzantiumBlock":0,"constantinopleBlock":0,"petersburgBlock":0,"istanbulBlock":0,"berlinBlock":0,"londonBlock":0,"mergeNetsplitBlock":0,"terminalTotalDifficulty":0,"shanghaiTime":0,"cancunTime":0,"pragueTime":0,"blobSchedule":{"cancun":{"target":3,"max":6,"baseFeeUpdateFraction":3338477},"prague":{"target":6,"max":9,"baseFeeUpdateFraction":5007716}}}
JSON
    NODE_L1_CONFIG=(--rollup.l1-chain-config /node/l1-chain-config.json)
    ;;
esac
if [ -n "${L1_BEACON_URL:-}" ]; then
  NODE_BEACON=(--l1.beacon "$L1_BEACON_URL")
  DA_TYPE=blobs
else
  NODE_BEACON=(--l1.beacon.ignore)
  DA_TYPE=calldata
fi

# ---------- 6. execution client ----------
if [ ! -d "$DATA/reth/db" ]; then
  status starting "Initialising the L2 execution client from genesis"
  docker run --rm -v "$DATA/reth:/data" -v "$DATA/node:/node:ro" "$RETH_IMG" init --chain /node/genesis.json --datadir /data
fi

status starting "Starting op-reth, op-node, op-batcher and op-proposer"
run nadcab-l2-reth -v "$DATA/reth:/data" -v "$DATA/node:/node:ro" "$RETH_IMG" node \
  --chain /node/genesis.json --datadir /data \
  --http --http.addr 0.0.0.0 --http.port 8545 --http.api eth,net,web3,txpool --http.corsdomain '*' \
  --ws --ws.addr 0.0.0.0 --ws.port 8546 --ws.api eth,net,web3 --ws.origins '*' \
  --authrpc.addr 127.0.0.1 --authrpc.port 8551 --authrpc.jwtsecret /node/jwt.txt \
  --rpc.eth-proof-window 1209600 --rollup.disable-tx-pool-gossip \
  --disable-discv4-discovery --disable-discv5-discovery --disable-dns-discovery --port 30303

DGF=$(python3 -c "import json; print(json.load(open('$DATA/node/l1-addresses.json'))['DisputeGameFactoryProxy'])")

run nadcab-l2-node -v "$DATA/node:/node" "$NODE_IMG" op-node \
  --l1 "$L1_RPC_URL" --l1.rpckind "${L1_RPC_KIND:-basic}" "${NODE_BEACON[@]}" \
  --l2 http://127.0.0.1:8551 --l2.jwt-secret /node/jwt.txt \
  --rollup.config /node/rollup.json "${NODE_L1_CONFIG[@]}" \
  --sequencer.enabled --sequencer.l1-confs "${L1_CONFS:-4}" --verifier.l1-confs "${L1_CONFS:-4}" \
  --p2p.disable --rpc.addr 127.0.0.1 --rpc.port 9545 --rpc.enable-admin --safedb.path /node/safedb

run nadcab-l2-batcher "$BATCHER_IMG" op-batcher \
  --l1-eth-rpc "$L1_RPC_URL" --l2-eth-rpc http://127.0.0.1:8545 --rollup-rpc http://127.0.0.1:9545 \
  --private-key "$BATCHER_KEY" --data-availability-type "$DA_TYPE" \
  --max-channel-duration "${BATCH_MAX_CHANNEL_DURATION:-25}" --sub-safety-margin 6 \
  --num-confirmations 1 --poll-interval 2s --resubmission-timeout 60s --safe-abort-nonce-too-low-count 3 \
  --throttle.unsafe-da-bytes-lower-threshold 0 --rpc.addr 127.0.0.1 --rpc.port 9548 --wait-node-sync \
  --txmgr.min-tip-cap "$MIN_TIP_GWEI" --txmgr.min-basefee "$MIN_TIP_GWEI"

PROPOSER_EXTRA=()
[ "${ALLOW_NON_FINALIZED:-0}" = "1" ] && PROPOSER_EXTRA=(--allow-non-finalized)
run nadcab-l2-proposer "$PROPOSER_IMG" op-proposer \
  --l1-eth-rpc "$L1_RPC_URL" --superroot-rpcs http://127.0.0.1:9545 \
  --game-factory-address "$DGF" --game-type 5 --proposal-interval "${PROPOSAL_INTERVAL:-1h}" \
  --private-key "$PROPOSER_KEY" --rpc.addr 127.0.0.1 --rpc.port 9549 --wait-node-sync \
  --txmgr.min-tip-cap "$MIN_TIP_GWEI" --txmgr.min-basefee "$MIN_TIP_GWEI" "${PROPOSER_EXTRA[@]}"

status live "L2 chain $L2_CHAIN_ID is running"
