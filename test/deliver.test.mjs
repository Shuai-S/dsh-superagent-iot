import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { buildDeliverTrigger, connectionRegistry, createApiHandler, DELIVER_TEST_TEXT, IotConfigSchema } from '../lib/index.js'
import { targetsFile, writeTargets } from '../lib/index.js'

const dirs = []
async function tempBase() {
  const dir = await mkdtemp(join(tmpdir(), 'iot-deliver-test-'))
  dirs.push(dir)
  return dir
}
after(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

// 连接注册表是模块级单例（connectionRegistry.current）：测试替换后必须还原。
const registryBackup = connectionRegistry.current
after(() => { connectionRegistry.current = registryBackup })

const fakeClient = (impl) => ({
  clientId: 'test-client',
  connected: () => true,
  publishCommand: impl ?? (async () => {}),
  end: async () => {},
})
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

async function call(port, method, path, body, headers = {}) {
  const res = await fetch('http://127.0.0.1:' + port + path, {
    method,
    headers: { 'x-orchestrator-request': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const seedTarget = (base, overrides = {}) => writeTargets({
  version: 1,
  targets: [{ id: 'lamp', address: { connection: 'c1', topic: 'cmd/home/lamp/set' }, label: '', createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: '', ...overrides }],
}, base)

test('sameOrigin 闸门：缺 x-orchestrator-request 头 → 403（deliver 路径的访问控制，ACL 判定 N/A 的承担面）', async () => {
  const base = await tempBase()
  await seedTarget(base)
  const { port, close } = await startServer({ receive: async () => 'stored', configured: () => true, config: () => undefined, baseDir: base })
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/dsh-iot/api/deliver', { method: 'POST', body: JSON.stringify({ targetId: 'lamp', text: 'x' }) })
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error, 'Same-origin management request required')
  } finally { await close() }
})

test('POST /api/deliver 受理：构造非人类 Trigger 送达 receive，响应 {ok,accepted,triggerId}，lastUsedAt 更新', async () => {
  const base = await tempBase()
  await seedTarget(base)
  withRegistry([['c1', { client: fakeClient(), via: 'dsh-superagent-iot:test-client' }]])
  const received = []
  const { port, close } = await startServer({ receive: (t) => { received.push(t); return 'stored' }, configured: () => true, config: () => undefined, baseDir: base })
  try {
    const { status, json } = await call(port, 'POST', '/dsh-iot/api/deliver', { targetId: 'lamp', text: '打开客厅灯', kind: 'notice' })
    assert.equal(status, 200)
    assert.deepEqual(json, { ok: true, accepted: true, triggerId: received[0].id })
    const t = received[0]
    assert.equal(t.human, false, '契约 §2：非人类 Trigger')
    assert.equal(t.meta.deliver, true, 'meta.deliver=true')
    assert.deepEqual(t.actor, { source: 'iot', id: 'dsh-superagent-iot' }, "actor='iot'")
    assert.equal(t.addressed, 'direct', 'machineGate scope 检查要求 addressed（iot scope observed=false）')
    assert.equal(t.meta.connectionId, 'c1', 'intake scope 过滤按 meta.connectionId 判 listened')
    assert.equal(t.meta.targetId, 'lamp')
    assert.deepEqual(t.channel.address, { connection: 'c1', replyTopic: 'cmd/home/lamp/set' }, 'address=replyTopic（目标命令主题全名）')
    assert.equal(t.threads[0].id, 'iot:deliver:lamp')
    assert.equal(t.channel.thread, 'iot:deliver:lamp')
    assert.equal(t.source, 'iot')
    assert.equal(t.text, '打开客厅灯')
    assert.match(t.id, /^iot:deliver:lamp:/)
    const file = JSON.parse(await readFile(targetsFile(base), 'utf8'))
    assert.match(file.targets[0].lastUsedAt, /^\d{4}-/, 'lastUsedAt 已更新')
  } finally { await close() }
})

test('deliver：address.connection 省略且仅配一个连接 → 自动取用', async () => {
  const base = await tempBase()
  await seedTarget(base, { address: { topic: 'cmd/solo/set' } })
  withRegistry([['solo', { client: fakeClient(), via: 'v' }]])
  const received = []
  const { port, close } = await startServer({
    receive: (t) => { received.push(t); return 'stored' },
    configured: () => true,
    config: () => ({ connections: [{ name: 'solo', url: 'mqtt://x' }] }),
    baseDir: base,
  })
  try {
    const { status } = await call(port, 'POST', '/dsh-iot/api/deliver', { targetId: 'lamp', text: 'hi' })
    assert.equal(status, 200)
    assert.equal(received[0].meta.connectionId, 'solo')
  } finally { await close() }
})

test('deliver：多连接且未显式 connection → 400 bad-request', async () => {
  const base = await tempBase()
  await seedTarget(base, { address: { topic: 'cmd/x/set' } })
  withRegistry([['a', { client: fakeClient(), via: 'v' }], ['b', { client: fakeClient(), via: 'v' }]])
  const { port, close } = await startServer({
    receive: async () => 'stored',
    configured: () => true,
    config: () => ({ connections: [{ name: 'a', url: 'mqtt://x' }, { name: 'b', url: 'mqtt://y' }] }),
    baseDir: base,
  })
  try {
    const { status, json } = await call(port, 'POST', '/dsh-iot/api/deliver', { targetId: 'lamp', text: 'hi' })
    assert.equal(status, 400)
    assert.equal(json.error, 'bad-request')
  } finally { await close() }
})

test('deliver：未知目标 → 404 unknown-target', async () => {
  const base = await tempBase()
  withRegistry([['c1', { client: fakeClient(), via: 'v' }]])
  const { port, close } = await startServer({ receive: async () => 'stored', configured: () => true, config: () => undefined, baseDir: base })
  try {
    const { status, json } = await call(port, 'POST', '/dsh-iot/api/deliver', { targetId: 'ghost', text: 'hi' })
    assert.equal(status, 404)
    assert.deepEqual(json, { error: 'unknown-target' })
  } finally { await close() }
})

test('deliver：形状非法 → 400 bad-request（targetId 语法 / text 缺失 / JSON 损坏 / 方法不匹配）', async () => {
  const base = await tempBase()
  await seedTarget(base)
  withRegistry([['c1', { client: fakeClient(), via: 'v' }]])
  const { port, close } = await startServer({ receive: async () => 'stored', configured: () => true, config: () => undefined, baseDir: base })
  try {
    assert.equal((await call(port, 'POST', '/dsh-iot/api/deliver', { targetId: 'bad/slash', text: 'x' })).status, 400)
    assert.equal((await call(port, 'POST', '/dsh-iot/api/deliver', { targetId: 'lamp' })).status, 400)
    assert.equal((await call(port, 'POST', '/dsh-iot/api/deliver', { targetId: 'lamp', text: '   ' })).status, 400)
    const raw = await fetch('http://127.0.0.1:' + port + '/dsh-iot/api/deliver', { method: 'POST', headers: { 'x-orchestrator-request': '1' }, body: 'not-json{{{' })
    assert.equal(raw.status, 400)
    assert.equal((await call(port, 'GET', '/dsh-iot/api/deliver')).status, 404, 'GET 打 POST 端点 → 404')
  } finally { await close() }
})

test('deliver：源未配置 → 409 not-ready', async () => {
  const base = await tempBase()
  await seedTarget(base)
  withRegistry([['c1', { client: fakeClient(), via: 'v' }]])
  const { port, close } = await startServer({ receive: async () => 'stored', configured: () => false, config: () => undefined, baseDir: base })
  try {
    const { status, json } = await call(port, 'POST', '/dsh-iot/api/deliver', { targetId: 'lamp', text: 'hi' })
    assert.equal(status, 409)
    assert.equal(json.error, 'not-ready')
  } finally { await close() }
})

test('deliver：连接不在注册表 → 409 not-ready', async () => {
  const base = await tempBase()
  await seedTarget(base)
  withRegistry([])
  const { port, close } = await startServer({ receive: async () => 'stored', configured: () => true, config: () => undefined, baseDir: base })
  try {
    const { status, json } = await call(port, 'POST', '/dsh-iot/api/deliver', { targetId: 'lamp', text: 'hi' })
    assert.equal(status, 409)
    assert.equal(json.error, 'not-ready')
    assert.match(json.detail, /connection not ready: c1/)
  } finally { await close() }
})

test('deliver：receive 抛出 → 500 internal；filtered → 409 not-ready', async () => {
  const base = await tempBase()
  await seedTarget(base)
  withRegistry([['c1', { client: fakeClient(), via: 'v' }]])
  const { port, close } = await startServer({ receive: async () => { throw new Error('engine boom') }, configured: () => true, config: () => undefined, baseDir: base })
  try {
    const boom = await call(port, 'POST', '/dsh-iot/api/deliver', { targetId: 'lamp', text: 'hi' })
    assert.equal(boom.status, 500)
    assert.equal(boom.json.error, 'internal')
  } finally { await close() }
  const filtered = await startServer({ receive: async () => 'filtered', configured: () => true, config: () => undefined, baseDir: base })
  try {
    const res = await call(filtered.port, 'POST', '/dsh-iot/api/deliver', { targetId: 'lamp', text: 'hi' })
    assert.equal(res.status, 409)
    assert.equal(res.json.error, 'not-ready')
  } finally { await filtered.close() }
})

test('POST /api/deliver/test 直发：不经引擎，publishCommand 收到命令主题全名 + via 标记 + 双语文案', async () => {
  const base = await tempBase()
  await seedTarget(base)
  const published = []
  withRegistry([['c1', { client: fakeClient(async (topic, json) => { published.push({ topic, json }) }), via: 'dsh-superagent-iot:test-client' }]])
  const { port, close } = await startServer({ receive: async () => { throw new Error('engine must not be involved') }, configured: () => true, config: () => undefined, baseDir: base })
  try {
    const { status, json } = await call(port, 'POST', '/dsh-iot/api/deliver/test', { targetId: 'lamp' })
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.equal(json.sent, true)
    assert.match(json.detail, /cmd\/home\/lamp\/set/)
    assert.equal(published.length, 1)
    assert.equal(published[0].topic, 'cmd/home/lamp/set', '命令主题全名直发')
    const body = JSON.parse(published[0].json)
    assert.equal(body.via, 'dsh-superagent-iot:test-client', 'via 回环标记（自身 watch 会丢弃该消息）')
    assert.equal(body.text, DELIVER_TEST_TEXT)
    assert.match(body.text, /投递测试/)
    assert.match(body.text, /delivery test/)
  } finally { await close() }
})

test('deliver/test：发布失败 → 200 {ok,sent:false,detail}（测试结论而非 5xx）；未知目标 → 404', async () => {
  const base = await tempBase()
  await seedTarget(base)
  withRegistry([['c1', { client: fakeClient(async () => { throw new Error('broker offline') }), via: 'v' }]])
  const { port, close } = await startServer({ receive: async () => 'stored', configured: () => true, config: () => undefined, baseDir: base })
  try {
    const fail = await call(port, 'POST', '/dsh-iot/api/deliver/test', { targetId: 'lamp' })
    assert.equal(fail.status, 200)
    assert.equal(fail.json.sent, false)
    assert.match(fail.json.detail, /broker offline/)
    const missing = await call(port, 'POST', '/dsh-iot/api/deliver/test', { targetId: 'ghost' })
    assert.equal(missing.status, 404)
  } finally { await close() }
})

test('deliver/test：连接缺位 → sent:false detail 说明', async () => {
  const base = await tempBase()
  await seedTarget(base)
  withRegistry([])
  const { port, close } = await startServer({ receive: async () => 'stored', configured: () => true, config: () => undefined, baseDir: base })
  try {
    const res = await call(port, 'POST', '/dsh-iot/api/deliver/test', { targetId: 'lamp' })
    assert.equal(res.status, 200)
    assert.equal(res.json.sent, false)
    assert.match(res.json.detail, /connection not ready/)
  } finally { await close() }
})

test('buildDeliverTrigger：kind 仅接受 notice/reply 进 meta；非法 kind 忽略', () => {
  const withKind = buildDeliverTrigger('t', 'x', 'c', 'cmd', 'reply')
  assert.equal(withKind.meta.kind, 'reply')
  const badKind = buildDeliverTrigger('t', 'x', 'c', 'cmd', 'blast')
  assert.equal('kind' in badKind.meta, false)
})

test('ACL 判定 N/A 回归（CHANGELOG「判定为不适用」）：IotConfigSchema 无 §3 policy 字段（strict 拒绝），遥测入站路径不接用户 ACL', () => {
  // §3 用户 ACL policy 形状被 strict schema 拒绝：本包无命令类入站，不引入。
  assert.throws(() => IotConfigSchema.parse({ policy: { mode: 'allowlist', allowUsers: [] } }))
  // 唯一非遥测入站是 /dsh-iot/api/deliver 注入的非人类 Trigger（human:false），
  // 其访问控制由 webServer seam 同源闸门承担（见上方 403 测试），不走 broker 入站。
  const t = buildDeliverTrigger('t', 'x', 'c', 'cmd')
  assert.equal(t.human, false)
  assert.equal(t.source, 'iot')
})