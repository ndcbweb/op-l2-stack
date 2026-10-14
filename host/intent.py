#!/usr/bin/env python3
"""Fills the op-deployer intent written by `op-deployer init --intent-type custom` from l2.env.

Every admin role, the superchain roles and the fee vaults belong to OWNER_ADDRESS (the customer's wallet);
only the batcher, proposer and sequencer are host keys.
"""
import os
import re
import sys

path = sys.argv[1]
env = os.environ
owner = env["OWNER_ADDRESS"]
text = open(path).read()


def set_value(key, value, count=1):
    global text
    pattern = re.compile(rf"^(\s*{re.escape(key)}\s*=\s*).*$", re.M)
    text, n = pattern.subn(lambda m: m.group(1) + value, text, count=count)
    if n == 0:
        raise SystemExit(f"intent.toml has no {key}")


def quoted(value):
    return f'"{value}"'


for key in ("SuperchainProxyAdminOwner", "SuperchainGuardian", "Challenger"):
    set_value(key, quoted(owner))
for key in (
    "baseFeeVaultRecipient",
    "l1FeeVaultRecipient",
    "sequencerFeeVaultRecipient",
    "operatorFeeVaultRecipient",
    "l1ProxyAdminOwner",
    "l2ProxyAdminOwner",
    "systemConfigOwner",
    "challenger",
):
    set_value(key, quoted(owner))
set_value("unsafeBlockSigner", quoted(env["SEQUENCER_ADDRESS"]))
set_value("batcher", quoted(env["BATCHER_ADDRESS"]))
set_value("proposer", quoted(env["PROPOSER_ADDRESS"]))
set_value("eip1559DenominatorCanyon", "250")
set_value("eip1559Denominator", "50")
set_value("eip1559Elasticity", "6")
set_value("gasLimit", str(int(env.get("L2_GAS_LIMIT", "60000000"))))

# A zero liquidity controller means "no custom gas token"; the table must go entirely.
text = re.sub(r"\n\s*\[chains\.customGasToken\]\n\s*liquidityControllerOwner = \"0x0+\"\n", "\n", text)

maturity = int(env.get("PROOF_MATURITY_DELAY", "604800"))
finality = int(env.get("DISPUTE_FINALITY_DELAY", "302400"))
clock = int(env.get("GAME_MAX_CLOCK", "302400"))
block_time = int(env.get("L2_BLOCK_TIME", "2"))

if "[globalDeployOverrides]" not in text:
    text = text.replace(
        "useInterop = false\n",
        "useInterop = false\n\n[globalDeployOverrides]\n"
        f"  proofMaturityDelaySeconds = {maturity}\n"
        f"  disputeGameFinalityDelaySeconds = {finality}\n",
        1,
    )

chain_extra = (
    f"  faultGameMaxClockDuration = {clock}\n"
    f"  faultGameClockExtension = {max(1, min(10800, clock // 4))}\n"
    "  dangerouslyAllowCustomDisputeParameters = true\n"
)
if "faultGameMaxClockDuration" not in text:
    text = re.sub(r"(\n\s*gasLimit = \d+\n)", lambda m: m.group(1) + chain_extra, text, count=1)
if "[chains.deployOverrides]" not in text:
    text = text.replace("  [chains.roles]", f"  [chains.deployOverrides]\n    l2BlockTime = {block_time}\n  [chains.roles]", 1)

open(path, "w").write(text)
print(f"intent ready: owner {owner}, block time {block_time}s, withdrawal delay {maturity}s")
