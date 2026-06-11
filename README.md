# Agent Flight Recorder

Receipts, not self-reports. A tamper-evident audit trail for AI agents, sealed to [Filecoin Onchain Cloud](https://filecoin.cloud).

## ELI5

An AI agent is a kid with your credit card. Afterwards, the kid tells you what it bought.. but the kid writes its own diary, and whoever holds the diary can rewrite it.

The flight recorder makes the diary special: every page includes a fingerprint of the page before it, so ripping out or editing a page smudges every fingerprint after it. Then we mail a sealed copy to a public vault that neither the kid nor the diary's owner controls (Filecoin), and the vault keeps proving, every day, that it still holds the original. Protection starts at the moment of sealing.. pages written before the seal but never mailed were never protected.

Now when someone says "the agent only refunded $120," you don't have to trust the diary's owner. Check the vault.

## What it does

Agents are starting to take real actions: refunds, deploys, trades, emails. When something goes wrong, the only record of what happened is usually a log file the agent (or its operator) can quietly rewrite. The question isn't whether an agent can summarize what it did, it's whether anyone can independently verify that history after incentives change.

1. **Record**: Claude Code hooks append every prompt, tool call, and stop event to an append-only JSONL log. Each record commits to the previous record's hash, so editing, deleting, or reordering anything breaks every hash after it.
2. **Seal**: the log plus a manifest committing to the chain root are packed into a UnixFS CAR and uploaded to Filecoin Warm Storage via the [Synapse SDK](https://docs.filecoin.cloud/developer-guides/synapse/) (through [filecoin-pin](https://github.com/filecoin-project/filecoin-pin)'s core API). Storage is paid onchain through Filecoin Pay; if the deposit is short, the agent funds it from its own wallet.
3. **Prove**: daily PDP (Proof of Data Possession) proofs attest onchain that the sealed history still exists, bit-for-bit, on independent storage providers.
4. **Verify**: anyone can re-walk the chain, recompute every hash, and fetch the sealed original back from Filecoin.

## What it does NOT prove

Be clear-eyed about the trust model:

- The hooks run on the operator's machine. An operator can filter or fake events *before* they're recorded. The seal proves what was recorded, not that recording was complete.
- A chain can be wholly regenerated before sealing. Tamper-evidence starts at the moment of seal, not the moment of action.
- Seals are signed by the sealing wallet, so a seal is bound to *a key*. Nothing yet ties that key to a registered agent identity; that's the ERC-8004 work under roadmap.
- PDP proves a provider still holds the sealed bytes. It does not prove those bytes were an honest account of anything.

What you get today: after a seal exists, nobody (agent, operator, or you) can rewrite the sealed history without detection, and the original stays publicly retrievable. That's the claim, the whole claim.

Concrete scenarios where that claim is worth money: [docs/EXAMPLE_USECASES.md](docs/EXAMPLE_USECASES.md).

## Quick start

```bash
npm install
npm test

# the full demo: record -> verify -> tamper -> get caught
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
afr verify --remote  fetch the sealed log + manifest back from Filecoin, verify the
                     chain and the root signature (--ipfs-root <cid> skips the
                     local receipt entirely)
afr seal             sign the chain root, upload log + manifest to Warm Storage
afr status           wallet / Filecoin Pay readiness

env: AFR_DIR (default ./.afr), AFR_NETWORK (calibration|mainnet), PRIVATE_KEY,
     AFR_PREVIEW=1 (record cleartext previews; off by default),
     AFR_MAX_TOPUP_USDFC (auto-deposit cap per seal, default 5),
     AFR_AUTO_FUND=1 (required for auto-deposit on mainnet)
```

## Recording a real Claude Code session

This repo's [`.claude/settings.json`](.claude/settings.json) wires `afr record` into the `UserPromptSubmit`, `PostToolUse`, and `Stop` hooks. Open Claude Code in this directory and every action it takes lands in `.afr/log.jsonl`, chained. Copy that hooks block into any project to give its agent a flight recorder.

Privacy: records commit to full tool inputs/outputs via SHA-256 digests. Cleartext previews are OFF by default; set `AFR_PREVIEW=1` to include the first 140 chars of prompts/inputs. Sealing publishes the whole log to public storage, permanently.. whatever is in the log is what you're publishing. Digest-only records let you prove what an agent did and reveal a preimage only when challenged. Note the digests are unsalted, so low-entropy inputs (short commands, common prompts) can be dictionary-checked; treat digests as commitments, not encryption. [docs/PRIVACY_AND_ENCRYPTION.md](docs/PRIVACY_AND_ENCRYPTION.md) covers the fix (salted commitments) and the encrypted-seal design for logs that can't be public at all.

## How tampering is caught

```
#000 UserPromptSubmit   GENESIS...      -> 9d0459908b02...  Refund customer #4521...
#001 PostToolUse:Read   9d0459908b02... -> 633f318a4680...
#002 PostToolUse:Bash   633f318a4680... -> 6e74694bae80...  stripe refunds create --amount 12000
#003 PostToolUse:Edit   6e74694bae80... -> cb59087cdc87...
#004 Stop               cb59087cdc87... -> 840e3c2530bf...  <- chain root, sealed to Filecoin
```

Change one byte of record #2 and its recomputed hash no longer matches. A fully regenerated forged chain produces a different root than the one sealed on Filecoin. The seal receipt (`.afr/seal-receipt.json`) carries the piece CID, data set IDs, providers, and a public gateway URL anyone can check.

## Why Filecoin

A hash chain alone only proves internal consistency; whoever holds the log can regenerate the whole chain after editing it. The trust comes from anchoring the root (and the full log) somewhere the agent and its operator can't touch:

- Warm Storage keeps the full original log retrievable, not just a hash.
- PDP proves continued possession onchain, daily, with no re-download.
- Filecoin Pay lets the agent procure that storage programmatically (no credit card, no account, no human in the loop).
- Multiple independent providers hold copies; the receipt names them.

This maps onto Filecoin's [Agent RFS tracks](https://filecoin.cloud/agents): agentic storage, persistent agent state, and tamper-resistant agent reputation.

## Roadmap

1. **ERC-8004 identity binding**: seals are already signed by the sealing wallet; next is tying that key to a registered onchain agent identity.
2. **Streaming checkpoint seals**: periodic seals shrink the unsealed window from "whole session" to minutes.
3. **Policy-bound receipts**: tag each record with the policy that authorized it; forbidden-action attempts become evidence.
4. **Counter-signed escrow**: release payment for agent work only when the audit trail verifies against the deliverable.

## License

Dual-licensed under [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) or [MIT](https://opensource.org/licenses/MIT), at your option.
