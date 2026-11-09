# dsh-superagent-iot 设计与配置细节

## 契约对齐

kind: iot · 健康入口: iotMqtt · 注入: ['orchestrator'] · 安装: dsh.bundle.patch 指向 cordis.patch.yml（id/name 均为 dsh-superagent-iot）。与 mail 等六源同构：orchestrator.sources.register 注册 kind 后经 orchestrator.context 起 watch 循环，AbortSignal 收口。

## 收发链路

订阅链：connect → subscribe(topics, qos) → 过滤（retained 丢弃 / 自身 via 丢弃 / payload 超限丢弃）→ 去重（topic|messageId|hash8，60s LRU）→ 规则匹配：

- alert：仅 JSON payload，dot path 取数值与阈值按 op 比较，命中即时出 trigger（绕过 digest），同规则 cooldownSeconds 内不重复。
- every：每条即触发，受全局 maxTriggersPerMinute 滑动窗口限流，溢出并入 digest 累积器。
- digest：按（连接, 展开后 topic）聚合，digestSeconds 窗口末出一条汇总 trigger（条数、首末时间、最近 5 条截断 payload）。

回复链：channel.send → publish commandTopic（{topic} 占位替换为触发消息实际主题）→ JSON {via, text, ticketId}，QoS1。连接未就绪抛错。

## 回环双保险

1. 订阅集与 commandTopic 无交集由用户保证（本文件明确声明，插件不强校验）；
2. 命令 payload 带 via: dsh-superagent-iot:<clientId>，订阅侧解析到自身 via 即丢弃——即使主题重叠也不会回环。

## 无游标口径

MQTT 没有 mail 式 UID 游标。M1/M2 采用 clean session 实时口径：离线期间的消息不补发；QoS1 的 at-least-once 重复投递由 60s LRU 去重吸收。persistent session 与离线补发为 M3 选项。

## 配置字段

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| connections[].name | 连接标识（scope/回复路由用），留空用 url | '' |
| connections[].url | mqtt(s)://host:port | 必填 |
| connections[].auth | password / aliyun / tencent | password |
| connections[].topics | 订阅主题，支持 +/#，逗号或空格分隔 | 必填 |
| connections[].commandTopic | 回复命令主题，{topic} 占位 | '' |
| connections[].qos | 订阅 QoS | 1 |
| connections[].mode | every / digest | every |
| connections[].digestSeconds | 聚合窗口秒（digest 与限流溢出共用） | 30 |
| connections[].actorTopicSegment | 设备段=主题第 N 层 | device |
| connections[].alerts | 阈值告警规则（topic/path/op/value/label/cooldownSeconds） | [] |
| connections[].clientId | 留空自动 dsh-iot-<随机> | '' |
| connections[].productKey/productId/deviceName/deviceSecret/signMethod/securemode | 云平台三元组与签名参数 | 见上 |
| maxTriggersPerMinute | 全局每分钟触发上限（every 模式滑动窗口） | 20 |
| ignoreRetained | 连接时丢弃 broker 补发的 retained 消息 | true |
| payloadMaxBytes | payload 字节上限 | 65536 |

## 云平台签名鉴权

### 阿里云（auth: aliyun）

- username：deviceName 与 productKey 以 & 拼接
- contentStr：clientId{rand}deviceName{值}productKey{值}timestamp{值}（字典序；rand 为用户 clientId 去除管道部分或随机串；timestamp 为 Date.now()）
- password：hex(HMAC-SHA256 或 HMAC-SHA1(deviceSecret, contentStr))
- mqtt clientId：{rand}|securemode={2|3},signmethod={...},timestamp={...}|（securemode=3 明文 1883、=2 TLS 8883）
- 证据：unpkg.com/aliyun-iot-mqtt@0.0.4（与官方 dev_sign 同构）
- preset 主题：/sys/<productKey>/<deviceName>/thing/event/property/post

### 腾讯云（auth: tencent）

- clientId：productId+deviceName 直接拼接
- username：{clientId};12010126;{connid};{expiry}（sdkappid 固定 12010126，connid 客户端随机串，expiry=now+3600）
- password：hex(HMAC(deviceSecret, username)) + ';' + signmethod；密钥先按 base64 解码作 HMAC key（官方 C# FromBase64String 用法），非干净 base64 回退原始字符串
- 证据：cloud.tencent.com/document/product/1081/138025《设备密钥认证》（2026-09-11 更新）
- preset 主题：$thing/up/property/<productId>/<deviceName>、$thing/up/event/<productId>/<deviceName>

## 本地验证

    pnpm install
    pnpm check
    pnpm smoke

smoke 覆盖：schema 预处理、阿里/腾讯签名交叉复算、every 触发、digest 聚合、alert 命中与冷却、命令下发与 via 标记、未知连接拒绝、自身 via 回环丢弃、retained 丢弃、去重/主题匹配单元与健康 values。内嵌 aedes broker，无真实云凭据。

注意：aedes@0.51.3 在补发 retained 消息时不携带 RETAIN 标志（aedes.js 只入 retained store 不置位），因此 smoke 中 retained 路径为 isSelfOrRetained 单元断言；真实 broker（mosquitto/EMQX/HA）按 MQTT 规范在新订阅补发时置位 RETAIN=1，ignoreRetained 过滤在生产环境按 wire 行为生效。

## 安全

凭据明文存本机引擎配置（与 mail 同口径），不落日志、不回显、不进 Git。