/** Cloud IoT MQTT credential builders, implemented from verified upstream
 *  evidence (see docs/DETAIL.md):
 *  - Aliyun: mirrors aliyun-iot-mqtt@0.0.4 (isomorphic with the official
 *    dev_sign library): username 'deviceName&productKey'; password = hex HMAC
 *    over 'clientId..deviceName..productKey..timestamp..' (dictionary order);
 *    the mqtt client id appends the |securemode,signmethod,timestamp| tail.
 *  - Tencent: mirrors the official key-auth doc (cloud.tencent.com/document/
 *    product/1081/138025): clientId productId+deviceName; username
 *    'clientId;sdkappid;connid;expiry'; password 'token;signmethod' where the
 *    HMAC key is the base64-decoded device secret when it decodes cleanly,
 *    else the raw string bytes. */
import crypto from 'node:crypto'
import { randomHex } from './util.ts'

export type SignMethod = 'hmacsha1' | 'hmacsha256'

export interface MqttAuthParts { clientId: string; username: string; password: string }

function hmacHex(method: SignMethod, key: string | Buffer, content: string): string {
  return crypto.createHmac(method === 'hmacsha1' ? 'sha1' : 'sha256', key).update(content, 'utf8').digest('hex')
}

export interface AliyunAuthInput {
  productKey: string
  deviceName: string
  deviceSecret: string
  clientId?: string
  signMethod?: SignMethod
  securemode?: 2 | 3
}

export function aliyunMqttAuth(input: AliyunAuthInput): MqttAuthParts {
  const signMethod = input.signMethod ?? 'hmacsha256'
  const securemode = input.securemode ?? 3
  const randClientId = (input.clientId ?? '').split('|')[0] || 'dsh-iot-' + randomHex(8)
  const timestamp = Date.now()
  const content = 'clientId' + randClientId + 'deviceName' + input.deviceName + 'productKey' + input.productKey + 'timestamp' + timestamp
  return {
    clientId: randClientId + '|securemode=' + securemode + ',signmethod=' + signMethod + ',timestamp=' + timestamp + '|',
    username: input.deviceName + '&' + input.productKey,
    password: hmacHex(signMethod, input.deviceSecret, content),
  }
}

export const TENCENT_SDK_APPID = '12010126'

export interface TencentAuthInput {
  productId: string
  deviceName: string
  deviceSecret: string
  signMethod?: SignMethod
  expirySeconds?: number
}

/** Strict base64 probe: decode and round-trip; fall back to the raw string
 *  bytes when the secret is not clean base64 (mirrors the official C# sample
 *  that uses FromBase64String on base64 secrets). */
function tencentSecretKey(deviceSecret: string): string | Buffer {
  if (deviceSecret.length >= 16 && /^[A-Za-z0-9+/]+={0,2}$/.test(deviceSecret)) {
    const decoded = Buffer.from(deviceSecret, 'base64')
    if (decoded.length > 0 && decoded.toString('base64').replace(/=+$/, '') === deviceSecret.replace(/=+$/, '')) return decoded
  }
  return deviceSecret
}

export function tencentMqttAuth(input: TencentAuthInput): MqttAuthParts {
  const signMethod = input.signMethod ?? 'hmacsha256'
  const clientId = input.productId + input.deviceName
  const connid = randomHex(8)
  const expiry = Math.floor(Date.now() / 1000) + (input.expirySeconds ?? 3600)
  const username = clientId + ';' + TENCENT_SDK_APPID + ';' + connid + ';' + expiry
  const token = hmacHex(signMethod, tencentSecretKey(input.deviceSecret), username)
  return { clientId, username, password: token + ';' + signMethod }
}
