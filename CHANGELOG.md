# 更新日志

本包遵循 Keep a Changelog 风格；发布以 npm 为准（registry 回读为准绳，本地版本号不算已发布）。

## [Unreleased]

### Added

- P-C'（契约 §1/§4）：「源设置」共享页壳接入——vendored shell + src/shell/tab.ts（健康/目标 CRUD/deliver 测试，address={topic, connection?}）+ src/client.ts 新 client bundle 入口（esbuild --bundle devDep 豁免；react 宿主 require）；targets CRUD 路由 + targets.ts 增 upsert/remove；投递 actor id 统一为 dsh-superagent-iot（引擎配置前提同步改列该 id）

### Added
- 工程化闸门：新增 .github/workflows/ci.yml（push main + pull_request：pnpm install --frozen-lockfile → pnpm check → pnpm test → node scripts/verify-package.mjs）与 scripts/verify-package.mjs（零依赖完整性校验，同 qq 仓口径）。
- 测试体系：test/*.test.mjs（node:test + node:assert，从构建产物 ../lib/index.js 导入，零网络零 broker）：IotConfigSchema 默认/拒绝与预处理、util 全部 helper、auth 阿里/腾讯三元组构造与签名复算、watch 告警匹配/冷却/摘要窗口/限流纯函数、Deduper、via 标记与 {topic} 回复主题 helper、failure-log 滚动与静默。既有 scripts/smoke.ts 保持原样（pnpm smoke，本地 aedes，不在 CI 闸门内）。
- 渠道健壮性：src/failure-log.ts——publish 失败 JSONL（~/.local/state/dsh-superagent-iot/send-failures.jsonl，上限 200 行，{at,channelKey,kind,error≤300}，无凭据，写失败不影响主流程），channel.send 全部失败路径接入后照常抛出交引擎退避。
- 健康上报：iotMqtt detail 追加 in=/out=/fail=/last= 紧凑流量计数（paused 态除外）。
- 兼容性声明：package.json 增 dsh.compatibility（0.2.2-rc.1；本机 dsh CLI 实测，2026-11-09）。
- 主动投递一期（契约 §2）：src/api.ts 经引擎面板 webServer seam 注册 /dsh-iot/api（inject 增 'webServer'，照抄 wechat/dws seam 注入用法；seam 缺失或注册失败仅 log 一次降级运行，不崩启动；闸门沿用 seam 拥有者 sameOrigin 语义，不引入新鉴权）——POST /api/deliver（{targetId,text,kind?} → 目标表取 address.topic（命令主题全名）→ 构造非人类 Trigger（human:false、meta.deliver=true、actor='iot'、addressed:'direct'、meta.connectionId）→ source.receive()，引擎回复经既有 channel.send→publishCommand 链路发布回命令主题；收件即受理 {ok:true,accepted:true,triggerId}，receive 抛出 500/filtered 409）、POST /api/deliver/test（不经引擎直调 publishCommand 发双语测试文案并带 via 回环标记，返回 {ok,sent,detail}，发布失败是测试结论而非 5xx）、GET /api/health（in/out/fail/deny+deliverAccepted/deliverFailed 计数、连接总数/在线数、目标数、最近 20 条 failure-log；deny 恒 0 保形）。
- 目标表：src/targets.ts——~/.local/state/dsh-superagent-iot/targets.json（原子写 tmp+rename mode 0o600，同 failure-log 风格；缺文件/损坏 JSON/非法条目一律降级不抛）——形状 {version:1,targets:[{id,address:{topic,connection?},label,createdAt,lastUsedAt}]}，address.topic 为命令主题全名；address.connection 省略且仅配一个连接时自动取用，多连接必须显式（引擎 channel.send 需按 connection 定位客户端，契约 §2「平台原生路由字段」的 iot 具体化）；targetId 校验 [A-Za-z0-9._@:-]{1,128}（契约 §2）。
- 投递 Trigger 的引擎侧准入（实读引擎 prototype src/core/intake.ts scope 过滤与 src/policy.ts machineGate/evals.ts Eval gate，2026-11-09）：非人类 Trigger 需 addressed（iot scope observed=false）与 meta.connectionId（本包 iot-kind scope() 自身过滤所需——引擎 intake 只调 kind.scope()，connectionId 引擎全源码零命中，2026-11-09 裁决更正归属），二者已内置；Eval 准入遵循引擎 machineGate 的 bot 路径——需在引擎设置 policy.sources.iot.bots 列出该 actor（如 {id:'iot'}）且 eval mode ≠ off，否则 Trigger 入库但被 gate 忽略（'not_human'），此为引擎侧配置（「谁可发起工作由各 Source 自身 identities 配置」），非本包代码。
- failure-log 读取端：readSendFailures(limit)（坏行跳过、缺文件返回空数组，绝不抛出），health 端点消费。
- 测试：test/targets.test.mjs、test/deliver.test.mjs（含 http 真闸门 403 与 ACL 判定 N/A 回归）、test/health.test.mjs（node:test + node:assert，从构建产物导入，零网络零 broker）；scripts/verify-package.mjs 增路由契约探针（lib/index.js 须含 '/dsh-iot/api' 与 '/deliver' 字面量，防漂移）。

### Changed
- 回复主题 {topic} 占位替换提取为 mqtt.replyTopicFor 纯函数，watch 构建触发地址与 channel.send 下发共用（行为不变）；watch 告警匹配/冷却/摘要窗口/限流提取为纯函数（matchAlertRule/alertCooldownOpen/digestDue/RateWindow，行为不变）。

### 判定为不适用
- 持久化 seen 去重（qq 仓 dedup 同款）：遥测消息无跨重启稳定消息 ID（QoS0 无 packet id），watch 内 60s LRU Deduper 已按 topic+packetId+payload hash 覆盖 QoS1 至少一次重推；clean-session 实时投递为 M1 契约（离线不重放），digest 模式自带窗口语义——seen 文件式去重无增益，不引入。
- ACL 访问模式（契约 §3 的 mode/allowUsers/groupOnly/denyText policy 字段）：实读 src/watch.ts 与 src/iot-kind.ts 确认入站 Trigger 全部是遥测升级（alert/every/digest，buildTrigger 一条路径，actor 为设备段/固定 'device'），不存在任何人类/命令类入站 trigger——命令主题仅作发布出口（channel.send→publishCommand），不订阅；遥测无人类 actor，契约 §3 亦载明「iot 遥测无 actor → policy 对 iot 仅约束命令类 trigger，遥测不受 ACL」，命令类入站为零 → 用户级 ACL 对本包不适用，IotConfigSchema 不增 policy 字段（test/deliver.test.mjs 回归：strict schema 拒绝 §3 policy 形状）。唯一非遥测入站是 /dsh-iot/api/deliver 注入的非人类 Trigger（human:false），其访问控制由 webServer seam 同源闸门承担（loopback Host + x-orchestrator-request + Origin 校验，引擎管理 API 同款；test 403 断言），不走 broker 入站。判定时点 2026-11-09；若后续新增命令类入站（订阅命令主题、actorId=clientId 等）须按契约 §3 实现 ACL 并复测。

## [0.1.0] - 未发布（registry 尚无 0.1.0）

### Added
- 首个版本：MQTT IoT Source——多连接（明文密码 / 阿里云、腾讯云三元组签名鉴权）、every/digest/阈值告警升格工单（全局限流 + 60s 重推去重 + payload 上限 + via 回环标记）、命令主题回复、离线 aedes smoke（pnpm smoke）。
