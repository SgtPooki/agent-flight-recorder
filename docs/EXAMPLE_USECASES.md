# Example use cases

The common shape: an agent takes actions on someone's behalf, and later a party who does NOT control the agent's logs needs to know what actually happened. If the verifier and the operator are the same person, you don't need this; a local log is fine. The recorder earns its keep the moment those roles split.

Privacy needs differ per case. See [PRIVACY_AND_ENCRYPTION.md](PRIVACY_AND_ENCRYPTION.md) for which recording/encryption mode fits which row.

## 1. Refund agent dispute resolution

A support agent has Stripe refund authority. A customer disputes a charge ("I was promised a full refund"); finance separately flags a refund-volume spike and suspects prompt injection or insider abuse.

Without the recorder, the only evidence is the company's own logs, which carry no weight precisely because the party making the claim holds the pen. With per-session seals, the company shows the sealed session to the card network's arbitrator, who verifies against Filecoin's copy (`afr verify --remote --ipfs-root <cid>`), not the company's copy. The seal predates the dispute; PDP has attested to those exact bytes daily since. For the internal investigation: edited local logs break verification at the exact record, and sessions missing seals are themselves the finding.

Recording mode: digest-only records, encrypted seal, arbitrator key added at dispute time.

## 2. Coding agent provenance for releases

An autonomous agent opens PRs that ship to production. A vulnerability later surfaces in agent-written code and the question is "what did the agent see and do when it wrote this?"

Seal each session, put the seal's IPFS root CID in the PR description. Reviewers (or incident responders, months later) replay exactly which files the agent read, which commands it ran, and what prompt drove the change. The chain makes "the transcript was tidied up after the incident" detectable.

Recording mode: previews on (`AFR_PREVIEW=1`) if the repo is public anyway; digest-only if the codebase is private.

## 3. Trading / treasury agent compliance

A DAO or fund runs an agent with wallet authority. Token holders (or a regulator) want proof the agent followed its mandate, but the strategy itself is sensitive while positions are open.

Seal every session with the full log encrypted; publish only the manifest (record count, chain root, signer) in the clear. Holders see that a complete, signed, tamper-evident history exists and grows on schedule. Disclosure happens later: reveal the decryption key after positions close, or hand it to an auditor under NDA. A missing or late seal is publicly visible without revealing anything about strategy.

Recording mode: encrypted seal, deferred or audience-scoped key release.

## 4. Agent reputation that survives platforms

An agent markets itself for hire ("I have completed 400 tasks with zero policy violations"). Self-reported track records are worthless; platform-held track records die with the platform.

Each completed task ends with a seal signed by the agent's own key. The accumulated seals on Filecoin ARE the portable track record: anyone can verify count, continuity (sequence gaps show abandoned/hidden sessions), and that the same key signed all of it. This is the [Filecoin agent RFS](https://filecoin.cloud/agents) reputation track, with ERC-8004 identity binding as the missing piece.

Recording mode: digest-only, public seals.. the whole point is third-party readability.

## 5. Parental / employer oversight of delegated agents

Less adversarial, same mechanics: you hand an agent your credentials to do something (book travel, manage listings, file forms) and want to audit afterwards what it did with that access, knowing the agent's vendor controls the "official" activity log.

Run the hooks locally; the vendor never touches the chain. Seal weekly. You're not litigating, just keeping receipts the vendor can't quietly amend.

Recording mode: previews on, seal encrypted to your own key only.

## What does NOT fit

- Verifier == operator and nobody else will ever care: use a log file.
- Sub-second trading where the unsealed window is the whole attack surface: session-end seals protect nothing mid-session. Wait for streaming checkpoint seals (roadmap).
- Histories that must be deletable (GDPR right-to-erasure over the payloads): never seal cleartext; digest-only or encrypted seals keep erasure possible by destroying keys. See the privacy doc.
