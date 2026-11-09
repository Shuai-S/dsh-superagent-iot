// 零依赖发布完整性闸门（CI 与本地同一入口）：
// 1) package.json files[] 在磁盘上全部存在
// 2) lib/index.js 含 'sources.register(' 与 kind 名探针（不带引号子串，兼容产物引号风格）
// 3) cordis.patch.yml - id: 与包名一致
// 4) locale/zh.json 与 en.json 可解析且顶层 key 集合一致
// 5) icon.svg 存在
// 6) dsh.compatibility 已声明
// 失败逐条打印后 exit 1；全部通过打印 verify-package: OK。
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const KIND = 'iot'
const root = resolve(import.meta.dirname, '..')
const failures = []

const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

// 1) files[] 完整性
for (const rel of manifest.files ?? []) {
  try { await stat(resolve(root, rel)) } catch { failures.push('files 缺失：' + rel) }
}

// 2) lib/index.js 构建产物探针
try {
  const code = await readFile(resolve(root, 'lib', 'index.js'), 'utf8')
  if (!code.includes('sources.register(')) failures.push('lib/index.js 缺 sources.register( 探针（Source 未注册？）')
  if (!code.includes(KIND)) failures.push('lib/index.js 缺 kind 名探针：' + KIND)
} catch {
  failures.push('lib/index.js 不存在（先 pnpm check 构建）')
}

// 3) cordis.patch.yml 入口 id 与包名一致
try {
  const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
  const ids = [...patch.matchAll(/- id:\s*(\S+)/g)].map((m) => m[1])
  if (!ids.includes(manifest.name)) failures.push('cordis.patch.yml - id 与包名不一致：' + JSON.stringify(ids) + ' vs ' + manifest.name)
} catch (e) {
  failures.push('cordis.patch.yml 读取失败：' + e.message)
}

// 4) locale 双语可解析且顶层 key 集合一致
const keysOf = async (loc) => Object.keys(JSON.parse(await readFile(resolve(root, 'locale', loc + '.json'), 'utf8'))).sort()
let zhKeys, enKeys
try { zhKeys = await keysOf('zh') } catch (e) { failures.push('locale/zh.json 解析失败：' + e.message) }
try { enKeys = await keysOf('en') } catch (e) { failures.push('locale/en.json 解析失败：' + e.message) }
if (zhKeys && enKeys && JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  failures.push('locale 顶层 key 不一致 zh=' + JSON.stringify(zhKeys) + ' en=' + JSON.stringify(enKeys))
}

// 5) icon.svg
try { await stat(resolve(root, 'icon.svg')) } catch { failures.push('icon.svg 缺失') }

// 6) dsh.compatibility
if (!manifest.dsh?.compatibility?.dsh || !manifest.dsh?.compatibility?.dshReleases) {
  failures.push('package.json 缺 dsh.compatibility（dsh + dshReleases）声明')
}

if (failures.length) {
  console.error('verify-package: FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log('verify-package: OK')
