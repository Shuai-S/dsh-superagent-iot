# 更新日志

本包遵循 Keep a Changelog 风格；发布以 npm 为准（registry 回读为准绳，本地版本号不算已发布）。

## [Unreleased]

### Added
- 工程化闸门：新增 .github/workflows/ci.yml（push main + pull_request：pnpm install --frozen-lockfile → pnpm check → pnpm test → node scripts/verify-package.mjs）与 scripts/verify-package.mjs（零依赖完整性校验，同 qq 仓口径）。
- 测试体系：test/*.test.mjs（node:test + node:assert，从构建产物 ../lib/index.js 导入，零网络零 broker）：IotConfigSchema 默认/拒绝与预处理、util 全部 helper、auth 阿里/腾讯三元组构造与签名复算、watch 告警匹配/冷却/摘要窗口/限流纯函数、Deduper、via 标记与 {topic} 回复主题 helper、failure-log 滚动与静默。既有 scripts/smoke.ts 保持原样（pnpm smoke，本地 aedes，不在 CI 闸门内）。
- 渠道健壮性：src/failure-log.ts——publish 失败 JSONL（~/.local/state/dsh-superagent-iot/send-failures.jsonl，上限 200 行，{at,channelKey,kind,error≤300}，无凭据，写失败不影响主流程），channel.send 全部失败路径接入后照常抛出交引擎退避。
- 健康上报：iotMqtt detail 追加 in=/out=/fail=/last= 紧凑流量计数（paused 态除外）。
- 兼容性声明：package.json 增 dsh.compatibility（0.2.2-rc.1；本机 dsh CLI 实测，2026-11-09）。

### Changed
- 回复主题 {topic} 占位替换提取为 mqtt.replyTopicFor 纯函数，watch 构建触发地址与 channel.send 下发共用（行为不变）；watch 告警匹配/冷却/摘要窗口/限流提取为纯函数（matchAlertRule/alertCooldownOpen/digestDue/RateWindow，行为不变）。

### 判定为不适用
- 持久化 seen 去重（qq 仓 dedup 同款）：遥测消息无跨重启稳定消息 ID（QoS0 无 packet id），watch 内 60s LRU Deduper 已按 topic+packetId+payload hash 覆盖 QoS1 至少一次重推；clean-session 实时投递为 M1 契约（离线不重放），digest 模式自带窗口语义——seen 文件式去重无增益，不引入。

## [0.1.0] - 未发布（registry 尚无 0.1.0）

### Added
- 首个版本：MQTT IoT Source——多连接（明文密码 / 阿里云、腾讯云三元组签名鉴权）、every/digest/阈值告警升格工单（全局限流 + 60s 重推去重 + payload 上限 + via 回环标记）、命令主题回复、离线 aedes smoke（pnpm smoke）。
