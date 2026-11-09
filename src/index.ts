/**
 * dsh-superagent-iot — MQTT IoT Source for dsh-superagent.
 *
 * Registers the 'iot' Source kind through the same extension seam the bundled
 * watchers use (inject 'orchestrator'), keeps one MQTT client per configured
 * connection (plain password auth or Aliyun/Tencent signed triples), upgrades
 * telemetry to Triggers via alert/every/digest rules, and publishes agent
 * replies back to command topics with a loop-guard via marker.
 *
 * @module dsh-superagent-iot
 */
import type { Context } from '@deepseek-ai/cordis'
import type { OrchestratorLike } from './types.ts'
import type { IotConfig } from './iot-kind.ts'
import { iotKind, HEALTH_ENTRY } from './iot-kind.ts'
import { watch } from './watch.ts'
import { registerApiRoutes, type WebServerLike } from './api.ts'

export const name: string = 'dsh-superagent-iot'
// webServer = 引擎面板 webserver（同源 /dsh-iot/api 路由 seam，与 wechat/dws 绑定路由同款）。
export const inject: string[] = ['orchestrator', 'webServer']

export function apply(ctx: Context): void {
  const orchestrator = (ctx as unknown as { orchestrator: OrchestratorLike }).orchestrator
  ctx.effect(() => orchestrator.sources.register(iotKind), 'iot: source kind')
  ctx.effect(() => {
    const source = orchestrator.context(iotKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => {
      source.report(HEALTH_ENTRY, { state: 'error', detail: String(error).slice(0, 300) })
    })
    return async () => { controller.abort(); await running }
  })
  // 主动投递一期（契约 §2）：/dsh-iot/api 挂引擎面板 webserver seam。seam 缺失或
  // 注册失败只 log 一次降级运行（遥测主链路不受影响），不崩启动。
  try {
    const webServer = (ctx as unknown as { webServer?: WebServerLike }).webServer
    if (webServer?.register) {
      ctx.effect(() => {
        const source = orchestrator.context(iotKind)
        return registerApiRoutes(webServer, {
          receive: (trigger) => source.receive(trigger),
          configured: () => source.configured(),
          config: () => source.config<IotConfig>('iot'),
        })
      }, 'iot: api routes')
    } else {
      console.error('[iot] webServer seam unavailable; /dsh-iot/api routes inactive')
    }
  } catch (error) {
    console.error('[iot] webServer seam registration skipped: ' + String(error).slice(0, 200))
  }
}
export { connectionRegistry, flowStats, idOf, iotKind, IotConfigSchema } from './iot-kind.ts'
export { aliyunMqttAuth, TENCENT_SDK_APPID, tencentMqttAuth } from './auth.ts'
export { replyTopicFor, viaMarker } from './mqtt.ts'
export { compare, dotPath, hash8, matchTopicFilter, randomHex } from './util.ts'
export { alertCooldownOpen, Deduper, digestDue, isSelfOrRetained, matchAlertRule, RateWindow, withFlowDetail } from './watch.ts'
export { FAILURE_ERROR_MAX, FAILURE_LOG_LIMIT, logSendFailure, readSendFailures, sendFailuresFile, type SendFailureEntry } from './failure-log.ts'
// 主动投递一期（契约 §2，webServer seam 路由）与目标表
export { API_PREFIX, buildDeliverTrigger, createApiHandler, DELIVER_TEST_TEXT, deliverStats, registerApiRoutes, resolveConnection, sameOrigin, type ApiDeps, type WebServerLike } from './api.ts'
export { getTarget, readTargets, TARGETS_VERSION, TARGET_ID_RE, targetsFile, touchTarget, validTargetId, writeTargets, type TargetAddress, type TargetRecord, type TargetsFile } from './targets.ts'
