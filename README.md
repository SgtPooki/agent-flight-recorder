# Agent Flight Recorder

**Receipts, not self-reports.** A tamper-evident audit trail for AI agents, sealed to [Filecoin Onchain Cloud](https://filecoin.cloud).

Agents are starting to take real actions — refunds, deploys, trades, emails. When something goes wrong, the only record of what happened is usually a log file that the agent (or its operator) can quietly rewrite. The problem isn't whether an agent can summarize what it did; it's whether anyone can *independently verify* that history after incentives change.

The flight recorder turns an agent's transcript from an editable confession into durable evidence:

1. **Record** — Claude Code hooks append every prompt, tool call, and stop event to an append-only JSONL log. Each record commits to the previous record's hash, so editing, deleting, or reordering *anything* breaks every hash after it.
2. **Seal** — the log plus a manifest committing to the chain root are packed into a UnixFS CAR and uploaded to **Filecoin Warm Storage** via the [Synapse SDK](https://docs.filecoin.cloud/developer-guides/synapse/) (through [filecoin-pin](https://github.com/filecoin-project/filecoin-pin)'s core API). Storage is paid for onchain through **Filecoin Pay** — the agent funds its own storage.
3. **Prove** — daily **PDP (Proof of Data Possession)** proofs attest onchain that the sealed history still exists, bit-for-bit, on independent storage providers.
4. **Verify** — anyone can re-walk the chain, recompute every hash, and fetch the sealed original back from Filecoin. Neither the agent, its operator, nor you can rewrite it after the fact.

## Quick start

```bash
npm install
npm test

# the full demo: record → verify → tamper → get caught
./demo.sh

# with a funded Filecoin calibration wallet: also seal to FOC + remote-verify
PRIVATE_KEY=0x... ./demo.sh seal
```

## CLI

```
afr record           append a Claude Code hook payload from stdin (used by hooks)
afr note <text>      append a free-form note record
afr log              pretty-print the hash chain
afr verify           recompute every hash; compare to the seal receipt
afr verify --remote  also fetch the sealed log back from Filecoin and verify it
afr seal             upload log + manifest to Filecoin Warm Storage
afr status           wallet / Filecoin Pay readiness

env: AFR_DIR (default ./.afr), AFR_NETWORK (calibration|mainnet), PRIVATE_KEY
```

## Recording a real Claude Code session

This repo's [`.claude/settings.json`](.claude/settings.json) wires `afr record` into the `UserPromptSubmit`, `PostToolUse`, and `Stop` hooks. Open Claude Code in this directory and every action it takes lands in `.afr/log.jsonl`, chained. Copy that hooks block into any project to give its agent a flight recorder.

Privacy: records commit to full tool inputs/outputs via SHA-256 digests but only carry a 140-char preview in the clear. You can prove *exactly* what an agent did without publishing the payloads — reveal the preimage only when challenged.

## How tampering is caught

```
#000 UserPromptSubmit   GENESIS…      → 9d0459908b02…  Refund customer #4521…
#001 PostToolUse:Read   9d0459908b02… → 633f318a4680…
#002 PostToolUse:Bash   633f318a4680… → 6e74694bae80…  stripe refunds create --amount 12000
#003 PostToolUse:Edit   6e74694bae80… → cb59087cdc87…
#004 Stop               cb59087cdc87… → 840e3c2530bf…  ← chain root, sealed to Filecoin
```

Change one byte of record #2 and its recomputed hash no longer matches — and even a fully recomputed forged chain produces a different root than the one sealed on Filecoin, where PDP proofs keep attesting the original exists. The seal receipt (`.afr/seal-receipt.json`) carries the piece CID, data set IDs, providers, and a public gateway URL anyone can check.

## Why Filecoin is essential here

A hash chain alone only proves *internal* consistency — whoever holds the log can regenerate the whole chain after editing it. The trust comes from anchoring the root somewhere the agent and its operator can't touch:

- **Warm Storage** keeps the full original log retrievable, not just a hash.
- **PDP** proves continued possession onchain, daily, without anyone having to re-download it.
- **Filecoin Pay** lets the agent procure that storage programmatically — no credit card, no account, no human in the loop.
- Multiple independent providers hold copies; the receipt names them.

This maps directly onto Filecoin's [Agent RFS tracks](https://filecoin.cloud/agents): agentic storage, persistent agent state, and tamper-resistant agent reputation/identity.

## Where it's going next

- **Policy-bound receipts** — tag each record with the policy/allowlist that authorized it; forbidden-action *attempts* become onchain evidence.
- **Streaming seals** — periodic checkpoint seals so the window of unsealed history shrinks to minutes.
- **ERC-8004 identity** — the agent's wallet key signs each seal, binding the history to a portable onchain identity.
- **Counter-signed escrow** — release payment for agent work only when the audit trail verifies against the deliverable.

## License

Dual-licensed under [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) or [MIT](https://opensource.org/licenses/MIT), at your option.
