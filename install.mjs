/**
 * 把 dsh-ai-lessons 安装进 DSH 的 desktop profile。
 *
 * 做法：
 *   1. 在 profile 的 package.json 里加一条 `link:` 依赖，指向本目录
 *      —— 所以源码始终只有这一份，改完重启 DSH 即生效；
 *   2. 在 `dsh.profile.bundles` 里登记 `dsh-ai-lessons`，让内核加载它；
 *   3. 用 DSH 自带的 pnpm 建立链接。
 *
 * 用法：node install.mjs [--profile <路径>] [--no-install]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)))
const PKG_NAME = 'dsh-ai-lessons'

const argv = process.argv.slice(2)
const getFlag = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const skipInstall = argv.includes('--no-install')

let profileDir = getFlag('--profile')
if (!profileDir) {
  profileDir = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
}
profileDir = path.resolve(profileDir)

if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
  console.error(`找不到 DSH profile：${profileDir}`)
  console.error('请用 --profile <路径> 指定正确位置。')
  process.exit(1)
}

console.log(`插件源码：${here}`)
console.log(`目标 profile：${profileDir}\n`)

/* ---------------- 1. package.json ---------------- */

const pkgPath = path.join(profileDir, 'package.json')
const raw = fs.readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(raw)

const backup = `${pkgPath}.bak-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
if (!fs.existsSync(backup)) {
  fs.writeFileSync(backup, raw, 'utf8')
  console.log(`已备份 package.json -> ${path.basename(backup)}`)
}

/** 用相对路径表述，避免绝对路径写死在配置里。 */
let linkSpec = path.relative(profileDir, here).split(path.sep).join('/')
if (!linkSpec.startsWith('.')) linkSpec = './' + linkSpec

pkg.dependencies = pkg.dependencies ?? {}
const previous = pkg.dependencies[PKG_NAME]
pkg.dependencies[PKG_NAME] = `link:${linkSpec}`
if (previous === pkg.dependencies[PKG_NAME]) console.log(`依赖已是 link:${linkSpec}（未变化）`)
else console.log(`依赖 ${PKG_NAME}: ${previous ?? '(新增)'} -> link:${linkSpec}`)

pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
if (!bundles.includes(PKG_NAME)) {
  bundles.push(PKG_NAME)
  console.log(`bundle 列表已追加 ${PKG_NAME}`)
} else {
  console.log('bundle 列表已包含该插件（未变化）')
}
pkg.dsh.profile.bundles = bundles

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log('package.json 已更新\n')

/* ---------------- 2. 建立链接 ---------------- */

function linkTarget() {
  return path.join(profileDir, 'node_modules', PKG_NAME)
}

/** 已经指向本目录就不用再动 —— 保证脚本可以反复执行。 */
function alreadyLinked() {
  const target = linkTarget()
  try {
    return fs.realpathSync(target) === here
  } catch {
    return false
  }
}

function manualLink() {
  const target = linkTarget()
  try {
    if (fs.lstatSync(target, { throwIfNoEntry: false })) {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 })
    }
  } catch {
    /* 交给下面重建 */
  }
  const result = spawnSync('cmd', ['/c', 'mklink', '/J', target, here], { stdio: 'ignore' })
  if (result.status === 0 && fs.existsSync(target)) {
    console.log(`已建立目录联接：node_modules/${PKG_NAME}`)
    return true
  }
  try {
    fs.cpSync(here, target, { recursive: true })
    console.log(`目录联接不可用，已改为复制到 node_modules/${PKG_NAME}`)
    return true
  } catch (error) {
    console.error(`无法建立 ${PKG_NAME}：${String(error)}`)
    return false
  }
}

if (skipInstall) {
  console.log('已跳过安装步骤（--no-install）')
} else if (alreadyLinked()) {
  console.log(`node_modules/${PKG_NAME} 已指向本目录，无需重新链接`)
} else {
  const pnpmCandidates = [
    path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'),
    path.join(profileDir, '..', '..', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
  ]
  const pnpm = pnpmCandidates.find((candidate) => fs.existsSync(candidate))
  let installed = false
  if (!pnpm) {
    console.log('未找到 DSH 自带的 pnpm，改用目录联接。')
  } else {
    console.log(`使用 pnpm：${pnpm}`)
    const result = spawnSync(process.execPath, [pnpm, 'install', '--prefer-offline'], {
      cwd: profileDir,
      stdio: 'inherit'
    })
    installed = result.status === 0
    if (!installed) console.log('\npnpm install 未成功，改用目录联接。')
  }
  if (!installed && !manualLink()) process.exit(1)
}

/* ---------------- 3. 校验 ---------------- */

const linked = path.join(profileDir, 'node_modules', PKG_NAME)
if (fs.existsSync(linked)) {
  console.log(`\n✔ 已链接：node_modules/${PKG_NAME}`)
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'package.json']) {
    if (!fs.existsSync(path.join(linked, file))) console.warn(`  ⚠ 缺少 ${file}`)
  }
} else {
  console.log(`\n⚠ node_modules/${PKG_NAME} 尚不存在，可能需要在 DSH 里重装或手动 pnpm install。`)
}

console.log('\n安装完成。重启 DSH（DeepSeek Harness）后，右侧栏会出现「AI 教训」标签页。')
