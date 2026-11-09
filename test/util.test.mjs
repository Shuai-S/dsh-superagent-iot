import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compare, dotPath, hash8, matchTopicFilter, randomHex } from '../lib/index.js'

test('hash8: 确定性 sha256 前 8 位十六进制', () => {
  assert.equal(hash8(''), 'e3b0c442')
  assert.equal(hash8('abc'), 'ba7816bf')
  assert.equal(hash8('abc').length, 8)
  assert.match(hash8('abc'), /^[0-9a-f]{8}$/)
  assert.notEqual(hash8('abc'), hash8('abd'))
})

test('randomHex: 指定长度十六进制随机串', () => {
  for (const n of [1, 7, 8, 16]) {
    const v = randomHex(n)
    assert.equal(v.length, n)
    assert.match(v, /^[0-9a-f]+$/)
  }
  assert.notEqual(randomHex(8), randomHex(8))
})

test('matchTopicFilter: + 单层 / # 多层 / 精确', () => {
  assert.equal(matchTopicFilter('a/b', 'a/b'), true)
  assert.equal(matchTopicFilter('a/+', 'a/b'), true)
  assert.equal(matchTopicFilter('a/+', 'a/b/c'), false)
  assert.equal(matchTopicFilter('a/#', 'a/b/c'), true)
  assert.equal(matchTopicFilter('a/#', 'a'), true) // MQTT 4.7.1.2：# 含父层级（实现与规范一致）
  assert.equal(matchTopicFilter('+', 'a'), true)
  assert.equal(matchTopicFilter('+', 'a/b'), false)
  assert.equal(matchTopicFilter('#', 'a/b/c'), true)
  assert.equal(matchTopicFilter('a/b', 'a/c'), false)
  assert.equal(matchTopicFilter('a/b/c', 'a/b'), false)
  assert.equal(matchTopicFilter('a/+/c', 'a/b/c'), true)
})

test('dotPath: 嵌套取值 / 数组下标 / 缺失 undefined', () => {
  const value = { a: { b: [{ c: 7 }] }, n: null }
  assert.equal(dotPath(value, 'a.b.0.c'), 7)
  assert.equal(dotPath(value, 'a.b'), value.a.b)
  assert.equal(dotPath(value, 'a.b.5.c'), undefined)
  assert.equal(dotPath(value, 'n.x'), undefined)
  assert.equal(dotPath(value, ''), undefined)
  assert.equal(dotPath(null, 'a'), undefined)
  assert.equal(dotPath(value, 'a.b.0'), value.a.b[0])
})

test('compare: 六种算子 + 未知算子恒 false', () => {
  assert.equal(compare(31, '>', 30), true)
  assert.equal(compare(30, '>', 30), false)
  assert.equal(compare(30, '>=', 30), true)
  assert.equal(compare(29, '<', 30), true)
  assert.equal(compare(30, '<=', 30), true)
  assert.equal(compare(30, '==', 30), true)
  assert.equal(compare(31, '!=', 30), true)
  assert.equal(compare(31, '≈', 30), false)
})
