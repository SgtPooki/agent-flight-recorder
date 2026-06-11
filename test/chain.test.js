import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { appendRecord, readLog, verifyChain } from '../src/chain.js'

async function tmpLog() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'afr-test-'))
  return path.join(dir, 'log.jsonl')
}

test('appends chained records and verifies clean', async () => {
  const log = await tmpLog()
  await appendRecord(log, 's1', 'A', { n: 1 })
  await appendRecord(log, 's1', 'B', { n: 2 })
  await appendRecord(log, 's1', 'C', { n: 3 })
  const result = verifyChain(await readLog(log))
  assert.equal(result.ok, true)
  assert.equal(result.count, 3)
  assert.ok(result.root)
})

test('detects content tampering', async () => {
  const log = await tmpLog()
  await appendRecord(log, 's1', 'A', { amount: 10 })
  await appendRecord(log, 's1', 'B', { amount: 20 })
  const lines = (await fs.readFile(log, 'utf8')).trim().split('\n')
  const doctored = JSON.parse(lines[0])
  doctored.data.amount = 10_000
  lines[0] = JSON.stringify(doctored)
  await fs.writeFile(log, `${lines.join('\n')}\n`)

  const result = verifyChain(await readLog(log))
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((f) => f.seq === 0 && f.reason.includes('content altered')))
})

test('detects deleted records', async () => {
  const log = await tmpLog()
  await appendRecord(log, 's1', 'A', {})
  await appendRecord(log, 's1', 'B', {})
  await appendRecord(log, 's1', 'C', {})
  const lines = (await fs.readFile(log, 'utf8')).trim().split('\n')
  lines.splice(1, 1) // delete the middle record
  await fs.writeFile(log, `${lines.join('\n')}\n`)

  const result = verifyChain(await readLog(log))
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((f) => f.reason.includes('broken link')))
})

test('concurrent appends do not fork the chain', async () => {
  const log = await tmpLog()
  await Promise.all(Array.from({ length: 20 }, (_, i) => appendRecord(log, 's1', 'Parallel', { i })))
  const result = verifyChain(await readLog(log))
  assert.equal(result.ok, true)
  assert.equal(result.count, 20)
})

test('root changes when history changes', async () => {
  const log1 = await tmpLog()
  const log2 = await tmpLog()
  await appendRecord(log1, 's1', 'A', { x: 1 })
  await appendRecord(log2, 's1', 'A', { x: 2 })
  const r1 = verifyChain(await readLog(log1))
  const r2 = verifyChain(await readLog(log2))
  assert.notEqual(r1.root, r2.root)
})
