/** Supervised MQTT watch: keeps one mqtt.js client per configured connection,
 *  upgrades incoming messages to Triggers through the alert / every / digest
 *  pipeline (retained + via loop-guard + payload cap + QoS1 dedup + rate
 *  limit), and reports iotMqtt health. MQTT has no mail-style UID cursor:
 *  clean-session realtime delivery is the M1 contract, so messages missed
 *  while offline are not replayed. */
import type { SourceContextLike, TriggerLike } from './types.ts'
import { flowStats, HEALTH_ENTRY, idOf, connectionRegistry, type AlertRule, type IotConfig, type IotConnection } from './iot-kind.ts'
import { connectIot, replyTopicFor, viaMarker, type IotClient, type MessagePacketLike } from './mqtt.ts'
import { compare, dotPath, hash8, matchTopicFilter } from './util.ts'

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    const stop = () => { clearTimeout(timer); resolve() }
    signal.addEventListener('abort', stop, { once: true })
  })
}

const SUPERVISE_MS = 5000
const DEDUP_TTL_MS = 60000
const DEDUP_MAX = 500

/** 60s LRU dedup absorbing QoS1 at-least-once redelivery. */
export class Deduper {
  private readonly seen = new Map<string, number>()
  hit(key: string, now: number = Date.now()): boolean {
    for (const [k, t] of this.seen) { if (now - t > DEDUP_TTL_MS) this.seen.delete(k) }
    if (this.seen.has(key)) return true
    this.seen.set(key, now)
    while (this.seen.size > DEDUP_MAX) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
    return false
  }
}

function parseJson(text: string): unknown {
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

/** Pre-filters applied before the pipeline: retained redelivery (configurable)
 *  and our own command echoes (via marker). Exported for the smoke because
 *  aedes strips the wire retain flag, so the retained path is unit-tested. */
export function isSelfOrRetained(packet: MessagePacketLike, ignoreRetained: boolean, ownVia: string, parsed: unknown): boolean {
  if (packet.retained && ignoreRetained) return true
  return Boolean(parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).via === ownVia)
}

/** 告警规则匹配（纯函数）：主题过滤 + dotPath 取值 + 数值校验 + 阈值比较；
 *  任一环未命中返回 undefined。 */
export function matchAlertRule(rule: AlertRule, topic: string, parsed: unknown): { rule: AlertRule; actual: number } | undefined {
  if (!matchTopicFilter(rule.topic, topic)) return undefined
  const actual = dotPath(parsed, rule.path)
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return undefined
  if (!compare(actual, rule.op, rule.value)) return undefined
  return { rule, actual }
}

/** 告警冷却放行（纯函数）：上次触发距今 ≥ cooldownSeconds 才放行，无记录视为放行。 */
export function alertCooldownOpen(lastSeen: number | undefined, now: number, cooldownSeconds: number): boolean {
  return now - (lastSeen ?? 0) >= cooldownSeconds * 1000
}

/** 摘要窗口到期（纯函数）：窗口时长下限 1s。 */
export function digestDue(windowStart: number, now: number, digestSeconds: number): boolean {
  return now - windowStart >= Math.max(1, digestSeconds) * 1000
}

/** 60s 滑动窗口限流（纯逻辑，now 可注入测试）：admit 返回是否放行。 */
export class RateWindow {
  private readonly times: number[] = []
  admit(now: number, max: number): boolean {
    while (this.times.length > 0 && now - this.times[0] > 60000) this.times.shift()
    if (this.times.length >= max) return false
    this.times.push(now)
    return true
  }
}

/** 健康 detail 追加紧凑流量计数：in=入站遥测（含重放）/ out=成功发布 /
 *  fail=发布失败 / last=最近一次失败时间（UTC HH:MM:SS，无则 '-'）。 */
export function withFlowDetail(base: string, stats: { in: number; out: number; fail: number; lastFailAt?: string }): string {
  const last = stats.lastFailAt ? stats.lastFailAt.slice(11, 19) : '-'
  const counters = 'in=' + stats.in + ' out=' + stats.out + ' fail=' + stats.fail + ' last=' + last
  return base ? base + ' ' + counters : counters
}

interface ActiveConn {
  id: string
  hash: string
  config: IotConnection
  client: IotClient
  via: string
  online: boolean
  lastError: string
  messages: number[]
}

interface DigestEntry { connId: string; topic: string; windowStart: number; items: { at: string; text: string }[] }

export async function watch(source: SourceContextLike, signal: AbortSignal): Promise<void> {
  const conns = new Map<string, ActiveConn>()
  const dedup = new Deduper()
  const digest = new Map<string, DigestEntry>()
  const alertCooldown = new Map<string, number>()
  const rateWindow = new RateWindow()
  let connectionFailures = ''
  let config: IotConfig | undefined
  source.report(HEALTH_ENTRY, { state: 'starting', detail: '' })

  const findConnection = (connId: string): IotConnection | undefined =>
    (config?.connections ?? []).find((c) => idOf(c) === connId)

  const buildTrigger = (conn: { id: string; config: IotConnection }, topic: string, text: string, meta: Record<string, unknown>): TriggerLike => {
    const at = new Date().toISOString()
    const address: Record<string, string> = { connection: conn.id, topic }
    const commandTopic = conn.config.commandTopic
    if (commandTopic) address.replyTopic = replyTopicFor(commandTopic, topic)
    const segment = conn.config.actorTopicSegment ? (topic.split('/')[conn.config.actorTopicSegment - 1] ?? '') : ''
    return {
      id: 'iot:' + conn.id + ':' + topic + ':' + at + ':' + hash8(text),
      source: 'iot',
      threads: [{ source: 'iot', id: 'iot:' + conn.id + ':' + topic }],
      actor: { source: 'iot', id: segment || 'device' },
      human: true,
      at,
      text,
      channel: { source: 'iot', thread: 'iot:' + conn.id + ':' + topic, address },
      meta: { connectionId: conn.id, topic, ...meta },
    }
  }

  const emit = async (trigger: TriggerLike): Promise<void> => {
    try { await source.receive(trigger) } catch { /* a receive failure must not kill the watch */ }
  }

  const admitTrigger = (now: number): boolean => rateWindow.admit(now, config?.maxTriggersPerMinute ?? 20)

  const accumulate = (connId: string, topic: string, text: string): void => {
    const key = connId + '|' + topic
    let entry = digest.get(key)
    if (!entry) { entry = { connId, topic, windowStart: Date.now(), items: [] }; digest.set(key, entry) }
    entry.items.push({ at: new Date().toISOString(), text: text.slice(0, 200) })
  }

  const flushDigest = async (key: string, entry: DigestEntry): Promise<void> => {
    digest.delete(key)
    const count = entry.items.length
    if (count === 0) return
    const cfg = findConnection(entry.connId)
    if (!cfg) return
    const recent = entry.items.slice(-5).map((item) => '- [' + item.at + '] ' + item.text).join('\n')
    const text = 'iot 摘要 ' + count + ' 条（' + entry.items[0].at + ' ~ ' + entry.items[count - 1].at + '）\n' + recent
    await emit(buildTrigger({ id: entry.connId, config: cfg }, entry.topic, text, { digest: true, count }))
  }

  const flushExpired = async (now: number): Promise<void> => {
    for (const [key, entry] of [...digest]) {
      const cfg = findConnection(entry.connId)
      if (!cfg) { digest.delete(key); continue }
      if (digestDue(entry.windowStart, now, cfg.digestSeconds)) await flushDigest(key, entry)
    }
  }

  const handleMessage = (conn: ActiveConn, topic: string, payload: Buffer, packet: MessagePacketLike): void => {
    const cfg = config
    if (!cfg) return
    flowStats.in += 1
    conn.messages.push(Date.now())
    if (payload.length > cfg.payloadMaxBytes) return
    const text = payload.toString('utf8')
    const parsed = parseJson(text)
    if (isSelfOrRetained(packet, cfg.ignoreRetained, conn.via, parsed)) return
    if (dedup.hit(topic + '|' + (packet.messageId ?? '') + '|' + hash8(text))) return
    if (parsed && typeof parsed === 'object') {
      const rules = conn.config.alerts ?? []
      for (let index = 0; index < rules.length; index++) {
        const hit = matchAlertRule(rules[index], topic, parsed)
        if (!hit) continue
        const cooldownKey = conn.id + ':' + index + ':' + hit.rule.topic + ':' + hit.rule.path + ':' + hit.rule.op + ':' + hit.rule.value
        const now = Date.now()
        if (!alertCooldownOpen(alertCooldown.get(cooldownKey), now, hit.rule.cooldownSeconds)) continue
        alertCooldown.set(cooldownKey, now)
        const label = hit.rule.label || hit.rule.path
        void emit(buildTrigger(conn, topic, '[iot-alert] ' + label + ' ' + hit.rule.op + ' ' + hit.rule.value + '（实际 ' + hit.actual + '）\n' + text, { alert: label, value: hit.actual }))
        return
      }
    }
    if (conn.config.mode === 'digest') { accumulate(conn.id, topic, text); return }
    if (!admitTrigger(Date.now())) { accumulate(conn.id, topic, text); return }
    void emit(buildTrigger(conn, topic, text, {}))
  }

  const syncConnections = async (): Promise<void> => {
    const cfg = config
    if (!cfg) return
    const wanted = new Map<string, string>()
    for (const c of cfg.connections) wanted.set(idOf(c), hash8(JSON.stringify(c)))
    for (const [id, active] of [...conns]) {
      if (wanted.get(id) !== active.hash) { conns.delete(id); await active.client.end() }
    }
    for (const c of cfg.connections) {
      const id = idOf(c)
      if (conns.has(id)) continue
      const ref: { current?: ActiveConn } = {}
      let client: IotClient
      try {
        client = connectIot(c, {
          onMessage: (topic, payload, packet) => { if (ref.current) handleMessage(ref.current, topic, payload, packet) },
          onStatus: (online, error) => { if (ref.current) { ref.current.online = online; if (error) ref.current.lastError = error } },
        })
      } catch (error) {
        connectionFailures = String(error).slice(0, 300)
        continue
      }
      ref.current = { id, hash: wanted.get(id) ?? '', config: c, client, via: viaMarker(client.clientId), online: false, lastError: '', messages: [] }
      conns.set(id, ref.current)
    }
    connectionRegistry.current = new Map([...conns].map(([id, a]) => [id, { client: a.client, via: a.via }]))
  }

  const reportHealth = (): void => {
    const now = Date.now()
    let online = 0
    let msgs = 0
    for (const a of conns.values()) {
      if (a.online) online++
      msgs += a.messages.filter((t) => now - t <= 60000).length
      if (a.messages.length > 1000) a.messages.splice(0, a.messages.length - 1000)
    }
    const values = { connections: String(conns.size), online: String(online), msgPerMin: String(msgs) }
    if (conns.size === 0) source.report(HEALTH_ENTRY, { state: 'paused', detail: 'waiting for connection configuration', values })
    else if (online > 0) source.report(HEALTH_ENTRY, { state: 'ready', detail: withFlowDetail('', flowStats), values })
    else {
      const failed = [...conns.values()].find((a) => a.lastError)
      source.report(HEALTH_ENTRY, { state: 'error', detail: withFlowDetail(failed?.lastError || connectionFailures || 'connecting…', flowStats), values })
    }
  }

  try {
    while (!signal.aborted) {
      try {
        config = source.config<IotConfig>('iot')
        if (config && (config.connections ?? []).length > 0) await syncConnections()
        else {
          for (const [, a] of conns) await a.client.end()
          conns.clear()
          connectionRegistry.current = new Map()
        }
        await flushExpired(Date.now())
        reportHealth()
      } catch (error) {
        source.report(HEALTH_ENTRY, { state: 'error', detail: String(error).slice(0, 300) })
      }
      await pause(SUPERVISE_MS, signal)
    }
  } finally {
    for (const [key, entry] of [...digest]) {
      try { await flushDigest(key, entry) } catch { /* best effort on teardown */ }
    }
    for (const [, a] of conns) await a.client.end()
  }
}