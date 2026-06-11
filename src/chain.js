/**
 * Hash-chained append-only event log.
 *
 * Each record commits to the previous record's hash, so editing, deleting,
 * or reordering any record breaks every hash after it. The final hash (the
 * "chain root") is a commitment to the entire history.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const GENESIS = 'GENESIS'

/** @param {string} s */
export function sha256(s) {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * Compute a record's hash. Fields are serialized in a fixed order so the
 * hash is deterministic regardless of how the object was constructed.
 * @param {{seq: number, ts: string, session: string, event: string, data: object, prev: string}} r
 */
export function recordHash(r) {
  return sha256(JSON.stringify([r.seq, r.ts, r.session, r.event, r.data, r.prev]))
}

/** @param {string} logPath */
export async function readLog(logPath) {
  let raw
  try {
    raw = await fs.readFile(logPath, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line)
      } catch {
        return { seq: i, event: 'UNPARSEABLE', corruptLine: line }
      }
    })
}

/**
 * Append an event to the log, chaining it to the last record.
 * @param {string} logPath
 * @param {string} session
 * @param {string} event
 * @param {object} data
 */
export async function appendRecord(logPath, session, event, data) {
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  const records = await readLog(logPath)
  const last = records[records.length - 1]
  const record = {
    seq: last ? last.seq + 1 : 0,
    ts: new Date().toISOString(),
    session,
    event,
    data,
    prev: last ? last.hash : GENESIS,
  }
  record.hash = recordHash(record)
  await fs.appendFile(logPath, `${JSON.stringify(record)}\n`)
  return record
}

/**
 * Re-walk the chain and recompute every hash.
 * @param {Array<object>} records
 * @returns {{ok: boolean, count: number, root: string|null, failures: Array<{seq: number, reason: string}>}}
 */
export function verifyChain(records) {
  const failures = []
  let prev = GENESIS
  let expectedSeq = 0
  let lastTs = ''
  for (const r of records) {
    if (r.event === 'UNPARSEABLE') {
      failures.push({ seq: r.seq, reason: 'record is not valid JSON (corrupted line)' })
      continue
    }
    if (r.seq !== expectedSeq) {
      failures.push({ seq: r.seq, reason: `sequence gap: got #${r.seq}, expected #${expectedSeq}` })
    }
    expectedSeq = (r.seq ?? expectedSeq) + 1
    if (typeof r.ts === 'string' && r.ts < lastTs) {
      failures.push({ seq: r.seq, reason: `timestamp went backwards: ${r.ts} after ${lastTs}` })
    }
    if (typeof r.ts === 'string') lastTs = r.ts
    if (r.prev !== prev) {
      failures.push({ seq: r.seq, reason: `broken link: prev is ${short(r.prev)}, expected ${short(prev)}` })
    }
    const expected = recordHash(r)
    if (r.hash !== expected) {
      failures.push({ seq: r.seq, reason: `content altered: hash is ${short(r.hash)}, recomputed ${short(expected)}` })
    }
    prev = r.hash
  }
  return {
    ok: failures.length === 0,
    count: records.length,
    root: records.length > 0 ? records[records.length - 1].hash : null,
    failures,
  }
}

/** @param {string} [h] */
export function short(h) {
  return h ? `${h.slice(0, 12)}…` : '(missing)'
}
