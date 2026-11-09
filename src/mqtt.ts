/** MQTT connection layer: builds one mqtt.js client per connection config
 *  (plain password auth or Aliyun/Tencent signed triples), subscribes the
 *  configured topic filters, and exposes command publishing for the channel. */
import mqtt from 'mqtt'
import { randomHex } from './util.ts'
import { aliyunMqttAuth, tencentMqttAuth, type MqttAuthParts } from './auth.ts'

export interface IotClient {
  readonly clientId: string
  connected(): boolean
  publishCommand(topic: string, json: string): Promise<void>
  end(): Promise<void>
}

export interface MessagePacketLike { retained?: boolean; dup?: boolean; messageId?: number }

export interface ConnectEvents {
  onMessage(topic: string, payload: Buffer, packet: MessagePacketLike): void
  onStatus(connected: boolean, error?: string): void
}

export interface ConnectionConfigLike {
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
  topics: readonly string[]
  qos: 0 | 1
}

export function viaMarker(clientId: string): string {
  return 'dsh-superagent-iot:' + clientId
}

export function connectIot(conn: ConnectionConfigLike, events: ConnectEvents): IotClient {
  const auth = buildAuth(conn)
  const clientId = auth ? auth.clientId : (conn.clientId || 'dsh-iot-' + randomHex(8))
  const credential = auth
    ? { username: auth.username, password: auth.password }
    : (conn.username || conn.password)
      ? { username: conn.username, password: conn.password }
      : {}
  const client = mqtt.connect(conn.url, {
    clientId,
    ...credential,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 10000,
    keepalive: 30,
  })
  client.on('connect', () => {
    client.subscribe([...conn.topics], { qos: conn.qos })
    events.onStatus(true)
  })
  client.on('close', () => events.onStatus(false))
  client.on('offline', () => events.onStatus(false))
  client.on('error', (error: Error) => {
    events.onStatus(client.connected, String(error?.message ?? error).slice(0, 300))
  })
  client.on('message', (topic: string, payload: Buffer, packet: MessagePacketLike) => {
    events.onMessage(topic, payload, packet)
  })
  return {
    clientId,
    connected: () => client.connected,
    publishCommand: (topic: string, json: string) => new Promise<void>((resolve, reject) => {
      if (!topic) { reject(new Error('iot: replyTopic is empty')); return }
      if (!client.connected) { reject(new Error('iot: connection not ready: ' + clientId)); return }
      client.publish(topic, json, { qos: 1 }, (error) => (error ? reject(error) : resolve()))
    }),
    end: () => new Promise<void>((resolve) => { client.end(true, () => resolve()) }),
  }
}

function buildAuth(conn: ConnectionConfigLike): MqttAuthParts | null {
  if (conn.auth === 'aliyun') {
    if (!conn.productKey || !conn.deviceName || !conn.deviceSecret) {
      throw new Error('iot: aliyun auth needs productKey/deviceName/deviceSecret')
    }
    return aliyunMqttAuth({ productKey: conn.productKey, deviceName: conn.deviceName, deviceSecret: conn.deviceSecret, clientId: conn.clientId, signMethod: conn.signMethod, securemode: conn.securemode })
  }
  if (conn.auth === 'tencent') {
    if (!conn.productId || !conn.deviceName || !conn.deviceSecret) {
      throw new Error('iot: tencent auth needs productId/deviceName/deviceSecret')
    }
    return tencentMqttAuth({ productId: conn.productId, deviceName: conn.deviceName, deviceSecret: conn.deviceSecret, signMethod: conn.signMethod })
  }
  return null
}
