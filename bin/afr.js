#!/usr/bin/env node
/**
 * afr: Agent Flight Recorder
 *
 * Tamper-evident audit trail for AI agents, sealed to Filecoin Onchain Cloud.
 *
 *   afr record            read a Claude Code hook payload on stdin, append a chained record
 *   afr note <text>       append a free-form note record
 *   afr log               pretty-print the chain
 *   afr verify            re-walk the chain, recompute every hash, compare to seal receipt
 *   afr verify --remote   fetch the sealed log back from Filecoin and verify against it
 *   afr seal              upload log + manifest to Filecoin Warm Storage (needs PRIVATE_KEY)
 *   afr status            wallet / Filecoin Pay readiness (needs PRIVATE_KEY)
 *
 * Env: AFR_DIR (default .afr), PRIVATE_KEY, AFR_NETWORK (calibration|mainnet)
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { appendRecord, readLog, short, verifyChain } from '../src/chain.js'

const AFR_DIR = process.env.AFR_DIR || path.join(process.cwd(), '.afr')
const LOG_PATH = path.join(AFR_DIR, 'log.jsonl')
const RECEIPT_PATH = path.join(AFR_DIR, 'seal-receipt.json')
const NETWORK = process.env.AFR_NETWORK || 'calibration'

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

const MAX_STDIN_BYTES = 1 << 20 // hook payloads are small; cap to keep a hostile one from eating memory

async function readStdin() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > MAX_STDIN_BYTES) throw new Error(`stdin exceeds ${MAX_STDIN_BYTES} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** `afr record`: Claude Code hook entrypoint (PostToolUse, UserPromptSubmit, Stop, ...) */
async function cmdRecord() {
  const raw = await readStdin()
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = { hook_event_name: 'RawInput', raw }
  }
  const event = payload.hook_event_name || 'UnknownHookEvent'
  const session = payload.session_id || 'unknown-session'
  const data = {
    cwd: payload.cwd,
    tool: payload.tool_name,
    // Commit to full content via digests; keep only a short preview in the clear.
    inputDigest: payload.tool_input !== undefined ? sha256(JSON.stringify(payload.tool_input)) : undefined,
    outputDigest: payload.tool_response !== undefined ? sha256(JSON.stringify(payload.tool_response)) : undefined,
    promptDigest: payload.prompt !== undefined ? sha256(payload.prompt) : undefined,
    // Cleartext previews are opt-in: seals publish the log to PUBLIC storage,
    // permanently. Digest-only records prove what happened without leaking it.
    preview: process.env.AFR_PREVIEW === '1' ? preview(payload) : undefined,
  }
  for (const k of Object.keys(data)) data[k] === undefined && delete data[k]
  const record = await appendRecord(LOG_PATH, session, event, data)
  // Hooks must not break the agent: always exit 0, stay quiet on stdout.
  process.stderr.write(`afr: recorded #${record.seq} ${event}${data.tool ? `:${data.tool}` : ''}\n`)
}

function preview(payload) {
  const src =
    payload.prompt ??
    (payload.tool_input ? JSON.stringify(payload.tool_input) : undefined) ??
    payload.raw
  if (typeof src !== 'string') return undefined
  const flat = src.replace(/\s+/g, ' ').trim()
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat
}

/** `afr note <text>`: free-form record, handy for demos and milestones */
async function cmdNote(args) {
  const text = args.join(' ').trim()
  if (!text) die('usage: afr note <text>')
  const record = await appendRecord(LOG_PATH, process.env.AFR_SESSION || 'manual', 'Note', { text })
  console.log(`${c.green('✓')} recorded #${record.seq} ${c.dim(short(record.hash))}`)
}

async function cmdLog() {
  const records = await readLog(LOG_PATH)
  if (records.length === 0) die(`no records at ${LOG_PATH}`)
  console.log(c.bold(`\n  Agent Flight Recorder.. ${records.length} records\n`))
  for (const r of records) {
    const label = r.data?.tool ? `${r.event}:${r.data.tool}` : r.event
    const desc = r.data?.preview ?? r.data?.text ?? ''
    console.log(
      `  ${c.dim(`#${String(r.seq).padStart(3, '0')}`)} ${c.cyan(label.padEnd(24))} ${c.dim(short(r.prev))} → ${c.yellow(short(r.hash))}  ${c.dim(desc.slice(0, 60))}`
    )
  }
  const { root } = verifyChain(records)
  console.log(`\n  chain root: ${c.bold(root ?? '(none)')}\n`)
}

async function cmdVerify(args) {
  const remote = args.includes('--remote')
  const records = await readLog(LOG_PATH)
  if (records.length === 0) die(`no records at ${LOG_PATH}`)

  console.log(c.bold('\n  Verifying hash chain...\n'))
  const result = verifyChain(records)
  for (const f of result.failures) {
    console.log(`  ${c.red('✗')} record #${f.seq}: ${c.red(f.reason)}`)
  }
  if (result.ok) {
    console.log(`  ${c.green('✓')} ${result.count} records, every hash links: chain is intact`)
  } else {
    console.log(`\n  ${c.red(`✗ TAMPERED: ${result.failures.length} integrity failure(s). This history has been altered.`)}`)
  }
  console.log(`  ${c.dim('local chain root:')} ${result.root ?? '(none)'}`)

  // Compare against the sealed commitment, if one exists
  let receipt = null
  try {
    receipt = JSON.parse(await fs.readFile(RECEIPT_PATH, 'utf8'))
  } catch {}

  if (receipt) {
    console.log(`\n  ${c.bold('Seal receipt')} ${c.dim(`(${receipt.sealedAt}, ${receipt.network})`)}`)
    console.log(`  ${c.dim('sealed chain root:')} ${receipt.chainRoot}`)
    const sealedPrefix = records.slice(0, receipt.records)
    const prefixResult = verifyChain(sealedPrefix)
    if (prefixResult.ok && prefixResult.root === receipt.chainRoot) {
      console.log(`  ${c.green('✓')} local history matches the root sealed on Filecoin (${receipt.records} records)`)
    } else {
      console.log(`  ${c.red('✗')} local history DOES NOT match what was sealed on Filecoin`)
      console.log(`    ${c.dim('Filecoin holds the original:')} ${receipt.gatewayURL ?? receipt.copies?.[0]?.retrievalUrl ?? ''}`)
    }
    if (receipt.copies?.length > 0) {
      console.log(`  ${c.dim('piece:')} ${receipt.pieceCid}`)
      for (const copy of receipt.copies) {
        console.log(`  ${c.dim(`provider #${copy.providerId}, data set #${copy.dataSetId}, piece #${copy.pieceId}, PDP-proven daily`)}`)
      }
    }
  } else if (remote) {
    die('no seal receipt found.. run `afr seal` first')
  } else {
    console.log(`\n  ${c.dim('no seal receipt.. run `afr seal` to anchor this chain to Filecoin')}`)
  }

  let remoteOk = true
  if (remote && receipt) {
    remoteOk = await remoteVerify(receipt, args)
  }

  console.log()
  if (!result.ok || !remoteOk) process.exit(1)
}

/**
 * Fetch the sealed log AND manifest back from content-addressed storage and
 * verify them independently of local state. The IPFS root CID pins the
 * content; an `--ipfs-root <cid>` argument (or a CID recorded somewhere you
 * trust, like a transaction or a registry) removes even the local receipt
 * from the trust path.
 */
async function remoteVerify(receipt, args) {
  const cidFlag = args.indexOf('--ipfs-root')
  const ipfsRoot = cidFlag !== -1 ? args[cidFlag + 1] : receipt.ipfsRootCid
  if (!ipfsRoot) {
    console.log(`  ${c.red('✗')} no IPFS root CID available`)
    return false
  }
  const base = `https://dweb.link/ipfs/${ipfsRoot}`
  console.log(`\n  ${c.bold('Remote verify')}: fetching the sealed log back from Filecoin`)
  console.log(`  ${c.dim(base)}`)

  let manifest, remoteText
  try {
    const [manifestRes, logRes] = await Promise.all([fetch(`${base}/manifest.json`), fetch(`${base}/log.jsonl`)])
    if (!manifestRes.ok || !logRes.ok) {
      console.log(`  ${c.red('✗')} fetch failed (${manifestRes.status}/${logRes.status}). Gateway may still be propagating; try the provider retrievalUrl in ${RECEIPT_PATH}`)
      return false
    }
    manifest = await manifestRes.json()
    remoteText = await logRes.text()
  } catch (err) {
    console.log(`  ${c.red('✗')} fetch failed: ${err.message}`)
    return false
  }

  let remoteRecords
  try {
    remoteRecords = remoteText
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
  } catch (err) {
    console.log(`  ${c.red('✗')} sealed log is not valid JSONL: ${err.message}`)
    return false
  }

  const remoteResult = verifyChain(remoteRecords)
  if (!remoteResult.ok || remoteResult.root !== manifest.chainRoot) {
    console.log(`  ${c.red('✗')} sealed copy does not verify (root ${short(remoteResult.root)}, manifest claims ${short(manifest.chainRoot)})`)
    return false
  }
  console.log(`  ${c.green('✓')} sealed copy verifies independently: ${remoteResult.count} records, root ${short(remoteResult.root)}`)

  if (manifest.rootSignature && manifest.signer) {
    const { recoverMessageAddress } = await import('viem')
    const recovered = await recoverMessageAddress({ message: manifest.chainRoot, signature: manifest.rootSignature })
    if (recovered.toLowerCase() === manifest.signer.toLowerCase()) {
      console.log(`  ${c.green('✓')} chain root signed by ${recovered}`)
    } else {
      console.log(`  ${c.red('✗')} root signature does not match claimed signer ${manifest.signer}`)
      return false
    }
  } else {
    console.log(`  ${c.dim('(unsigned seal: no identity binding)')}`)
  }
  return true
}

async function cmdSeal(args) {
  const privateKey = process.env.PRIVATE_KEY
  if (!privateKey) die('PRIVATE_KEY env var is required (calibration testnet key)')
  const { seal } = await import('../src/seal.js')
  const verbose = args.includes('--verbose')
  console.log(c.bold(`\n  Sealing flight-recorder log to Filecoin Onchain Cloud (${NETWORK})...\n`))
  const { receipt, receiptPath } = await seal(LOG_PATH, {
    privateKey,
    network: NETWORK,
    verbose,
    onStatus: (msg) => console.log(`  ${c.dim('…')} ${msg}`),
  })
  console.log(`\n  ${c.green('✓ sealed')}`)
  console.log(`  chain root : ${c.bold(receipt.chainRoot)}`)
  console.log(`  signed by  : ${receipt.signer}`)
  console.log(`  records    : ${receipt.records}`)
  console.log(`  IPFS root  : ${receipt.ipfsRootCid}`)
  console.log(`  piece CID  : ${receipt.pieceCid}`)
  for (const copy of receipt.copies) {
    console.log(`  provider   : #${copy.providerId} (data set #${copy.dataSetId}, piece #${copy.pieceId})`)
  }
  console.log(`  gateway    : ${receipt.gatewayURL}`)
  console.log(`  receipt    : ${receiptPath}`)
  console.log(`\n  ${c.dim('Daily PDP proofs now attest onchain that this exact history still exists.')}\n`)
  process.exit(0) // synapse keeps sockets open; we're done
}

async function cmdStatus() {
  const privateKey = process.env.PRIVATE_KEY
  if (!privateKey) die('PRIVATE_KEY env var is required')
  const { paymentStatus } = await import('../src/seal.js')
  const status = await paymentStatus({ privateKey, network: NETWORK })
  const fmt = (v) => (typeof v === 'bigint' ? `${Number(v) / 1e18}` : String(v))
  console.log(c.bold(`\n  Filecoin Pay status (${NETWORK})\n`))
  console.log(`  address        : ${status.address}`)
  console.log(`  wallet FIL     : ${fmt(status.filBalance)}`)
  console.log(`  wallet USDFC   : ${fmt(status.walletUsdfcBalance)}`)
  console.log(`  deposited      : ${fmt(status.filecoinPayBalance)} USDFC in Filecoin Pay`)
  console.log()
  process.exit(0)
}

function die(msg) {
  console.error(`${c.red('afr:')} ${msg}`)
  process.exit(1)
}

const [cmd, ...args] = process.argv.slice(2)
try {
  switch (cmd) {
    case 'record':
      await cmdRecord()
      break
    case 'note':
      await cmdNote(args)
      break
    case 'log':
      await cmdLog()
      break
    case 'verify':
      await cmdVerify(args)
      break
    case 'seal':
      await cmdSeal(args)
      break
    case 'status':
      await cmdStatus()
      break
    default:
      console.log(`afr: Agent Flight Recorder

  usage: afr <record|note|log|verify|seal|status>

  record           append a Claude Code hook payload from stdin (used by hooks)
  note <text>      append a free-form note record
  log              pretty-print the hash chain
  verify           recompute every hash; compare to the seal receipt
  verify --remote  fetch the sealed log + manifest back from Filecoin, verify the
                   chain and root signature (--ipfs-root <cid> skips the receipt)
  seal             sign the chain root, upload log + manifest (PRIVATE_KEY)
  status           wallet / Filecoin Pay readiness (PRIVATE_KEY)

  env: AFR_DIR (default ./.afr), AFR_NETWORK (calibration|mainnet), PRIVATE_KEY,
       AFR_PREVIEW=1 (cleartext previews, off by default),
       AFR_MAX_TOPUP_USDFC (auto-deposit cap, default 5),
       AFR_AUTO_FUND=1 (required for auto-deposit on mainnet)`)
  }
} catch (err) {
  die(err.message)
}
