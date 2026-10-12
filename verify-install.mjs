/**
 * 安装后校验：确认插件在 DSH 里能被正确发现与加载。
 * 运行： node verify-install.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)))
const profile = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')

let bad = 0
const check = (label, pass, detail = '') => {
  if (!pass) bad++
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

/* 1. 链接 */
const linked = path.join(profile, 'node_modules', 'dsh-ai-lessons')
check('node_modules/dsh-ai-lessons 存在', fs.existsSync(linked))
if (fs.existsSync(linked)) {
  check('  指向本目录（单一源码）', fs.realpathSync(linked) === here, fs.realpathSync(linked))
}

/* 2. profile 注册 */
const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
check('已登记为 bundle', (pkg.dsh?.profile?.bundles ?? []).includes('dsh-ai-lessons'))
check('已声明依赖', Boolean(pkg.dependencies?.['dsh-ai-lessons']), pkg.dependencies?.['dsh-ai-lessons'])

/* 3. 插件清单 */
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))
check('package.json name 正确', manifest.name === 'dsh-ai-lessons')
check('exports["."] 指向宿主半身', manifest.exports?.['.'] === './index.js')
check('exports["./client"] 指向浏览器半身', manifest.exports?.['./client'] === './client.js')
check('dsh.bundle.patch 已声明', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('dsh.client.platform = web', manifest.dsh?.client?.platform === 'web')

/* 4. cordis.patch.yml */
const patch = fs.readFileSync(path.join(here, 'cordis.patch.yml'), 'utf8')
check('patch 含 insert 行', /insert:/.test(patch) && /dsh-ai-lessons/.test(patch))

/* 5. 宿主半身可导入 */
const host = await import(pathToFileURL(path.join(here, 'index.js')).href)
check('宿主半身导出 name/apply/inject',
  host.name === 'dsh-ai-lessons' && typeof host.apply === 'function' && Array.isArray(host.inject))

/* 6. 浏览器半身结构 */
const client = fs.readFileSync(path.join(here, 'client.js'), 'utf8')
check('浏览器半身使用 __ModuleLoader__', client.includes('window.__ModuleLoader__.load'))
check('浏览器半身要求 react', client.includes("req('react')"))
check('浏览器半身注册侧边栏标签', client.includes('sidebar.right.pane.tab'))
check('浏览器半身调用 RPC 接口', client.includes('/api/dsh-ai-lessons/rpc'))

/* 7. 数据目录 */
const dataDir = path.join(os.homedir(), '.dsh', 'ai-lessons')
console.log(`\n数据目录（首次记录时自动创建）：${dataDir}`)
if (fs.existsSync(dataDir)) {
  for (const file of fs.readdirSync(dataDir)) console.log(`  · ${file}`)
} else {
  console.log('  （尚未创建，正常）')
}

console.log(`\n=== ${bad === 0 ? '全部通过 ✔ 重启 DSH 后即可使用' : bad + ' 项失败 ✘'} ===`)
process.exit(bad === 0 ? 0 : 1)
