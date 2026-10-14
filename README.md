# Nadcab OP Stack L2

Everything an L2 host needs to deploy an OP Stack rollup onto a parent chain and run it:

- `host/l2-up.sh` waits for the setup funds, deploys the rollup contracts with `op-deployer`, writes the genesis and
  rollup config, funds the batcher, proposer and relayer, refunds the rest to the owner, and runs
  `op-reth`, `op-node` (sequencer), `op-batcher` and `op-proposer` in Docker. Every stage is resumable.
- `host/intent.py` fills the op-deployer intent so that every admin role, the fee vaults and the challenger belong to
  the owner's wallet.
- `host/install.sh` registers `nadcab-l2.service`, which runs `l2-up.sh` and resumes it after reboots.
- `app/` is the bridge site, status API and withdrawal relayer served on port 80.

## Host layout

| Path | Contents |
| --- | --- |
| `/opt/nadcab/l2/l2.env` | Chain settings and operator keys (mode 600) |
| `/opt/nadcab/l2/{host,app}` | This bundle |
| `/var/lib/nadcab-l2/status/status.json` | Current bring-up stage |
| `/var/lib/nadcab-l2/deployer` | op-deployer intent and state |
| `/var/lib/nadcab-l2/node` | genesis, rollup config, L1 addresses, JWT |

## l2.env

| Key | Meaning |
| --- | --- |
| `L1_RPC_URL`, `L1_CHAIN_ID` | Parent chain the rollup settles on |
| `L1_BEACON_URL` | Optional beacon API; when set the batcher posts blobs, otherwise calldata |
| `L1_PUBLIC_RPC_URL`, `L1_NAME`, `L1_EXPLORER_URL`, `NATIVE_SYMBOL`, `NATIVE_NAME` | Shown on the bridge site |
| `L2_CHAIN_ID`, `CHAIN_NAME`, `L2_BLOCK_TIME`, `L2_GAS_LIMIT` | The rollup |
| `L2_PUBLIC_RPC_URL`, `L2_EXPLORER_URL` | Shown on the bridge site |
| `OWNER_ADDRESS` | Owner of every admin role, fee vault and the refund |
| `DEPLOYER_KEY`, `BATCHER_KEY`, `PROPOSER_KEY`, `SEQUENCER_KEY`, `RELAYER_KEY` | Host keys (relayer is optional) |
| `DEPLOYER_MIN_WEI` | Balance the deployer waits for before deploying |
| `BATCHER_FUND_WEI`, `PROPOSER_FUND_WEI`, `RELAYER_FUND_WEI` | Operator gas budgets paid from the deployer |
| `PROOF_MATURITY_DELAY`, `DISPUTE_FINALITY_DELAY`, `GAME_MAX_CLOCK` | Withdrawal delays in seconds |
| `PROPOSAL_INTERVAL` | How often the proposer posts a state root (`1h`, `30m`) |

## API

- `GET /api/health`: bring-up stage, sync status and relayer state
- `GET /api/status`: addresses, operator balances, contracts, latest proposal, withdrawal counts
- `GET /api/config`: what the bridge site needs
- `GET /api/withdrawals?address=0x…`, `GET /api/withdrawals/:hash/prove`
- `POST /rpc`: public L2 JSON-RPC (eth, net and web3 namespaces)
