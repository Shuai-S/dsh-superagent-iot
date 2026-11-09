import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { TARGET_ID_RE, TARGETS_VERSION, getTarget, readTargets, targetsFile, touchTarget, validTargetId, writeTargets } from '../lib/index.js'

const dirs = []
async function tempBase() {
  const dir = await mkdtemp(join(tmpdir(), 'iot-targets-test-'))
  dirs.push(dir)
  return dir
}
after(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

const row = (id, topic, connection) => ({
  id,
  address: { topic, ...(connection ? { connection } : {}) },
  label: 'l-' + id,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: '',
})

test('targetsFile: 固定文件名挂 stateBase 下', () => {
  assert.equal(targetsFile('/tmp/state-x'), '/tmp/state-x/targets.json')
})

test('validTargetId: 契约语法 [A-Za-z0-9._@:-]{1,128}', () => {
  assert.equal(TARGET_ID_RE.source, '^[A-Za-z0-9._@:-]{1,128}$')
  assert.equal(validTargetId('living-room'), true)
  assert.equal(validTargetId('a.b@c:1_2'), true)
  assert.equal(validTargetId('a'.repeat(128)), true)
  assert.equal(validTargetId('a'.repeat(129)), false)
  assert.equal(validTargetId(''), false)
  assert.equal(validTargetId('带 空格'), false)
  assert.equal(validTargetId('slash/id'), false)
  assert.equal(validTargetId(42), false)
  assert.equal(validTargetId(null), false)
})

test('write+read roundtrip：原子写落盘且无 tmp 残留', async () => {
  const base = await tempBase()
  await writeTargets({ version: 1, targets: [row('a', 'cmd/{topic}', 'c1'), row('b', 'cmd/x/set')] }, base)
  assert.deepEqual(await readdir(base), ['targets.json'])
  const file = await readTargets(base)
  assert.equal(file.version, TARGETS_VERSION)
  assert.equal(file.targets.length, 2)
  assert.deepEqual(file.targets[0], { id: 'a', address: { topic: 'cmd/{topic}', connection: 'c1' }, label: 'l-a', createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: '' })
  assert.deepEqual(file.targets[1].address, { topic: 'cmd/x/set' }, 'connection 省略时不落该键')
  const raw = JSON.parse(await readFile(targetsFile(base), 'utf8'))
  assert.equal(raw.version, 1)
})

test('readTargets: 缺文件返回空表（不建目录不抛出）', async () => {
  const base = await tempBase()
  const file = await readTargets(base)
  assert.deepEqual(file, { version: TARGETS_VERSION, targets: [] })
})

test('readTargets: 损坏 JSON 降级空表不抛出', async () => {
  const base = await tempBase()
  await writeFile(targetsFile(base), 'not-json{{{', 'utf8')
  assert.deepEqual(await readTargets(base), { version: TARGETS_VERSION, targets: [] })
})

test('readTargets: 剔除形状非法条目（id 非法 / address.topic 缺失 / 非对象）', async () => {
  const base = await tempBase()
  await writeFile(targetsFile(base), JSON.stringify({
    version: 1,
    targets: [
      row('ok', 'cmd/ok/set', 'c1'),
      { id: 'bad/slash', address: { topic: 't' } },
      { id: 'noaddress' },
      { id: 'empty-topic', address: { topic: '' } },
      'junk-string',
      null,
    ],
  }), 'utf8')
  const file = await readTargets(base)
  assert.equal(file.targets.length, 1)
  assert.equal(file.targets[0].id, 'ok')
})

test('getTarget: 精确命中首个', async () => {
  const base = await tempBase()
  await writeTargets({ version: 1, targets: [row('x', 't1'), row('y', 't2')] }, base)
  const hit = await getTarget('y', base)
  assert.equal(hit?.address.topic, 't2')
  assert.equal(await getTarget('missing', base), undefined)
})

test('touchTarget: 只更新该行 lastUsedAt，其余不变', async () => {
  const base = await tempBase()
  await writeTargets({ version: 1, targets: [row('p', 't1'), row('q', 't2')] }, base)
  await touchTarget('p', '2026-11-09T12:00:00.000Z', base)
  const file = await readTargets(base)
  assert.equal(file.targets[0].lastUsedAt, '2026-11-09T12:00:00.000Z')
  assert.equal(file.targets[1].lastUsedAt, '')
  assert.equal(file.targets[0].createdAt, '2026-01-01T00:00:00.000Z')
})

test('touchTarget: 未知 id 静默返回（不建文件不抛出）', async () => {
  const base = await tempBase()
  await assert.doesNotReject(touchTarget('ghost', '2026-11-09T12:00:00.000Z', base))
  await assert.doesNotReject(touchTarget('ghost', '2026-11-09T12:00:00.000Z', join(base, 'not-a-dir-blocked')))
})
