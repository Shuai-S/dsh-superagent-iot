# dsh-superagent-iot design and configuration details

## Contract alignment

kind: iot, health entry: iotMqtt, inject: ['orchestrator'], install: dsh.bundle.patch points to cordis.patch.yml (id/name both dsh-superagent-iot). Structurally identical to the mail source: register the kind via orchestrator.sources.register, start the watch via orchestrator.context, torn down by AbortSignal.

## Pipeline

Subscribe: connect -> subscribe(topics, qos) -> filters (retained / own via / payload cap) -> dedup (topic|messageId|hash8, 60s LRU) -> rules:

- alert: JSON payloads only; a dot-path number compared with op/value fires an immediate trigger (bypasses digest) with a per-rule cooldownSeconds.
- every: each message triggers, throttled by the global maxTriggersPerMinute sliding window; overflow joins the digest accumulator.
- digest: per (connection, expanded topic) window; one summary trigger at window end (count, first/last timestamps, last 5 truncated payloads).

Reply: channel.send -> publish commandTopic ({topic} replaced by the triggering topic) -> JSON {via, text, ticketId}, QoS 1. Throws when the connection is not ready.

## Loop guard (two layers)

1. The user keeps the subscription set disjoint from commandTopic (declared here, not enforced).
2. Command payloads carry via: dsh-superagent-iot:<clientId>; incoming payloads with our own via are dropped, so overlap alone cannot loop.

## No-cursor contract

MQTT has no mail-style UID cursor. M1/M2 use clean-session realtime delivery: no offline replay; QoS1 at-least-once duplicates are absorbed by a 60s LRU dedup. Persistent session is an M3 option.

## Cloud signing

- Aliyun (auth: aliyun): username deviceName&productKey; password = hex HMAC-SHA256/SHA1 of the dictionary-ordered string clientId..deviceName..productKey..timestamp..; client id appends |securemode,signmethod,timestamp|. Evidence: unpkg.com/aliyun-iot-mqtt@0.0.4 (isomorphic with official dev_sign).
- Tencent (auth: tencent): clientId productId+deviceName; username clientId;12010126;connid;expiry; password = hex HMAC over username + ';signmethod', key = base64-decoded device secret when it decodes cleanly, else raw bytes. Evidence: cloud.tencent.com/document/product/1081/138025.

## Local verification

    pnpm install
    pnpm check
    pnpm smoke

Smoke runs against an embedded aedes broker; no real cloud credentials are involved.

Note: aedes@0.51.3 does not set the RETAIN flag when redelivering retained messages, so the smoke covers the retained path with isSelfOrRetained unit assertions; real brokers (mosquitto/EMQX/HA) set RETAIN=1 on new-subscriber redelivery per the MQTT spec.