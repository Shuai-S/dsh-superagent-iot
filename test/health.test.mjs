import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { connectionRegistry, createApiHandler, deliverStats, logSendFailure } from '../lib/index.js'
import { writeTargets } from '../lib/index.js'

const dirs = []
async function tempBase() {
  const dir = await mkdtemp(join(tmpdir(), 'iot-health-test-'))
  dirs.push(dir)
  return dir
}
after(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

// 模块级单例还原：连接注册表与 deliver 计数。
const registryBackup = connectionRegistry.current
const statsSnapshot = { ...deliverStats }
after(() => {
  connectionRegistry.current = registryBackup
  Object.assign(deliverStats, statsSnapshot)
})

const fakeClient = (online) => ({ clientId: 'c', connected: () => online, publishCommand: async () => {}, end: async () => {} })
const withRegistry = (entries) => { connectionRegistry.current = new Map(entries) }

async function startServer(deps) {
  let handler = null
  const server = http.createServer((req, res) => {
    // handler 在 listen 之后才有真实端口；请求只会晚于该赋值到达。
    handler(req, res).catch(() => { res.writeHead(500); res.end() })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  handler = createApiHandler({ port: server.address().port, ...deps })
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) }
}

const call = async (port) => {
  const res = await fetch('http://127.0.0.1:' + port + '/dsh-iot/api/health', { headers: { 'x-orchestrator-request': '1' } })
  return { status: res.status, json: await res.json() }
}

test('GET /api/health：计数形状（in/out/fail/deny+deliver）+ 连接快照 + 目标数 + 最近 failure-log（上限 20）', async () => {
  const base = await tempBase()
  await writeTargets({
    version: 1,
    targets: [
      { id: 'a', address: { topic: 't1' }, label: '', createdAt: '', lastUsedAt: '' },
      { id: 'b', address: { topic: 't2', connection: 'c2' }, label: '', createdAt: '', lastUsedAt: '' },
    ],
  }, base)
  for (let i = 1; i <= 25; i++) {
    await logSendFailure({ channelKey: 'c1|cmd/x', kind: 'reply', error: 'boom-' + i, at: '2026-11-09T00:00:' + String(i % 60).padStart(2, '0') + '.000Z' }, base)
  }
  withRegistry([['c1', { client: fakeClient(true), via: 'v' }], ['c2', { client: fakeClient(false), via: 'v' }]])
  const { port, close } = await startServer({ receive: async () => 'stored', configured: () => true, config: () => undefined, baseDir: base })
  try {
    const { status, json } = await call(port)
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.deepEqual(Object.keys(json.counts).sort(), ['deliverAccepted', 'deliverFailed', 'deny', 'fail', 'in', 'out'])
    assert.equal(json.counts.deny, 0, 'ACL 判定不适用，deny 恒 0 保形')
    assert.equal(typeof json.counts.in, 'number')
    assert.equal(typeof json.counts.deliverAccepted, 'number')
    assert.deepEqual(json.connections, { total: 2, online: 1 })
    assert.equal(json.targets, 2)
    assert.equal(json.recentFailures.length, 20, 'failure-log 最近 20 条')
    assert.equal(json.recentFailures[19].error, 'boom-25', '最新一条在末尾')
    assert.deepEqual(Object.keys(json.recentFailures[0]).sort(), ['at', 'channelKey', 'error', 'kind'])
    assert.match(json.lastFailAt ?? '', /^(\d{4}-|$)/)
  } finally { await close() }
})

test('GET /api/health：空 state 目录 → 空计数空表零失败', async () => {
  const base = await tempBase()
  withRegistry([])
  const { port, close } = await startServer({ receive: async () => 'stored', configured: () => false, config: () => undefined, baseDir: base })
  try {
    const { status, json } = await call(port)
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.deepEqual(json.connections, { total: 0, online: 0 })
    assert.equal(json.targets, 0)
    assert.deepEqual(json.recentFailures, [])
    assert.equal(json.counts.in + json.counts.out + json.counts.fail, 0, '进程起始计数为零')
  } finally { await close() }
})

test('GET /api/health：deliver 计数随受理增长', async () => {
  const base = await tempBase()
  await writeTargets({ version: 1, targets: [{ id: 'a', address: { connection: 'c1', topic: 't' }, label: '', createdAt: '', lastUsedAt: '' }] }, base)
  withRegistry([['c1', { client: fakeClient(true), via: 'v' }]])
  const deps = { receive: async () => 'stored', configured: () => true, config: () => undefined, baseDir: base }
  const { port, close } = await startServer(deps)
  try {
    const before = deliverStats.accepted
    await fetch('http://127.0.0.1:' + port + '/dsh-iot/api/deliver', {
      method: 'POST',
      headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ targetId: 'a', text: 'count me' }),
    })
    const { json } = await call(port)
    assert.equal(json.counts.deliverAccepted, before + 1)
  } finally { await close() }
})

test('GET /api/health：同源闸门外 → 403', async () => {
  const base = await tempBase()
  const { port, close } = await startServer({ receive: async () => 'stored', configured: () => true, config: () => undefined, baseDir: base })
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/dsh-iot/api/health')
    assert.equal(res.status, 403)
  } finally { await close() }
})