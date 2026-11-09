import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'
import { aliyunMqttAuth, TENCENT_SDK_APPID, tencentMqttAuth } from '../lib/index.js'

test('aliyunMqttAuth: username/clientId 结构 + password 用 clientId 内 timestamp 复算闭环', () => {
  const parts = aliyunMqttAuth({ productKey: 'pk1', deviceName: 'dev1', deviceSecret: 'sec1', clientId: 'cid1' })
  assert.equal(parts.username, 'dev1&pk1')
  const m = /^cid1\|securemode=3,signmethod=hmacsha256,timestamp=(\d+)\|$/.exec(parts.clientId)
  assert.ok(m, 'clientId 形如 cid1|securemode=3,signmethod=hmacsha256,timestamp=N|')
  const content = 'clientIdcid1deviceNamedev1productKeypk1timestamp' + m[1]
  assert.equal(parts.password, crypto.createHmac('sha256', 'sec1').update(content, 'utf8').digest('hex'))
})

test('aliyunMqttAuth: hmacsha1 / securemode 2 / clientId 带 | 尾取首段', () => {
  const parts = aliyunMqttAuth({ productKey: 'pk', deviceName: 'dev', deviceSecret: 's', clientId: 'abc|extra', signMethod: 'hmacsha1', securemode: 2 })
  assert.ok(parts.clientId.startsWith('abc|securemode=2,signmethod=hmacsha1,timestamp='))
  assert.ok(parts.clientId.endsWith('|'))
  assert.equal(parts.password.length, 40)
  assert.match(parts.password, /^[0-9a-f]{40}$/)
})

test('aliyunMqttAuth: clientId 留空自动生成', () => {
  const parts = aliyunMqttAuth({ productKey: 'pk', deviceName: 'dev', deviceSecret: 's' })
  assert.match(parts.clientId, /^dsh-iot-[0-9a-f]{8}\|securemode=/)
})

test('tencentMqttAuth: clientId/username 结构 + base64 密钥复算闭环', () => {
  const secret = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')
  const parts = tencentMqttAuth({ productId: 'P1', deviceName: 'D1', deviceSecret: secret })
  assert.equal(parts.clientId, 'P1D1')
  const m = new RegExp('^P1D1;' + TENCENT_SDK_APPID + ';([0-9a-f]{8});(\\d+)$').exec(parts.username)
  assert.ok(m, 'username 形如 clientId;sdkappid;connid;expiry')
  const expiry = Number(m[2])
  const now = Math.floor(Date.now() / 1000)
  assert.ok(Math.abs(expiry - (now + 3600)) <= 120, 'expiry ≈ now+3600s')
  const key = Buffer.from(secret, 'base64')
  const token = crypto.createHmac('sha256', key).update(parts.username, 'utf8').digest('hex')
  assert.equal(parts.password, token + ';hmacsha256')
  assert.equal(TENCENT_SDK_APPID, '12010126')
})

test('tencentMqttAuth: 非 base64 密钥回退原串字节；hmacsha1 后缀', () => {
  const parts = tencentMqttAuth({ productId: 'P', deviceName: 'D', deviceSecret: 'raw-secret!not-base64', signMethod: 'hmacsha1' })
  const token = crypto.createHmac('sha1', 'raw-secret!not-base64').update(parts.username, 'utf8').digest('hex')
  assert.equal(parts.password, token + ';hmacsha1')
})

test('tencentMqttAuth: 短 base64 形似串（<16）走原串字节路径', () => {
  const parts = tencentMqttAuth({ productId: 'P', deviceName: 'D', deviceSecret: 'short==ok' })
  const token = crypto.createHmac('sha256', 'short==ok').update(parts.username, 'utf8').digest('hex')
  assert.equal(parts.password, token + ';hmacsha256')
})
