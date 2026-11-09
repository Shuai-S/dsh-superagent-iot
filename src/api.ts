/** /dsh-iot/api routes on the engine panel webServer seam (rpc-contract.md §1/§2,
 *  P-B 主动投递一期). Seam usage mirrors dsh-superagent-wechat bind-panel: the engine
 *  registers its own management API via ctx.webServer.register({kind:'prefix'}), and
 *  third-party cordis plugins with inject ['webServer'] share that seam; the gate is
 *  the seam owner's sameOrigin semantics (loopback Host + x-orchestrator-request +
 *  Origin check) — no new auth. Routes:
 *  - POST /api/deliver      {targetId, text, kind?} → non-human Trigger (human:false,
 *    meta.deliver=true, actor='iot', addressed:'direct', meta.connectionId) →
 *    source.receive(); the engine's reply flows back over the existing
 *    channel.send → publishCommand chain to the target's command topic.
 *    收件即受理：{ok:true, accepted:true, triggerId}，不承诺完成。
 *  - POST /api/deliver/test {targetId} → no engine involved; direct publishCommand of
 *    a bilingual test text with the via loop-guard marker. {ok, sent, detail}.
 *  - GET  /api/health       counts (in/out/fail/deny + deliver) + connection snapshot
 *    + target count + recent failure-log entries.
 *  ACL note (rpc-contract.md §3): the iot source has no human/command-class broker
 *  inbound — telemetry is not subject to ACL and the only non-telemetry inbound is
 *  this seam-gated deliver path. Judged N/A; see CHANGELOG「判定为不适用」. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TriggerLike } from './types.ts'
import type { IotConfig } from './iot-kind.ts'
import { connectionRegistry, flowStats, idOf } from './iot-kind.ts'
import { getTarget, readTargets, touchTarget, validTargetId, type TargetRecord } from './targets.ts'
import { readSendFailures } from './failure-log.ts'
import { hash8 } from './util.ts'

/** @deepseek-ai/dsh-host-webserver 的结构化最小面（不引入包依赖；与 wechat bind-panel 同款）。 */
export interface WebServerLike {
  readonly port: number
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 路由依赖注入点（测试直接喂 fake；运行时由 index.apply 用 orchestrator.source 组装）。 */
export interface ApiDeps {
  receive: (trigger: TriggerLike) => unknown | Promise<unknown>
  configured: () => boolean
  config: () => IotConfig | undefined
  /** 目标表/failure-log 根目录覆盖（缺省 ~/.local/state/dsh-superagent-iot）。 */
  baseDir?: string
}

/** deliver 端点计数（进程生命周期内累计；GET /api/health 读取）。 */
export const deliverStats = { accepted: 0, failed: 0 }

/** 路由前缀（契约 §1 统一前缀；verify-package.mjs 以该字面量做防漂移探针）。 */
export const API_PREFIX = '/dsh-iot/api'

/** 双语投递测试文案（deliver/test 直发，不经引擎）。 */
export const DELIVER_TEST_TEXT = '【dsh-superagent-iot 投递测试】命令主题路由正常，本条为投递测试消息。\n[dsh-superagent-iot delivery test] Command-topic routing works; this is a delivery test message.'

/** JSON 请求体上限（deliver 文本经此自然限长）。 */
const MAX_BODY_BYTES = 64 * 1024
/** health 返回的 failure-log 条数（契约 §1：最近 20 条发送失败）。 */
const HEALTH_FAILURES = 20

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 引擎同款同源闸门（dsh-superagent src/app/http.ts sameOrigin 的镜像实现，与
 *  wechat bind-panel 同一版）：Host 必须 loopback:<port>，x-orchestrator-request
 *  必须为 '1'，Origin 缺省或同源。 */
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return false
  return req.headers['x-orchestrator-request'] === '1' &&
    (req.headers.origin === undefined || req.headers.origin === 'http://' + host)
}

/** 解析目标路由连接：address.connection 显式优先；省略且仅配一个连接时自动取用
 *  （多连接必须显式，返回空串由调用方报 400）。 */
export function resolveConnection(target: TargetRecord, config: IotConfig | undefined): string {
  const explicit = String(target.address.connection ?? '').trim()
  if (explicit) return explicit
  const connections = config?.connections ?? []
  return connections.length === 1 ? idOf(connections[0]) : ''
}

/** 构造非人类投递 Trigger（契约 §2：human:false、meta.deliver=true、actor='iot'）。
 *  addressed:'direct' 与 meta.connectionId 是引擎链路的硬要求：machineGate 的 scope
 *  检查要求 addressed（iot scope observed=false），intake 的 scope 过滤按
 *  meta.connectionId 判 listened（缺失会被静默 disposition 为 filtered）。 */
export function buildDeliverTrigger(targetId: string, text: string, connId: string, topic: string, kind?: unknown): TriggerLike {
  const at = new Date().toISOString()
  const meta: Record<string, unknown> = { deliver: true, targetId, connectionId: connId }
  if (kind === 'notice' || kind === 'reply') meta.kind = kind
  return {
    id: 'iot:deliver:' + targetId + ':' + at + ':' + hash8(text),
    source: 'iot',
    threads: [{ source: 'iot', id: 'iot:deliver:' + targetId }],
    actor: { source: 'iot', id: 'iot' },
    human: false,
    addressed: 'direct',
    at,
    text,
    channel: { source: 'iot', thread: 'iot:deliver:' + targetId, address: { connection: connId, replyTopic: topic } },
    meta,
  }
}

async function handleDeliver(req: IncomingMessage, res: ServerResponse, deps: ApiDeps & { port: number }): Promise<void> {
  let body: { targetId?: unknown; text?: unknown; kind?: unknown } = {}
  try {
    const raw = await readBody(req)
    if (raw.trim()) body = JSON.parse(raw) as { targetId?: unknown; text?: unknown; kind?: unknown }
  } catch {
    respondJson(res, 400, { error: 'bad-request', detail: 'invalid JSON body' })
    return
  }
  if (!validTargetId(body.targetId)) {
    respondJson(res, 400, { error: 'bad-request', detail: 'targetId must match [A-Za-z0-9._@:-]{1,128}' })
    return
  }
  const text = typeof body.text === 'string' ? body.text : ''
  if (!text.trim()) {
    respondJson(res, 400, { error: 'bad-request', detail: 'text required' })
    return
  }
  const target = await getTarget(body.targetId, deps.baseDir)
  if (!target) {
    respondJson(res, 404, { error: 'unknown-target' })
    return
  }
  const topic = target.address.topic.trim()
  if (!topic) {
    respondJson(res, 400, { error: 'bad-request', detail: 'target address.topic missing' })
    return
  }
  if (!deps.configured()) {
    respondJson(res, 409, { error: 'not-ready', detail: 'iot source not configured' })
    return
  }
  const connId = resolveConnection(target, deps.config())
  if (!connId) {
    respondJson(res, 400, { error: 'bad-request', detail: 'target address.connection required when multiple connections are configured' })
    return
  }
  if (!connectionRegistry.current.has(connId)) {
    respondJson(res, 409, { error: 'not-ready', detail: 'iot: connection not ready: ' + connId })
    return
  }
  const trigger = buildDeliverTrigger(target.id, text, connId, topic, body.kind)
  let result: unknown
  try {
    result = await deps.receive(trigger)
  } catch (error) {
    deliverStats.failed += 1
    respondJson(res, 500, { error: 'internal', detail: String(error).slice(0, 200) })
    return
  }
  // 引擎 scope 过滤拒绝（正常已被上面的注册表预检挡下，这里兜底竞态）。
  if (result === 'filtered') {
    deliverStats.failed += 1
    respondJson(res, 409, { error: 'not-ready', detail: 'iot: connection not configured: ' + connId })
    return
  }
  deliverStats.accepted += 1
  await touchTarget(target.id, trigger.at, deps.baseDir)
  respondJson(res, 200, { ok: true, accepted: true, triggerId: trigger.id })
}

async function handleDeliverTest(req: IncomingMessage, res: ServerResponse, deps: ApiDeps & { port: number }): Promise<void> {
  let body: { targetId?: unknown } = {}
  try {
    const raw = await readBody(req)
    if (raw.trim()) body = JSON.parse(raw) as { targetId?: unknown }
  } catch {
    respondJson(res, 400, { error: 'bad-request', detail: 'invalid JSON body' })
    return
  }
  if (!validTargetId(body.targetId)) {
    respondJson(res, 400, { error: 'bad-request', detail: 'targetId must match [A-Za-z0-9._@:-]{1,128}' })
    return
  }
  const target = await getTarget(body.targetId, deps.baseDir)
  if (!target) {
    respondJson(res, 404, { error: 'unknown-target' })
    return
  }
  const topic = target.address.topic.trim()
  if (!topic) {
    respondJson(res, 400, { error: 'bad-request', detail: 'target address.topic missing' })
    return
  }
  const connId = resolveConnection(target, deps.config())
  if (!connId) {
    respondJson(res, 400, { error: 'bad-request', detail: 'target address.connection required when multiple connections are configured' })
    return
  }
  // 直调 publish（不经引擎）；发布失败是测试结论之一（sent:false），不是 5xx。
  try {
    const entry = connectionRegistry.current.get(connId)
    if (!entry) throw new Error('iot: connection not ready: ' + connId)
    await entry.client.publishCommand(topic, JSON.stringify({ via: entry.via, text: DELIVER_TEST_TEXT }))
    await touchTarget(target.id, new Date().toISOString(), deps.baseDir)
    respondJson(res, 200, { ok: true, sent: true, detail: 'published to ' + topic })
  } catch (error) {
    respondJson(res, 200, { ok: true, sent: false, detail: String(error).slice(0, 200) })
  }
}

async function handleHealth(res: ServerResponse, deps: ApiDeps & { port: number }): Promise<void> {
  const [targets, failures] = await Promise.all([readTargets(deps.baseDir), readSendFailures(HEALTH_FAILURES, deps.baseDir)])
  let online = 0
  for (const [, entry] of connectionRegistry.current) {
    if (entry.client.connected()) online += 1
  }
  respondJson(res, 200, {
    ok: true,
    counts: {
      in: flowStats.in,
      out: flowStats.out,
      fail: flowStats.fail,
      deny: 0, // ACL 判定不适用（无命令类入站，CHANGELOG「判定为不适用」），恒 0 保形
      deliverAccepted: deliverStats.accepted,
      deliverFailed: deliverStats.failed,
    },
    lastFailAt: flowStats.lastFailAt || undefined,
    connections: { total: connectionRegistry.current.size, online },
    targets: targets.targets.length,
    recentFailures: failures,
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ApiDeps & { port: number }): Promise<void> {
  if (!sameOrigin(req, deps.port)) {
    respondJson(res, 403, { error: 'Same-origin management request required' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (!url.pathname.startsWith(API_PREFIX + '/')) {
    respondJson(res, 404, { error: 'not found' })
    return
  }
  const path = url.pathname.slice(API_PREFIX.length)
  if (path === '/health' && req.method === 'GET') { await handleHealth(res, deps); return }
  if (path === '/deliver' && req.method === 'POST') { await handleDeliver(req, res, deps); return }
  if (path === '/deliver/test' && req.method === 'POST') { await handleDeliverTest(req, res, deps); return }
  respondJson(res, 404, { error: 'not found' })
}

/** 路由处理器（测试注入点：直接拿 handler 挂在任意 http server 上）。 */
export function createApiHandler(deps: ApiDeps & { port: number }): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    await handle(req, res, deps)
  }
}

/** 在引擎 webserver 上注册 /dsh-iot/api 前缀路由，返回卸载 disposer。 */
export function registerApiRoutes(webServer: WebServerLike, deps: ApiDeps): () => void {
  const handler = createApiHandler({ ...deps, port: webServer.port })
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => {
      handler(req, res).catch((error: unknown) => {
        // 只记错误码级信息，绝不落请求体（text 可能含业务内容）。
        console.error('[iot] api request error: ' + String(error).slice(0, 200))
        respondJson(res, 500, { error: 'internal', detail: 'request handler failed' })
      })
    },
  })
}
