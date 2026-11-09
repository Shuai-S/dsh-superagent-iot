import assert from 'node:assert/strict'
import { test } from 'node:test'
import { alertCooldownOpen, Deduper, digestDue, isSelfOrRetained, matchAlertRule, RateWindow } from '../lib/index.js'

const rule = { topic: 'a/+/temp', path: 't', op: '>', value: 30, label: '高温', cooldownSeconds: 300 }

test('matchAlertRule: 主题/取值/比较全命中才返回', () => {
  const hit = matchAlertRule(rule, 'a/s1/temp', { t: 35 })
  assert.ok(hit)
  assert.equal(hit.actual, 35)
  assert.equal(hit.rule, rule)
  assert.equal(matchAlertRule(rule, 'b/s1/temp', { t: 35 }), undefined)
  assert.equal(matchAlertRule(rule, 'a/s1/temp', { t: '35' }), undefined)
  assert.equal(matchAlertRule(rule, 'a/s1/temp', { t: Number.NaN }), undefined)
  assert.equal(matchAlertRule(rule, 'a/s1/temp', { t: 25 }), undefined)
  assert.equal(matchAlertRule(rule, 'a/s1/temp', {}), undefined)
})

test('alertCooldownOpen: 无记录放行 / 冷却中拒绝 / 冷却过后放行', () => {
  const now = 1000000
  assert.equal(alertCooldownOpen(undefined, now, 300), true)
  assert.equal(alertCooldownOpen(now - 100000, now, 300), false)
  assert.equal(alertCooldownOpen(now - 300000, now, 300), true)
  assert.equal(alertCooldownOpen(now - 1, now, 0), true)
})

test('digestDue: 窗口到期判定（时长下限 1s）', () => {
  assert.equal(digestDue(0, 29999, 30), false)
  assert.equal(digestDue(0, 30000, 30), true)
  assert.equal(digestDue(0, 500, 0), false)
  assert.equal(digestDue(0, 1000, 0), true)
})

test('RateWindow: 60s 滑动窗口限流（every 模式纯逻辑）', () => {
  const w = new RateWindow()
  for (let i = 0; i < 3; i++) assert.equal(w.admit(1000 + i, 3), true)
  assert.equal(w.admit(1003, 3), false)
  assert.equal(w.admit(61001, 3), true)   // 首条 1000 出窗
})

test('Deduper: 命中 / TTL 过期 / LRU 逐出', () => {
  const d = new Deduper()
  assert.equal(d.hit('k', 1000), false)
  assert.equal(d.hit('k', 2000), true)
  assert.equal(d.hit('k', 1000 + 60001), false)
  const full = new Deduper()
  for (let i = 0; i < 500; i++) full.hit('k' + i, 1000)
  assert.equal(full.hit('k0', 1001), true)
  full.hit('k500', 1002)
  assert.equal(full.hit('k0', 1003), false)
})

test('isSelfOrRetained: retained 过滤与 via 回环标记', () => {
  assert.equal(isSelfOrRetained({ retained: true }, true, 'via1', undefined), true)
  assert.equal(isSelfOrRetained({ retained: true }, false, 'via1', undefined), false)
  assert.equal(isSelfOrRetained({}, true, 'via1', { via: 'via1' }), true)
  assert.equal(isSelfOrRetained({}, true, 'via1', { via: 'other' }), false)
  assert.equal(isSelfOrRetained({}, true, 'via1', 'plain'), false)
})
