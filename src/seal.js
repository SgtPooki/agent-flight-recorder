/**
 * Seal the flight-recorder log to Filecoin Onchain Cloud.
 *
 * The log file + a manifest committing to the chain root are packed into a
 * UnixFS CAR and uploaded to Filecoin Warm Storage via the Synapse SDK
 * (through filecoin-pin's core API). Daily PDP proofs then keep attesting,
 * onchain, that the sealed log still exists bit-for-bit.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { depositUSDFC, getPaymentStatus } from 'filecoin-pin/core/payments'
import { calibration, initializeSynapse, mainnet } from 'filecoin-pin/core/synapse'
import { cleanupTempCar, createCarFromPath } from 'filecoin-pin/core/unixfs'
import { checkUploadReadiness, executeUpload } from 'filecoin-pin/core/upload'
import { privateKeyToAccount } from 'viem/accounts'
import { readLog, verifyChain } from './chain.js'

const CHAINS = { calibration, mainnet }

/** Accept private keys with or without the 0x prefix. */
function normalizeKey(privateKey) {
  const k = privateKey.trim()
  return k.startsWith('0x') ? k : `0x${k}`
}

function makeLogger(verbose) {
  const log = (level) => (...args) => {
    if (verbose) console.error(`[${level}]`, ...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))))
  }
  const logger = {
    info: log('info'),
    warn: log('warn'),
    error: (...args) => console.error('[error]', ...args),
    debug: log('debug'),
    trace: log('trace'),
    fatal: (...args) => console.error('[fatal]', ...args),
    level: verbose ? 'debug' : 'error',
  }
  logger.child = () => logger
  return logger
}

/**
 * @param {string} logPath - path to log.jsonl
 * @param {{privateKey: string, network?: 'mainnet'|'calibration', verbose?: boolean, onStatus?: (msg: string) => void}} opts
 */
export async function seal(logPath, opts) {
  const { privateKey, network = 'calibration', verbose = false, onStatus = () => {} } = opts
  const logger = makeLogger(verbose)
  const chain = CHAINS[network]
  if (!chain) throw new Error(`unsupported network: ${network}`)

  const records = await readLog(logPath)
  if (records.length === 0) throw new Error(`nothing to seal: ${logPath} is empty or missing`)
  const result = verifyChain(records)
  if (!result.ok) {
    throw new Error(
      `refusing to seal a broken chain (${result.failures.length} failure(s)). Run \`afr verify\` for details.`
    )
  }

  // Sign the chain root with the sealing wallet. The manifest then binds the
  // history to an onchain identity, not just to "whoever uploaded a file".
  const account = privateKeyToAccount(normalizeKey(privateKey))
  const signature = await account.signMessage({ message: result.root })

  // Stage log + manifest in a temp dir so both land under one IPFS root CID
  const manifest = {
    type: 'agent-flight-recorder/seal',
    version: 1,
    sealedAt: new Date().toISOString(),
    records: result.count,
    chainRoot: result.root,
    signer: account.address,
    rootSignature: signature,
  }
  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'afr-seal-'))
  await fs.copyFile(logPath, path.join(stageDir, 'log.jsonl'))
  await fs.writeFile(path.join(stageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  onStatus('packing log into CAR (UnixFS)')
  const { carPath, rootCid } = await createCarFromPath(stageDir, { isDirectory: true, logger })
  const carBytes = await fs.readFile(carPath)

  onStatus(`connecting to Filecoin ${network}`)
  const synapse = await initializeSynapse({ privateKey: normalizeKey(privateKey), chain }, logger)

  try {
    onStatus('checking payment readiness (FIL gas, USDFC deposit, WarmStorage allowances)')
    let readiness = await checkUploadReadiness({ synapse, fileSize: carBytes.length })

    // Self-fund: if only the Filecoin Pay deposit is short and the wallet has
    // USDFC, deposit the shortfall (with buffer) and re-check. Capped by
    // AFR_MAX_TOPUP_USDFC (default 5) so a buggy or hostile capacity check
    // can't move more than that in one seal. Off on mainnet unless
    // AFR_AUTO_FUND=1.
    const shortfall = readiness.capacity?.issues?.insufficientDeposit
    if (readiness.status !== 'ready' && shortfall && (readiness.walletUsdfcBalance ?? 0n) > 0n) {
      if (network === 'mainnet' && process.env.AFR_AUTO_FUND !== '1') {
        throw new Error(
          'deposit is short and auto-funding is disabled on mainnet. Set AFR_AUTO_FUND=1 to allow it, or deposit USDFC manually.'
        )
      }
      const ONE_USDFC = 10n ** 18n
      const maxTopUp = BigInt(Math.round(Number(process.env.AFR_MAX_TOPUP_USDFC || '5') * 1e6)) * 10n ** 12n
      let topUp = shortfall * 2n > ONE_USDFC ? shortfall * 2n : ONE_USDFC
      if (topUp > maxTopUp) topUp = maxTopUp
      if (topUp < shortfall) {
        throw new Error(
          `deposit shortfall (${Number(shortfall) / 1e18} USDFC) exceeds AFR_MAX_TOPUP_USDFC (${Number(maxTopUp) / 1e18}). Raise the cap or deposit manually.`
        )
      }
      onStatus(`depositing ${Number(topUp) / 1e18} USDFC into Filecoin Pay (agent self-funds its storage)`)
      await depositUSDFC(synapse, topUp)
      readiness = await checkUploadReadiness({ synapse, fileSize: carBytes.length })
    }

    if (readiness.status !== 'ready') {
      const why = readiness.validation.errorMessage ?? 'payment setup is not ready'
      const help = [readiness.validation.helpMessage, ...readiness.suggestions].filter(Boolean).join('\n')
      throw new Error(`${why}${help ? `\n${help}` : ''}`)
    }

    onStatus(`uploading ${carBytes.length} bytes to Filecoin Warm Storage`)
    const upload = await executeUpload(synapse, carBytes, rootCid, {
      logger,
      contextId: `afr-seal-${manifest.sealedAt}`,
      ipniValidation: { enabled: false },
      pieceMetadata: { afrChainRoot: result.root ?? '' },
    })

    const receipt = {
      ...manifest,
      network: upload.network,
      ipfsRootCid: rootCid.toString(),
      pieceCid: upload.pieceCid.toString(),
      size: upload.size,
      copies: upload.copies.map((c) => ({
        providerId: String(c.providerId),
        dataSetId: String(c.dataSetId),
        pieceId: String(c.pieceId),
        retrievalUrl: c.retrievalUrl,
      })),
      gatewayURL: `https://dweb.link/ipfs/${rootCid.toString()}/log.jsonl`,
    }
    const receiptPath = path.join(path.dirname(logPath), 'seal-receipt.json')
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
    return { receipt, receiptPath }
  } finally {
    await cleanupTempCar(carPath).catch(() => {})
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Check wallet/payment readiness without uploading anything.
 * @param {{privateKey: string, network?: 'mainnet'|'calibration'}} opts
 */
export async function paymentStatus(opts) {
  const { privateKey, network = 'calibration' } = opts
  const chain = CHAINS[network]
  if (!chain) throw new Error(`unsupported network: ${network}`)
  const synapse = await initializeSynapse({ privateKey: normalizeKey(privateKey), chain }, makeLogger(false))
  return getPaymentStatus(synapse)
}
