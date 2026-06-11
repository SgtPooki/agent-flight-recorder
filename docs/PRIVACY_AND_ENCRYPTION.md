# Privacy and encryption design

Sealing publishes bytes to public storage, permanently. There is no delete. So the privacy question is settled at record time and seal time, not later. This doc describes the current protections, their known weaknesses, and the encryption design for closing them.

## What's public today, per mode

| | digest-only (default) | previews (`AFR_PREVIEW=1`) |
|---|---|---|
| event type, tool name | public | public |
| timestamps, session id, cwd | public | public |
| prompt / tool input / output | SHA-256 digest only | digest + first 140 chars cleartext |
| full payloads | never recorded | never recorded |

Two known weaknesses even in digest-only mode:

1. **Dictionary attacks on digests.** The digests are unsalted SHA-256. Anyone can confirm a guess: hash `{"command":"rm -rf /"}` and grep the public log. Low-entropy inputs (short commands, common prompts) are effectively readable by a motivated party.
2. **Metadata is the message.** Tool names and timing alone leak plenty. A public record showing `PostToolUse:Bash` every minute against `cwd: /trading-bot` tells a competitor when your agent trades, with zero payload access.

## Fix 1: salted commitments (cheap, keeps logs public)

Replace `sha256(content)` with `sha256(salt || content)` using a per-record random salt stored in a local sidecar file (never sealed). Properties:

- Public digest reveals nothing, even for `"y"`.
- Selective disclosure stays per-record: to prove what record #2 contained, reveal record #2's salt and content. Other records stay sealed.
- Verification math is unchanged; the chain still commits to the digests.

Cost: a sidecar file you must keep (lose the salts, lose the ability to prove content; the tamper-evidence of the chain itself survives). This should become the default recording mode.

## Fix 2: encrypted seals (for logs that can't be public at all)

When metadata itself is sensitive, encrypt the log before sealing and publish only ciphertext plus a cleartext manifest:

```
sealed bundle (public on Filecoin)
  log.jsonl.age      <- encrypted full log
  manifest.json      <- cleartext: record count, chain root (of PLAINTEXT records),
                        signer address, root signature, recipient key fingerprints
```

The chain root commits to the plaintext. So a verifier who later gets the key can decrypt, re-walk the chain, and confirm it matches the publicly-committed root. A verifier without the key still gets: a signed claim that N records existed at time T, PDP-proven to still exist unmodified.

[age](https://age-encryption.org) is the right tool: small, audited, multi-recipient by design, streams. Encrypt to one or more X25519 recipient keys per seal.

### Who holds keys, per use case

The recipient list is the policy knob. Same mechanics, different recipients:

- **Self-audit** (oversight of delegated agents): encrypt to your own key only.
- **Internal compliance**: encrypt to the company KMS key plus the compliance team's key. The auditor gets decryption under existing NDA machinery; Filecoin contributes durability and the tamper-evident timestamp, not disclosure.
- **Dispute resolution** (refund agent): encrypt to the company key. When a dispute opens, re-share the session key with the arbitrator (age supports per-file keys wrapped per recipient, so this is "wrap the key to one more recipient", not "re-upload").
- **Regulated reporting**: encrypt to company + regulator keys at seal time. The regulator can read any seal unilaterally; the public can verify seals exist and are signed.
- **Deferred transparency** (trading/treasury): encrypt to a key you publish later (positions closed, embargo passed). Anyone can then decrypt the whole history retroactively and check it against the roots that were public all along. This is the strongest pattern: public commitments now, public payloads later, no trust interval.
- **Threshold disclosure**: split the key (Shamir) among arbitrators so disclosure needs M-of-N agreement. Right for escrow cases where neither party should unilaterally open the log.
- **Public accountability** (agent reputation, DAO bots): don't encrypt. Readability by strangers is the product.

### What encryption does NOT change

- The operator-can-omit-events gap is untouched. Encryption is confidentiality, not completeness.
- The chain root and signature must stay cleartext or the seal proves nothing to anyone.
- Key loss converts "private evidence" into "permanent proof that something existed which nobody can read". For some cases (GDPR erasure) that's a feature: destroy the key, the payloads are gone, the integrity skeleton remains.

## Other hardening, ranked

1. **Verified retrieval**: `verify --remote` currently trusts the gateway to serve the bytes for a CID. Use [@helia/verified-fetch](https://github.com/ipfs/helia-verified-fetch) so retrieved blocks are hash-checked against the CID locally. Closes the malicious-gateway hole without any key requirement.
2. **Stop recording `cwd`** by default (leaks usernames and project names) or record its salted digest.
3. **Key handling**: `PRIVATE_KEY` as an env var lands in shell history and `ps`. Move to a keychain lookup or a session-key flow (Synapse supports session keys, which also caps blast radius to storage operations).
4. **Streaming checkpoint seals**: shrinks the unsealed window, which is an integrity gap and also a privacy one (an unsealed log is just a file; anyone who reads the machine reads it).
5. **Per-record signing** is NOT planned: signing every record with the wallet key would burn key material on a hot path for little gain; the chain plus a signed root gives the same post-seal guarantees.

## Decision summary

Should things be encrypted? Default no for the chain skeleton (roots, signatures, manifests).. those are only useful public. Default yes for anything payload-shaped the moment a real workload touches the recorder: salted commitments first (they cost almost nothing), age-encrypted seals when metadata or previews must travel. Pick recipients by asking one question: who is the verifier, and when do they get to read?
