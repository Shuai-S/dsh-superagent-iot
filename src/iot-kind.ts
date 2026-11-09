/** The 'iot' Source kind: MQTT connections whose telemetry upgrades to
 *  tickets (alert / every / digest); replies publish to command topics.
 *  Contract shape mirrors the mail kind exactly (schema/fields/health/scope/
 *  channel/threadContext/policy). */
import { z } from 'zod'
import type { OutboundMessageLike, TriggerLike } from './types.ts'
import { emptyLink } from './robot-helpers.ts'
import type { IotClient } from './mqtt.ts'

export const HEALTH_ENTRY = 'iotMqtt'

/** 标识留空时回退到 url：多连接场景少填一项。 */
export const idOf = (conn: IotConnection): string => conn.name || conn.url

/** Connection registry refreshed by the watch supervisor; channel.send reads it. */
export const connectionRegistry: { current: Map<string, { client: IotClient; via: string }> } = { current: new Map() }

export interface AlertRule {
  topic: string
  path: string
  op: '>' | '>=' | '<' | '<=' | '==' | '!='
  value: number
  label: string
  cooldownSeconds: number
}

export interface IotConnection {
  name: string
  url: string
  username: string
  password: string
  clientId: string
  auth: 'password' | 'aliyun' | 'tencent'
  productKey: string
  productId: string
  deviceName: string
  deviceSecret: string
  signMethod: 'hmacsha1' | 'hmacsha256'
  securemode: 2 | 3
  topics: string[]
  commandTopic: string
  qos: 0 | 1
  mode: 'every' | 'digest'
  digestSeconds: number
  actorTopicSegment?: number
  alerts: AlertRule[]
}

export interface IotConfig {
  connections: IotConnection[]
  maxTriggersPerMinute: number
  ignoreRetained: boolean
  payloadMaxBytes: number
}

// Console rows columns carry strings; these preprocessors coerce text into
// the structured shapes the schema wants (topics split, alerts JSON, enums).
const toTopics = (value: unknown): unknown =>
  typeof value === 'string' ? value.split(/[,\s]+/).filter(Boolean) : value

const toAlerts = (value: unknown): unknown => {
  if (typeof value !== 'string' || !value.trim()) return []
  try { return JSON.parse(value) } catch { return [] }
}

const toQos = (value: unknown): unknown => (value === '0' || value === 0 ? 0 : value === '1' || value === 1 ? 1 : value)

const toSecuremode = (value: unknown): unknown => (value === 2 || value === '2' ? 2 : 3)

const toOptionalInt = (value: unknown): unknown => {
  if (value === '' || value == null) return undefined
  const n = Number(value)
  return Number.isInteger(n) ? n : undefined
}

const toBool = (value: unknown): unknown => {
  if (value === 'false' || value === 0 || value === false) return false
  if (value === 'true' || value === 1 || value === true) return true
  return value
}

const AlertRuleSchema = z.object({
  topic: z.string().min(1),
  path: z.string().min(1),
  op: z.enum(['>', '>=', '<', '<=', '==', '!=']),
  value: z.number(),
  label: z.string().default(''),
  cooldownSeconds: z.number().int().min(0).max(86400).default(300),
})

const ConnectionSchema = z.object({
  name: z.string().default(''),
  url: z.string().min(1),
  username: z.string().default(''),
  password: z.string().default(''),
  clientId: z.string().default(''),
  auth: z.enum(['password', 'aliyun', 'tencent']).default('password'),
  productKey: z.string().default(''),
  productId: z.string().default(''),
  deviceName: z.string().default(''),
  deviceSecret: z.string().default(''),
  signMethod: z.enum(['hmacsha1', 'hmacsha256']).default('hmacsha256'),
  securemode: z.preprocess(toSecuremode, z.union([z.literal(2), z.literal(3)])).default(3),
  topics: z.preprocess(toTopics, z.array(z.string().min(1)).min(1)),
  commandTopic: z.string().default(''),
  qos: z.preprocess(toQos, z.union([z.literal(0), z.literal(1)])).default(1),
  mode: z.enum(['every', 'digest']).default('every'),
  digestSeconds: z.number().int().min(5).max(3600).default(30),
  actorTopicSegment: z.preprocess(toOptionalInt, z.number().int().min(1).max(16).optional()),
  alerts: z.preprocess(toAlerts, z.array(AlertRuleSchema)).default([]),
})

export const IotConfigSchema = z.object({
  connections: z.array(ConnectionSchema).default([]),
  maxTriggersPerMinute: z.number().int().min(1).max(600).default(20),
  ignoreRetained: z.preprocess(toBool, z.boolean()).default(true),
  payloadMaxBytes: z.number().int().min(1024).max(262144).default(65536),
}).strict()

export const iotKind = {
  kind: 'iot',
  title: { zh: '物联网', en: 'IoT' },
  description: { zh: 'MQTT 多连接遥测源：alert/every/digest 三条路径把设备消息升格为工单，回复经命令主题下发并带回环标记。', en: 'Multi-connection MQTT telemetry: alert/every/digest rules upgrade device messages to tickets; replies publish to command topics with a loop-guard marker.' },
  schema: IotConfigSchema,
  fields: [
    { key: 'connections', type: 'rows', dialog: true, label: { zh: 'MQTT 连接', en: 'MQTT connections' }, columns: [
      { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true, hint: { zh: '仅用于面板显示；留空用 url 作为连接标识', en: 'Display only; url is the connection id when empty' } },
      { key: 'url', type: 'text', label: { zh: 'Broker 地址', en: 'Broker URL' }, hint: { zh: 'mqtt://host:port 或 mqtts://…（1883 明文 / 8883 TLS）', en: 'mqtt://host:port or mqtts://... (1883 plain / 8883 TLS)' } },
      { key: 'auth', type: 'text', label: { zh: '鉴权方式', en: 'Auth' }, optional: true, hint: { zh: 'password 账号密码 / aliyun 三元组 / tencent 密钥认证，默认 password', en: 'password / aliyun triple / tencent key auth; password by default' } },
      { key: 'username', type: 'text', label: { zh: '用户名', en: 'Username' }, optional: true, hint: { zh: 'password 鉴权时使用；云端签名自动生成', en: 'For password auth; cloud signing generates its own' } },
      { key: 'password', type: 'text', label: { zh: '密码', en: 'Password' }, optional: true, hint: { zh: 'password 鉴权时使用；明文存于本机引擎配置', en: 'For password auth; stored in local engine config' } },
      { key: 'clientId', type: 'text', label: { zh: 'ClientID', en: 'ClientID' }, optional: true, hint: { zh: '留空自动 dsh-iot-<随机>，避免多端互踢', en: 'Auto dsh-iot-<rand> when empty; avoids takeover kicks' } },
      { key: 'topics', type: 'text', label: { zh: '订阅主题', en: 'Topics' }, hint: { zh: '支持 +/# 通配；多个用逗号或空格分隔；勿与命令主题重叠', en: '+/# wildcards; comma/space separated; keep clear of the command topic' } },
      { key: 'commandTopic', type: 'text', label: { zh: '命令主题', en: 'Command topic' }, optional: true, hint: { zh: '回复发布目标，{topic} 占位替换为触发消息的实际主题', en: 'Reply target; {topic} replaced by the triggering topic' } },
      { key: 'qos', type: 'number', label: { zh: 'QoS', en: 'QoS' }, optional: true, hint: { zh: '0 或 1，默认 1', en: '0 or 1; 1 by default' } },
      { key: 'mode', type: 'text', label: { zh: '触发模式', en: 'Mode' }, optional: true, hint: { zh: 'every 每条触发（受全局限流）/ digest 窗口聚合，默认 every', en: 'every (rate limited) or digest window; every by default' } },
      { key: 'digestSeconds', type: 'number', label: { zh: '聚合窗口秒', en: 'Digest window (s)' }, optional: true, hint: { zh: 'digest 模式与限流溢出的聚合窗口，默认 30', en: 'Window for digest mode and rate-limit overflow; 30 by default' } },
      { key: 'actorTopicSegment', type: 'number', label: { zh: '设备段层级', en: 'Actor segment' }, optional: true, hint: { zh: '取主题第 N 层作为设备标识，留空为 device', en: 'Use topic level N as device id; device by default' } },
      { key: 'productKey', type: 'text', label: { zh: '阿里 productKey', en: 'Aliyun productKey' }, optional: true },
      { key: 'productId', type: 'text', label: { zh: '腾讯 productId', en: 'Tencent productId' }, optional: true },
      { key: 'deviceName', type: 'text', label: { zh: '云设备名', en: 'Cloud deviceName' }, optional: true },
      { key: 'deviceSecret', type: 'text', label: { zh: '云设备密钥', en: 'Cloud deviceSecret' }, optional: true },
      { key: 'signMethod', type: 'text', label: { zh: '签名算法', en: 'Sign method' }, optional: true, hint: { zh: 'hmacsha256（默认）或 hmacsha1', en: 'hmacsha256 (default) or hmacsha1' } },
      { key: 'alerts', type: 'text', label: { zh: '告警规则', en: 'Alert rules' }, optional: true, hint: { zh: 'JSON 数组 [{"topic":"a/+/t","path":"temp","op":">","value":30,"label":"高温","cooldownSeconds":300}]，命中即时触发并按规则冷却', en: 'JSON array of {topic,path,op,value,label,cooldownSeconds}; fires immediately with per-rule cooldown' } },
    ], presets: [
      { label: { zh: 'EMQX / Mosquitto 本地', en: 'Local EMQX / Mosquitto' }, values: { url: 'mqtt://127.0.0.1:1883', auth: 'password', mode: 'every' } },
      { label: { zh: 'Home Assistant', en: 'Home Assistant' }, values: { url: 'mqtt://homeassistant.local:1883', auth: 'password' } },
      { label: { zh: '公共 test.mosquitto.org', en: 'Public test.mosquitto.org' }, values: { url: 'mqtt://test.mosquitto.org:1883', auth: 'password' } },
      { label: { zh: '阿里云 IoT（三元组）', en: 'Aliyun IoT (triple)' }, values: { auth: 'aliyun', signMethod: 'hmacsha256', securemode: 3, topics: '/sys/<productKey>/<deviceName>/thing/event/property/post' } },
      { label: { zh: '腾讯云 IoT（密钥认证）', en: 'Tencent IoT (key auth)' }, values: { auth: 'tencent', signMethod: 'hmacsha256', topics: '$thing/up/property/<productId>/<deviceName>' } },
    ] },
    { key: 'maxTriggersPerMinute', type: 'number', min: 1, max: 600, label: { zh: '每分钟触发上限', en: 'Max triggers/min' }, advanced: true },
    { key: 'ignoreRetained', type: 'text', label: { zh: '忽略 retained', en: 'Ignore retained' }, optional: true, advanced: true, hint: { zh: '连接时 broker 补发的 retained 消息默认丢弃（true）', en: 'Drop retained messages on subscribe (true by default)' } },
    { key: 'payloadMaxBytes', type: 'number', min: 1024, max: 262144, label: { zh: 'payload 上限字节', en: 'Payload max bytes' }, advanced: true },
  ],
  health: [HEALTH_ENTRY],
  scope(input: { meta: Record<string, unknown> }, config: IotConfig) {
    const connId = String(input.meta.connectionId ?? '')
    const row = config.connections.find((c) => idOf(c) === connId)
    if (!row) return { listened: false, reason: 'iot: connection not configured: ' + connId }
    return { listened: true, observed: false, row: idOf(row) }
  },
  channel: {
    async send(_host: unknown, message: OutboundMessageLike): Promise<'sent' | 'gone'> {
      const address = message.channel.address as { connection?: string; replyTopic?: string; topic?: string }
      const connId = String(address.connection ?? '')
      const entry = connectionRegistry.current.get(connId)
      if (!entry) throw new Error('iot: connection not ready: ' + connId)
      const body: Record<string, unknown> = { via: entry.via, text: message.text }
      if (message.ticketId) body.ticketId = message.ticketId
      const rawReply = String(address.replyTopic ?? '')
      const replyTopic = address.topic ? rawReply.split('{topic}').join(String(address.topic)) : rawReply
      await entry.client.publishCommand(replyTopic, JSON.stringify(body))
      return 'sent'
    },
    link(address: Record<string, string>) {
      return emptyLink({ zh: '物联网 ' + String(address.connection ?? ''), en: 'IoT ' + String(address.connection ?? '') })
    },
  },
  threadContext: {
    messageId(trigger: TriggerLike): string {
      return String(trigger.meta.topic ?? trigger.id)
    },
    async read(_commands: unknown, trigger: TriggerLike, part: 'thread' | 'root' | 'parent', _cursor: string | undefined, _config: IotConfig) {
      // v1: the assessment reads the trigger's own message; full topic history
      // needs a broker-side store (planned M3+).
      const own = { id: String(trigger.meta.topic ?? trigger.id), from: String(trigger.actor.id), at: trigger.at, text: trigger.text }
      return { messages: part === 'parent' ? [] : [own], body: {}, status: undefined }
    },
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string(), name: z.string().optional() })).default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '允许的主题', en: 'Allowed topics' }, columns: [
        { key: 'id', type: 'text', label: { zh: '主题通配符', en: 'Topic filter' } },
        { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true },
      ] },
    ],
    explicit: { zh: '所配连接订阅主题上的新遥测消息', en: 'New telemetry on the configured connection topics' },
    rows(config: Record<string, unknown>) {
      const connections = (Array.isArray(config.connections) ? config.connections : []) as IotConnection[]
      return connections.map((c) => ({
        id: idOf(c),
        label: c.name || idOf(c),
        note: { zh: '订阅主题上的遥测即事件', en: 'Telemetry on subscribed topics becomes events' },
        cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true },
      }))
    },
  },
} as unknown as import('./types.ts').SourceKindLike