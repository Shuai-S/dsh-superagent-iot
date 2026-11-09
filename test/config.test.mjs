import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IotConfigSchema } from '../lib/index.js'

test('IotConfigSchema: 空配置补全默认值', () => {
  assert.deepEqual(IotConfigSchema.parse({}), { connections: [], maxTriggersPerMinute: 20, ignoreRetained: true, payloadMaxBytes: 65536 })
})

test('IotConfigSchema: 连接缺省值与预处理器（topics 拆分 / alerts JSON / qos·securemode 归一 / 空段转 undefined）', () => {
  const parsed = IotConfigSchema.parse({ connections: [{
    url: 'mqtt://127.0.0.1:1883',
    topics: 'a/+/b, c/#',
    alerts: '[{"topic":"a/+/b","path":"t","op":">","value":30}]',
    qos: '0',
    securemode: '2',
    actorTopicSegment: '',
  }] })
  const c = parsed.connections[0]
  assert.deepEqual(c.topics, ['a/+/b', 'c/#'])
  assert.equal(c.alerts.length, 1)
  assert.equal(c.alerts[0].cooldownSeconds, 300)
  assert.equal(c.alerts[0].label, '')
  assert.equal(c.qos, 0)
  assert.equal(c.securemode, 2)
  assert.equal(c.actorTopicSegment, undefined)
  assert.equal(c.mode, 'every')
  assert.equal(c.digestSeconds, 30)
  assert.equal(c.auth, 'password')
  assert.equal(c.commandTopic, '')
  assert.equal(c.name, '')
})

test('IotConfigSchema: 非法 alerts JSON 降级为空数组（不拒绝）', () => {
  const parsed = IotConfigSchema.parse({ connections: [{ url: 'mqtt://h', topics: 't', alerts: 'not-json' }] })
  assert.deepEqual(parsed.connections[0].alerts, [])
})

test('IotConfigSchema: 拒绝非法配置', () => {
  assert.throws(() => IotConfigSchema.parse({ connections: [{ url: '', topics: 't' }] }))          // url 空
  assert.throws(() => IotConfigSchema.parse({ connections: [{ url: 'mqtt://h', topics: [] }] }))   // topics 空
  assert.throws(() => IotConfigSchema.parse({ connections: [{ url: 'mqtt://h', topics: 't', auth: 'ftp' }] }))
  assert.throws(() => IotConfigSchema.parse({ connections: [{ url: 'mqtt://h', topics: 't', qos: 2 }] }))
  assert.throws(() => IotConfigSchema.parse({ connections: [{ url: 'mqtt://h', topics: 't', digestSeconds: 3 }] }))
  assert.throws(() => IotConfigSchema.parse({ connections: [{ url: 'mqtt://h', topics: 't', mode: 'batch' }] }))
  assert.throws(() => IotConfigSchema.parse({ maxTriggersPerMinute: 0 }))
  assert.throws(() => IotConfigSchema.parse({ payloadMaxBytes: 100 }))
  assert.throws(() => IotConfigSchema.parse({ unknown: 1 })) // strict
})

test('IotConfigSchema: alerts 规则校验（op 枚举 / cooldown 边界）', () => {
  assert.throws(() => IotConfigSchema.parse({ connections: [{ url: 'mqtt://h', topics: 't', alerts: '[{"topic":"a","path":"t","op":"≈","value":1}]' }] }))
  assert.throws(() => IotConfigSchema.parse({ connections: [{ url: 'mqtt://h', topics: 't', alerts: '[{"topic":"a","path":"t","op":">","value":1,"cooldownSeconds":90000}]' }] }))
})
