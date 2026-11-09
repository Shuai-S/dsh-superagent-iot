/** Delivery target registry: ~/.local/state/dsh-superagent-iot/targets.json (atomic
 *  tmp+rename writes, same style as failure-log). Shape (rpc-contract.md §2):
 *  {version:1, targets:[{id, address:{connection?, topic}, label, createdAt, lastUsedAt}]}.
 *  `address.topic` is the FULL command topic name; `address.connection` names the MQTT
 *  connection the publish goes through — optional when exactly one connection is
 *  configured, required otherwise. A missing or corrupt file reads back as an empty
 *  table; reads and touches never throw into the delivery path. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 目标表版本（契约 §2 固定 1）。 */
export const TARGETS_VERSION = 1
/** targetId 语法：1–128 字符 [A-Za-z0-9._@:-]（契约 §2；别名语义，与平台 ID 解耦）。 */
export const TARGET_ID_RE = /^[A-Za-z0-9._@:-]{1,128}$/

export interface TargetAddress { connection?: string; topic: string }
export interface TargetRecord { id: string; address: TargetAddress; label: string; createdAt: string; lastUsedAt: string }
export interface TargetsFile { version: number; targets: TargetRecord[] }

let tmpSeq = 0

function stateBase(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.local', 'state', 'dsh-superagent-iot')
}

export function targetsFile(baseDir?: string): string {
  return join(stateBase(baseDir), 'targets.json')
}

/** targetId 语法校验（契约 §2）。 */
export function validTargetId(id: unknown): id is string {
  return typeof id === 'string' && TARGET_ID_RE.test(id)
}

/** 规范化单条目标：id 合法且 address.topic 为字符串才收；connection 空串剔除。 */
function normalize(entry: unknown): TargetRecord | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const row = entry as Partial<TargetRecord>
  const address = row.address as TargetAddress | undefined
  if (!validTargetId(row.id) || !address || typeof address !== 'object' || typeof address.topic !== 'string' || !address.topic.trim()) return undefined
  const connection = typeof address.connection === 'string' ? address.connection.trim() : ''
  return {
    id: row.id,
    address: { topic: address.topic, ...(connection ? { connection } : {}) },
    label: typeof row.label === 'string' ? row.label : '',
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
    lastUsedAt: typeof row.lastUsedAt === 'string' ? row.lastUsedAt : '',
  }
}

/** 读取目标表：缺文件返回空表；损坏 JSON/非法条目降级（剔除坏行），绝不抛出到投递路径。 */
export async function readTargets(baseDir?: string): Promise<TargetsFile> {
  try {
    const parsed = JSON.parse(await readFile(targetsFile(baseDir), 'utf8')) as { version?: unknown; targets?: unknown }
    const targets: TargetRecord[] = []
    if (Array.isArray(parsed.targets)) {
      for (const entry of parsed.targets) {
        const row = normalize(entry)
        if (row) targets.push(row)
      }
    }
    return { version: typeof parsed.version === 'number' ? parsed.version : TARGETS_VERSION, targets }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[iot] targets read fallback to empty: ' + String(error).slice(0, 160))
    }
    return { version: TARGETS_VERSION, targets: [] }
  }
}

/** 原子写目标表（tmp+rename，mode 0o600，与 failure-log 同款）。 */
export async function writeTargets(file: TargetsFile, baseDir?: string): Promise<void> {
  await mkdir(stateBase(baseDir), { recursive: true })
  const path = targetsFile(baseDir)
  const tmp = path + '.tmp-' + process.pid + '-' + (tmpSeq += 1)
  await writeFile(tmp, JSON.stringify({ version: TARGETS_VERSION, targets: file.targets }, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, path)
}

/** 按 id 精确取目标（首个命中）。 */
export async function getTarget(id: string, baseDir?: string): Promise<TargetRecord | undefined> {
  return (await readTargets(baseDir)).targets.find((t) => t.id === id)
}

/** 更新 lastUsedAt（读改写原子落盘）；写失败只打日志，不影响投递主流程。 */
export async function touchTarget(id: string, at: string, baseDir?: string): Promise<void> {
  try {
    const file = await readTargets(baseDir)
    const row = file.targets.find((t) => t.id === id)
    if (!row) return
    row.lastUsedAt = at
    await writeTargets(file, baseDir)
  } catch (error) {
    console.error('[iot] targets touch skipped: ' + String(error).slice(0, 160))
  }
}

/** upsert 单目标（targetId 合法性由调用方校验；更新保留 createdAt）。 */
export async function upsertTarget(input: { id: string; address: TargetAddress; label?: string }, baseDir?: string): Promise<{ created: boolean }> {
  const path = targetsFile(baseDir)
  let created = false
  try {
    const file = await readTargets(baseDir)
    const at = new Date().toISOString()
    const row = file.targets.find((t) => t.id === input.id)
    if (row) {
      row.address = input.address
      row.label = input.label ?? row.label
      row.lastUsedAt = at
    } else {
      created = true
      file.targets.push({ id: input.id, address: input.address, label: input.label ?? '', createdAt: at, lastUsedAt: at })
    }
    await writeTargets(file, baseDir)
  } catch (error) {
    console.error('[iot] targets: upsert failed (' + String(error).slice(0, 160) + ')')
    throw error
  }
  return { created }
}

/** 删除单目标；返回是否确有删除（不存在为 false）。 */
export async function removeTarget(id: string, baseDir?: string): Promise<boolean> {
  const path = targetsFile(baseDir)
  let removed = false
  try {
    const file = await readTargets(baseDir)
    const next = file.targets.filter((t) => t.id !== id)
    if (next.length === file.targets.length) return false
    removed = true
    await writeTargets({ version: file.version, targets: next }, baseDir)
  } catch (error) {
    console.error('[iot] targets: remove failed (' + String(error).slice(0, 160) + ')')
  }
  return removed
}
