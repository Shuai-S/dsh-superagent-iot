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
import { iotKind, HEALTH_ENTRY } from './iot-kind.ts'
import { watch } from './watch.ts'

export const name: string = 'dsh-superagent-iot'
export const inject: string[] = ['orchestrator']

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
}
export { iotKind, IotConfigSchema } from './iot-kind.ts'
export { aliyunMqttAuth, TENCENT_SDK_APPID, tencentMqttAuth } from './auth.ts'
export { replyTopicFor, viaMarker } from './mqtt.ts'
export { compare, dotPath, hash8, matchTopicFilter, randomHex } from './util.ts'
export { alertCooldownOpen, Deduper, digestDue, isSelfOrRetained, matchAlertRule, RateWindow, withFlowDetail } from './watch.ts'
export { FAILURE_ERROR_MAX, FAILURE_LOG_LIMIT, logSendFailure, sendFailuresFile } from './failure-log.ts'
