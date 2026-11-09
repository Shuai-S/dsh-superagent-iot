/** Offline smoke for dsh-superagent-iot against an embedded aedes broker.
 *  Covers: schema preprocess, Aliyun/Tencent signing cross-checks, every-mode
 *  trigger, digest window, alert + cooldown, command publish via channel.send,
 *  via loop-guard, retained drop, dedup and topic-filter units.
 *  Run: pnpm smoke  (tsx; no real cloud credentials involved) */
import net from 'node:net'
import crypto from 'node:crypto'
import Aedes from 'aedes'
import { connect as mqttConnect, type MqttClient } from 'mqtt'
import { watch, Deduper, isSelfOrRetained } from '../src/watch.ts'
import { iotKind, IotConfigSchema } from '../src/iot-kind.ts'
import { aliyunMqttAuth, tencentMqttAuth } from '../src/auth.ts'
import { matchTopicFilter } from '../src/util.ts'
import type { Health, SourceContextLike, TriggerLike } from '../src/types.ts'

let failures = 0

function assert(condition: unknown, message: string): void {
  if (condition) { console.log('  PASS ' + message); return }
  failures++
  console.log('  FAIL ' + message)
}

async function waitFor(condition: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return condition()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface TestSource extends SourceContextLike {
  triggers: TriggerLike[]
  health: { entry: string; health: Health }[]
}

function fakeSource(config: unknown): TestSource {
  const source = {
    triggers: [],
    health: [],
    deployment: { repository: 'smoke' },
    configured: () => true,
    config: (kind: string) => (kind === 'iot' ? config : undefined),
    receive: (trigger: TriggerLike) => { source.triggers.push(trigger); return {} },
    threads: { describe: () => {}, patch: () => {} },
    report: (entry: string, health: Health) => { source.health.push({ entry, health }) },
  } as unknown as TestSource
  return source
}

async function startBroker(): Promise<{ url: string; close: () => Promise<void> }> {
  const broker = new Aedes()
  const server = net.createServer(broker.handle as unknown as (socket: net.Socket) => void)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as net.AddressInfo).port
  return {
    url: 'mqtt://127.0.0.1:' + port,
    close: () => new Promise<void>((resolve) => server.close(() => broker.close(() => resolve()))),
  }
}

interface Publisher {
  inbox: { topic: string; payload: string }[]
  publish(topic: string, payload: string, options?: { qos?: 0 | 1; retain?: boolean }): Promise<void>
  subscribe(filter: string): Promise<void>
  end(): Promise<void>
  connected(): boolean
}

function publisher(url: string): Publisher {
  const client: MqttClient = mqttConnect(url, { clientId: 'smoke-pub-' + crypto.randomBytes(3).toString('hex'), clean: true, protocolVersion: 4 })
  const inbox: { topic: string; payload: string }[] = []
  client.on('message', (topic: string, payload: Buffer) => { inbox.push({ topic, payload: payload.toString('utf8') }) })
  return {
    inbox,
    connected: () => client.connected,
    publish: (topic, payload, options = {}) => new Promise<void>((resolve, reject) => client.publish(topic, payload, { qos: options.qos ?? 1, retain: options.retain ?? false }, (error) => (error ? reject(error) : resolve()))),
    subscribe: (filter) => new Promise<void>((resolve) => client.subscribe(filter, { qos: 1 }, () => resolve())),
    end: () => new Promise<void>((resolve) => client.end(true, () => resolve())),
  }
}

async function runWatch(config: unknown): Promise<{ source: TestSource; stop: () => Promise<void> }> {
  const source = fakeSource(config)
  const controller = new AbortController()
  const running = watch(source, controller.signal)
  return {
    source,
    stop: async () => { controller.abort(); await running },
  }
}

const readyIn = (source: TestSource) => waitFor(() => source.health.some((h) => h.health.state === 'ready'), 10000)

function scenarioSchema(): void {
  console.log('scenario 6: config schema preprocess')
  const parsed = IotConfigSchema.parse({
    connections: [{ name: 'p', url: 'mqtt://x:1883', topics: 'a/+/b, c/#', alerts: '[{"topic":"a/+/b","path":"v","op":">","value":1,"label":"x"}]', qos: '1' }],
  })
  const conn = parsed.connections[0]
  assert(Array.isArray(conn.topics) && conn.topics.length === 2, 'topics string splits to array')
  assert(conn.alerts.length === 1 && conn.alerts[0].value === 1, 'alerts JSON string parses')
  assert(conn.qos === 1, 'qos string coerces to 1')
  assert(parsed.maxTriggersPerMinute === 20 && parsed.ignoreRetained === true, 'global defaults applied')
}

function scenarioAuth(): void {
  console.log('scenario 7: aliyun/tencent signing cross-check')
  const a = aliyunMqttAuth({ productKey: 'pk1', deviceName: 'dev1', deviceSecret: 'sec1', clientId: 'abc|legacy' })
  assert(a.username === 'dev1&pk1', 'aliyun username is deviceName&productKey')
  const match = /timestamp=(\d+)/.exec(a.clientId)
  const ts = match ? Number(match[1]) : 0
  const expected = crypto.createHmac('sha256', 'sec1').update('clientIdabcdeviceNamedev1productKeypk1timestamp' + ts).digest('hex')
  assert(a.password === expected, 'aliyun password = HMAC-SHA256(deviceSecret, dictionary-ordered content)')
  assert(a.clientId.startsWith('abc|securemode=3,signmethod=hmacsha256,timestamp='), 'aliyun client id carries securemode/signmethod/timestamp tail')
  const b64Secret = Buffer.from('raw-secret-bytes-0123456789ab').toString('base64')
  const t = tencentMqttAuth({ productId: 'pid', deviceName: 'dn', deviceSecret: b64Secret })
  assert(t.clientId === 'piddn', 'tencent clientId is productId+deviceName')
  assert(t.username.startsWith('piddn;12010126;'), 'tencent username carries fixed sdkappid 12010126')
  const expectedT = crypto.createHmac('sha256', Buffer.from(b64Secret, 'base64')).update(t.username).digest('hex')
  assert(t.password === expectedT + ';hmacsha256', 'tencent password = HMAC over base64-decoded key + ;signmethod')
  const t2 = tencentMqttAuth({ productId: 'pid', deviceName: 'dn', deviceSecret: 'not base64!!' })
  const expected2 = crypto.createHmac('sha256', 'not base64!!').update(t2.username).digest('hex')
  assert(t2.password === expected2 + ';hmacsha256', 'tencent raw-key fallback when secret is not base64')
}

async function scenarioEvery(): Promise<void> {
  console.log('scenario 1: every mode -> immediate trigger')
  const broker = await startBroker()
  const pub = publisher(broker.url)
  await waitFor(() => pub.connected(), 5000)
  const config = {
    connections: [{ name: 'c1', url: broker.url, topics: ['home/+/temp'], mode: 'every', qos: 1, clientId: 'smoke-1', commandTopic: 'cmd/{topic}', actorTopicSegment: 2 }],
    maxTriggersPerMinute: 20,
    ignoreRetained: true,
    payloadMaxBytes: 65536,
  }
  const { source, stop } = await runWatch(config)
  assert(await readyIn(source), 'health reaches ready')
  await pub.publish('home/living/temp', '{"temp":21}')
  assert(await waitFor(() => source.triggers.length >= 1, 5000), 'trigger received')
  const t = source.triggers[0]
  assert(t.source === 'iot' && t.human === true, 'trigger is iot/human')
  assert(t.text.includes('"temp":21'), 'trigger text carries payload')
  assert(t.threads.length === 1 && t.threads[0].id === 'iot:c1:home/living/temp', 'thread id is conn+topic')
  assert(t.actor.id === 'living', 'actor segment extraction (topic level 2)')
  assert(t.channel.address.connection === 'c1', 'address.connection set')
  assert(t.channel.address.replyTopic === 'cmd/home/living/temp', 'replyTopic {topic} placeholder expanded')
  assert(t.meta.topic === 'home/living/temp', 'meta.topic set')
  await stop()
  await pub.end()
  await broker.close()
}

async function scenarioDigest(): Promise<void> {
  console.log('scenario 2: digest window -> one summary trigger')
  const broker = await startBroker()
  const pub = publisher(broker.url)
  await waitFor(() => pub.connected(), 5000)
  const config = {
    connections: [{ name: 'c2', url: broker.url, topics: ['dev/#'], mode: 'digest', digestSeconds: 5, qos: 1 }],
    maxTriggersPerMinute: 20,
    ignoreRetained: true,
    payloadMaxBytes: 65536,
  }
  const { source, stop } = await runWatch(config)
  assert(await readyIn(source), 'health reaches ready')
  await pub.publish('dev/sensor/a', '{"v":1}')
  await pub.publish('dev/sensor/a', '{"v":2}')
  await pub.publish('dev/sensor/a', '{"v":3}')
  assert(await waitFor(() => source.triggers.length >= 1, 12000), 'digest trigger flushed at window end')
  await sleep(300)
  assert(source.triggers.length === 1, 'exactly one summary trigger, got ' + source.triggers.length)
  const t = source.triggers[0]
  assert(t.meta.digest === true && t.meta.count === 3, 'summary carries digest count 3')
  assert(t.text.includes('3 条'), 'summary text mentions item count')
  assert(t.threads[0].id === 'iot:c2:dev/sensor/a', 'digest thread keyed by (conn, topic)')
  await stop()
  await pub.end()
  await broker.close()
}

async function scenarioAlert(): Promise<void> {
  console.log('scenario 3: alert fires immediately, cooldown suppresses repeats')
  const broker = await startBroker()
  const pub = publisher(broker.url)
  await waitFor(() => pub.connected(), 5000)
  const config = {
    connections: [{ name: 'c3', url: broker.url, topics: ['home/+/temp'], mode: 'digest', digestSeconds: 5, qos: 1,
      alerts: [{ topic: 'home/+/temp', path: 'temp', op: '>', value: 30, label: '高温', cooldownSeconds: 60 }] }],
    maxTriggersPerMinute: 20,
    ignoreRetained: true,
    payloadMaxBytes: 65536,
  }
  const { source, stop } = await runWatch(config)
  assert(await readyIn(source), 'health reaches ready')
  await pub.publish('home/room/temp', '{"temp":35}')
  assert(await waitFor(() => source.triggers.some((t) => t.meta.alert === '高温'), 5000), 'alert trigger immediate (bypasses digest)')
  await pub.publish('home/room/temp', '{"temp":36}')
  await sleep(600)
  const alerts = source.triggers.filter((t) => t.meta.alert === '高温')
  assert(alerts.length === 1, 'cooldown suppresses second alert within 60s, got ' + alerts.length)
  assert(alerts[0].text.includes('高温') && alerts[0].text.includes('35'), 'alert text carries label and actual value')
  await stop()
  await pub.end()
  await broker.close()
}

async function scenarioCommand(): Promise<void> {
  console.log('scenario 4: channel.send publishes command with via marker')
  const broker = await startBroker()
  const pub = publisher(broker.url)
  await waitFor(() => pub.connected(), 5000)
  await pub.subscribe('cmd/#')
  const config = {
    connections: [{ name: 'c4', url: broker.url, topics: ['home/+/temp'], mode: 'every', qos: 1, clientId: 'smoke-4', commandTopic: 'cmd/{topic}' }],
    maxTriggersPerMinute: 20,
    ignoreRetained: true,
    payloadMaxBytes: 65536,
  }
  const { source, stop } = await runWatch(config)
  assert(await readyIn(source), 'health reaches ready')
  await pub.publish('home/room/temp', '{"temp":22}')
  assert(await waitFor(() => source.triggers.length >= 1, 5000), 'trigger received (reply path precondition)')
  const channel = (iotKind as unknown as { channel: { send(host: unknown, message: unknown): Promise<string> } }).channel
  const result = await channel.send(null, {
    id: 'm1',
    channel: { source: 'iot', thread: 'iot:c4:home/room/temp', address: { connection: 'c4', replyTopic: 'cmd/{topic}', topic: 'home/room/temp' } },
    text: '打开空调',
    kind: 'reply',
  })
  assert(result === 'sent', 'channel.send returns sent')
  assert(await waitFor(() => pub.inbox.some((m) => m.topic === 'cmd/home/room/temp'), 5000), 'command arrives on expanded topic')
  const command = pub.inbox.find((m) => m.topic === 'cmd/home/room/temp')
  const body = JSON.parse(command?.payload ?? '{}') as { via: string; text: string }
  assert(body.via === 'dsh-superagent-iot:smoke-4', 'via marker is dsh-superagent-iot:clientId')
  assert(body.text === '打开空调', 'command text preserved')
  let rejected = false
  try {
    await channel.send(null, { id: 'm2', channel: { source: 'iot', thread: 'x', address: { connection: 'ghost', replyTopic: 'cmd/x', topic: 'x' } }, text: 'no', kind: 'reply' })
  } catch { rejected = true }
  assert(rejected, 'unknown connection rejects')
  await stop()
  await pub.end()
  await broker.close()
}

async function scenarioGuards(): Promise<void> {
  console.log('scenario 5: via loop-guard, dedup/filter/retained/health units')
  const broker = await startBroker()
  const pub = publisher(broker.url)
  await waitFor(() => pub.connected(), 5000)
  const config = {
    connections: [{ name: 'c5', url: broker.url, topics: ['lg/#'], mode: 'every', qos: 1, clientId: 'smoke-5' }],
    maxTriggersPerMinute: 20,
    ignoreRetained: true,
    payloadMaxBytes: 65536,
  }
  const { source, stop } = await runWatch(config)
  assert(await readyIn(source), 'health reaches ready')
  await sleep(300)
  const baseline = source.triggers.length
  await pub.publish('lg/x', '{"v":1}')
  assert(await waitFor(() => source.triggers.length > baseline, 5000), 'normal message still triggers')
  const before = source.triggers.length
  await pub.publish('lg/x', '{"via":"dsh-superagent-iot:smoke-5","text":"self"}')
  await sleep(800)
  assert(source.triggers.length === before, 'own via marker message dropped')
  const last = source.health[source.health.length - 1]?.health
  assert(last?.values?.connections === '1' && last?.values?.online === '1', 'health values report connections/online')
  const deduper = new Deduper()
  assert(deduper.hit('k') === false && deduper.hit('k') === true, 'Deduper suppresses repeat key')
  assert(isSelfOrRetained({ retained: true }, true, 'm', undefined) === true, 'retained drop when ignoreRetained on')
  assert(isSelfOrRetained({ retained: false }, true, 'm', { via: 'm' }) === true, 'own via payload dropped')
  assert(isSelfOrRetained({ retained: false }, true, 'm', { via: 'other' }) === false, 'foreign via payload kept')
  assert(isSelfOrRetained({ retained: true }, false, 'm', undefined) === false, 'retained kept when ignoreRetained off')
  assert(matchTopicFilter('home/+/temp', 'home/a/temp') === true, 'filter: + matches one level')
  assert(matchTopicFilter('home/#', 'home/a/b') === true, 'filter: # matches rest')
  assert(matchTopicFilter('home/+/temp', 'home/a/b') === false, 'filter: depth mismatch rejected')
  assert(matchTopicFilter('home/+', 'home/a/b') === false, 'filter: + is exact depth only')
  await stop()
  await pub.end()
  await broker.close()
}

async function main(): Promise<void> {
  console.log('dsh-superagent-iot smoke (embedded aedes broker, no real cloud credentials)')
  scenarioSchema()
  scenarioAuth()
  await scenarioEvery()
  await scenarioDigest()
  await scenarioAlert()
  await scenarioCommand()
  await scenarioGuards()
  console.log('')
  if (failures > 0) {
    console.log('SMOKE FAILED: ' + failures + ' assertion(s) red')
    process.exitCode = 1
  } else {
    console.log('SMOKE PASSED: all assertions green')
  }
}

await main()