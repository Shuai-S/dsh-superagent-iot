/** Publish-failure journal: one JSONL per plugin state dir
 *  (~/.local/state/dsh-superagent-iot/send-failures.jsonl), FIFO-capped at 200
 *  lines. Entries carry {at, channelKey, kind, error} only — channelKey is
 *  connectionId|replyTopic (identifiers, not credentials) and error is
 *  truncated to 300 chars; no message bodies, no secrets. Journaling never
 *  throws: a failed log write must not affect the send path it observes. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** JSONL 行数上限：超限滚动丢最旧。 */
export const FAILURE_LOG_LIMIT = 200
/** 单条 error 字段上限（字符）。 */
export const FAILURE_ERROR_MAX = 300

let tmpSeq = 0

function stateBase(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.local', 'state', 'dsh-superagent-iot')
}

export function sendFailuresFile(baseDir?: string): string {
  return join(stateBase(baseDir), 'send-failures.jsonl')
}

export interface SendFailureEntry { at: string; channelKey: string; kind: string; error: string }

/** 读取最近 limit 条发送失败（health 端点用）：坏行跳过，缺文件返回空数组，绝不抛出。 */
export async function readSendFailures(limit: number, baseDir?: string): Promise<SendFailureEntry[]> {
  try {
    const raw = await readFile(sendFailuresFile(baseDir), 'utf8')
    const entries: SendFailureEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as Partial<SendFailureEntry>
        if (typeof row.at !== 'string' || typeof row.error !== 'string') continue
        entries.push({ at: row.at, channelKey: String(row.channelKey ?? ''), kind: String(row.kind ?? ''), error: row.error })
      } catch { /* 坏行跳过 */ }
    }
    return entries.slice(Math.max(0, entries.length - limit))
  } catch {
    return []
  }
}

/** 记录一次发布失败（JSONL 追加 + 超限滚动）；任何写失败只打日志，绝不抛出。 */
export async function logSendFailure(entry: { channelKey: string; kind: string; error: string; at?: string }, baseDir?: string): Promise<void> {
  try {
    const line = JSON.stringify({
      at: entry.at ?? new Date().toISOString(),
      channelKey: String(entry.channelKey ?? '').slice(0, 200),
      kind: String(entry.kind ?? ''),
      error: String(entry.error ?? '').slice(0, FAILURE_ERROR_MAX),
    })
    const path = sendFailuresFile(baseDir)
    let lines: string[] = []
    try {
      lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim())
    } catch { /* 首条 */ }
    lines.push(line)
    if (lines.length > FAILURE_LOG_LIMIT) lines = lines.slice(lines.length - FAILURE_LOG_LIMIT)
    await mkdir(stateBase(baseDir), { recursive: true })
    const tmp = path + '.tmp-' + process.pid + '-' + (tmpSeq += 1)
    await writeFile(tmp, lines.join('\n') + '\n', { mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    console.error('[iot] failure-log write skipped: ' + String(error).slice(0, 160))
  }
}
