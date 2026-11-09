import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { FAILURE_ERROR_MAX, FAILURE_LOG_LIMIT, logSendFailure, sendFailuresFile } from '../lib/index.js'

const dirs = []
async function tempBase() {
  const dir = await mkdtemp(join(tmpdir(), 'iot-faillog-test-'))
  dirs.push(dir)
  return dir
}
after(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

test('logSendFailure: JSONL 追加 {at,channelKey,kind,error} 四键，无凭据无正文，tmp 清理', async () => {
  const base = await tempBase()
  await logSendFailure({ channelKey: 'conn1|cmd/{topic}/set', kind: 'reply', error: 'not ready' }, base)
  assert.deepEqual(await readdir(base), ['send-failures.jsonl'])
  const raw = await readFile(sendFailuresFile(base), 'utf8')
  const lines = raw.trim().split('\n')
  assert.equal(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'channelKey', 'error', 'kind'])
  assert.equal(entry.channelKey, 'conn1|cmd/{topic}/set')
  assert.equal(entry.kind, 'reply')
  assert.equal(entry.error, 'not ready')
  assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/)
})

test('logSendFailure: at 可注入；error 截断到 300 字', async () => {
  const base = await tempBase()
  await logSendFailure({ channelKey: 'k', kind: 'notice', error: 'y'.repeat(500), at: '2026-01-01T00:00:00.000Z' }, base)
  const entry = JSON.parse((await readFile(sendFailuresFile(base), 'utf8')).trim())
  assert.equal(entry.at, '2026-01-01T00:00:00.000Z')
  assert.equal(entry.error.length, FAILURE_ERROR_MAX)
  assert.equal(FAILURE_ERROR_MAX, 300)
})

test('logSendFailure: 上限 200 行滚动丢最旧', async () => {
  const base = await tempBase()
  for (let i = 0; i < FAILURE_LOG_LIMIT + 5; i++) {
    await logSendFailure({ channelKey: 'k' + i, kind: 'reply', error: 'e' + i, at: '2026-01-01T00:00:00.000Z' }, base)
  }
  const lines = (await readFile(sendFailuresFile(base), 'utf8')).trim().split('\n')
  assert.equal(lines.length, FAILURE_LOG_LIMIT)
  assert.equal(FAILURE_LOG_LIMIT, 200)
  assert.equal(JSON.parse(lines[0]).channelKey, 'k5')
  assert.equal(JSON.parse(lines[lines.length - 1]).channelKey, 'k' + (FAILURE_LOG_LIMIT + 4))
})

test('logSendFailure: 写失败不影响主流程（不抛出）', async () => {
  const base = await tempBase()
  const blocker = join(base, 'blocker')
  await writeFile(blocker, 'not a dir')
  await assert.doesNotReject(logSendFailure({ channelKey: 'k', kind: 'reply', error: 'e' }, blocker))
})

test('sendFailuresFile: 固定文件名挂 stateBase 下', () => {
  assert.equal(sendFailuresFile('/tmp/state-x'), '/tmp/state-x/send-failures.jsonl')
})
