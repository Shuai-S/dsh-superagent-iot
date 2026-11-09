import assert from 'node:assert/strict'
import { test } from 'node:test'
import { replyTopicFor, viaMarker } from '../lib/index.js'

test('viaMarker: 客户端 id → 回环标记（watch 与 channel.send 共用约定）', () => {
  assert.equal(viaMarker('dsh-iot-abc'), 'dsh-superagent-iot:dsh-iot-abc')
})

test('replyTopicFor: {topic} 占位替换（多处 / 无占位 / 空串）', () => {
  assert.equal(replyTopicFor('cmd/{topic}/set', 'a/b'), 'cmd/a/b/set')
  assert.equal(replyTopicFor('{topic}/{topic}', 'x'), 'x/x')
  assert.equal(replyTopicFor('cmd/static', 'a/b'), 'cmd/static')
  assert.equal(replyTopicFor('', 'a/b'), '')
})
