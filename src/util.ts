/** Small pure helpers shared by the iot Source: payload hashing, MQTT topic
 *  filter matching, dot-path extraction and alert comparison. */
import crypto from 'node:crypto'

export function hash8(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex').slice(0, 8)
}

export function randomHex(length = 8): string {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length)
}

/** MQTT wildcard match: '+' matches exactly one level, '#' matches the rest. */
export function matchTopicFilter(filter: string, topic: string): boolean {
  const parts = filter.split('/')
  const levels = topic.split('/')
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '#') return true
    if (i >= levels.length) return false
    if (parts[i] !== '+' && parts[i] !== levels[i]) return false
  }
  return parts.length === levels.length
}

/** Dot path getter over parsed JSON: 'a.b.0.c'. Returns undefined when absent. */
export function dotPath(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const segment of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      current = Number.isInteger(index) ? current[index] : undefined
    } else {
      current = (current as Record<string, unknown>)[segment]
    }
  }
  return current
}

export function compare(actual: number, op: string, threshold: number): boolean {
  switch (op) {
    case '>': return actual > threshold
    case '>=': return actual >= threshold
    case '<': return actual < threshold
    case '<=': return actual <= threshold
    case '==': return actual === threshold
    case '!=': return actual !== threshold
    default: return false
  }
}
