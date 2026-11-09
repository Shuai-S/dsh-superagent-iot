# dsh-superagent-iot

MQTT 物联网 Source for dsh-superagent：每个配置的连接一个 MQTT 客户端，遥测按 alert / every / digest 三条路径升格为工单；回复经命令主题下发并自带回环标记。包骨架与 Source kind 契约对齐 dsh-superagent-mail（六源同构）。

## 收发链路

订阅链：connect → subscribe(topics) → 过滤（retained / 自身 via / payload 上限）→ 去重（QoS1，60s LRU）→ 规则（alert 即时 / every 限流 / digest 窗口聚合）→ Trigger → source.receive

回复链：channel.send → publish commandTopic（{topic} 占位替换为触发消息的实际主题）→ JSON {via, text, ticketId}，QoS1

回环双保险：

1. 订阅集与 commandTopic 无交集由用户保证（本 README 明确声明，插件不强校验）；
2. 命令 payload 带 via: dsh-superagent-iot:<clientId>，订阅侧丢弃自身 via 消息——即使主题重叠也不会回环。

无游标口径：MQTT 无 mail 式 UID 游标，M1/M2 采用 clean session 实时口径，离线期间的消息不补发（由 broker session 决定）；QoS1 重复投递由 60s LRU 去重吸收。persistent session 与离线补发为 M3 选项。

健康：iotMqtt 三态（ready / paused / error）+ values（connections / online / msgPerMin）。

## 云平台鉴权

阿里云 IoT（auth: aliyun）：username 为 deviceName&productKey；password = HMAC-SHA256(deviceSecret, clientId..deviceName..productKey..timestamp..)（字典序拼接，hex）；clientId 追加 |securemode=3,signmethod=hmacsha256,timestamp=...|。证据：unpkg.com/aliyun-iot-mqtt@0.0.4（与官方 dev_sign 同构）。preset 主题：/sys/<productKey>/<deviceName>/thing/event/property/post。

腾讯云 IoT（auth: tencent）：clientId 为 productId+deviceName 直接拼接；username 为 clientId;12010126;connid;expiry（sdkappid 固定，expiry=now+3600）；password = hex(HMAC(deviceSecret, username)) + ';hmacsha256'，密钥先按 base64 解码作 HMAC key（官方 C# FromBase64String 用法），非干净 base64 回退原始串。证据：cloud.tencent.com/document/product/1081/138025《设备密钥认证》。

## 安全

凭据明文存本机引擎配置（与 mail 同口径），不落日志、不回显、不进 Git。真实三元组请从云平台控制台获取，仓库内不含任何真实凭据。

## 本地验证

    pnpm install
    pnpm check        # typecheck + build
    pnpm smoke        # 内嵌 aedes broker 的离线冒烟（无真实凭据）
