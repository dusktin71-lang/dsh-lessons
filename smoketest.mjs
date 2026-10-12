/**
 * 冒烟测试：用假的 ctx 跑一遍 Host 半身，验证
 *   1. apply() 能正常装载（不会因为缺少服务而抛错）
 *   2. session/event 能触发"愚蠢时刻"入库
 *   3. systemPrompt.section 注册的 text() 每次都能拿到最新教训
 *   4. 本地 RPC 接口可读可写
 *
 * 运行： node smoketest.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lessons-'))

const mod = await import(pathToFileURL(path.join(here, 'index.js')).href)

/* ---------------- 假 ctx ---------------- */

const handlers = new Map()
const disposers = []
let section = null
let routeOptions = null

const systemPrompt = {
  section(definition) {
    section = definition
    return () => { section = null }
  },
  getSectionOrder(name) {
    return name === 'DEPLOYMENT_PERSONA_SUFFIX' ? 10200 : undefined
  }
}

const connection = {
  fetch: {
    register(options) {
      routeOptions = options
      return () => { routeOptions = null }
    }
  }
}

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get(name) {
    if (name === 'dshHomePath') return (sub) => path.join(tmp, sub)
    if (name === 'connection') return connection
    return undefined
  },
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose ?? (() => {})
  },
  inject(deps, callback) {
    if (deps.includes('systemPrompt')) callback({ systemPrompt, get: ctx.get })
    else if (deps.includes('connection')) callback({ ...ctx, get: ctx.get })
    else callback(ctx)
    return () => {}
  }
}

/* ---------------- 装载 ---------------- */

mod.apply(ctx, {})
assert.ok(section, '应注册系统提示词段')
assert.equal(section.interpolate, false, 'interpolate 必须为 false（避免 {{}} 被当作变量）')
assert.ok(Number.isFinite(section.order), 'order 必须是有限数字')
assert.ok(routeOptions, '应注册 RPC 路由')
console.log('ok   apply() 装载完成')
console.log(`     section.name = ${section.name}, order = ${section.order}`)
console.log(`     route = ${routeOptions.path} [${routeOptions.methods.join(',')}]`)

const emit = (type, data, sessionId = 'sess-1') =>
  handlers.get('session/event')?.({ id: sessionId, cwd: 'C:/tmp/demo' }, { type, data, seq: 1, time: Date.now() })

/* ---------------- 注入初始应为空 ---------------- */

assert.equal(section.text(), '', '还没记录任何教训时不应注入')
console.log('ok   初始注入为空')

/* ---------------- 自动识别：负面反馈 ---------------- */

emit('assistant/message', { message: { content: [{ type: 'text', text: '好的，我已经删除了那个文件夹。' }] } })
emit('user/message', { content: [{ type: 'text', text: '你又搞错了，我根本没让你删东西' }] })

let injected = section.text()
assert.ok(injected.includes('历史教训'), '应生成注入文本')
assert.ok(injected.includes('你又搞错了'), '应引用用户原话')
assert.ok(injected.includes('删除了那个文件夹'), '应带上当时被纠正的回答要点')
console.log('ok   自动识别到负面反馈并入库')

/* ---------------- 显式标记 ---------------- */

emit('user/message', { content: [{ type: 'text', text: '记一下：动手删除文件前必须先问我' }] })
injected = section.text()
assert.ok(injected.includes('动手删除文件前必须先问我'), '手动教训应进入注入文本')
console.log('ok   显式标记可入库')

/* ---------------- 正常对话不应污染 ---------------- */

const before = (await callRpc({ op: 'state' })).lessons.length
emit('user/message', { content: [{ type: 'text', text: '帮我把这段代码改成异步的' }] })
assert.equal((await callRpc({ op: 'state' })).lessons.length, before, '正常提问不该被记录')
console.log('ok   正常提问不会被误记')

/* ---------------- 会话级开关 ---------------- */

emit('user/message', { content: [{ type: 'text', text: '/lessons off' }] })
assert.equal(section.text(), '', '关闭后本会话不再注入')
emit('user/message', { content: [{ type: 'text', text: '/lessons on' }] })
assert.ok(section.text().includes('历史教训'), '重新开启后恢复注入')
console.log('ok   会话级开关生效（/lessons off / on）')

/* ---------------- RPC ---------------- */

async function callRpc(body) {
  const response = await routeOptions.fetch({ json: async () => body })
  const json = await response.json()
  assert.equal(json.ok, true, `RPC ${body.op} 失败: ${json.error}`)
  return json.value
}

const stateAfter = await callRpc({ op: 'state' })
assert.equal(stateAfter.lessons.length, 2, '应有 2 条教训')
assert.equal(stateAfter.config.enabled, true)
assert.ok(stateAfter.preview.includes('历史教训'))
console.log('ok   RPC state 正常')

const added = await callRpc({ op: 'add', text: '回答前先确认我的意图' })
assert.ok(added.lesson?.id, 'add 应返回新条目')
console.log('ok   RPC add 正常')

const toggled = await callRpc({ op: 'toggleSession', enabled: false })
assert.equal(toggled.enabled, false)
assert.equal(section.text(), '', 'RPC 关闭会话后应停止注入')
await callRpc({ op: 'toggleSession', enabled: true })
console.log('ok   RPC toggleSession 正常')

await callRpc({ op: 'update', id: added.lesson.id, enabled: false })
assert.ok(!section.text().includes('回答前先确认我的意图'), '停用后该条不该出现')
console.log('ok   RPC update 正常')

await callRpc({ op: 'delete', id: added.lesson.id })
assert.equal((await callRpc({ op: 'state' })).lessons.length, 2)
console.log('ok   RPC delete 正常')

// 首次自动展开右栏的标记：默认未展开；回报后置位且不再重复。
assert.equal(stateAfter.panelAutoOpened, false, '默认应未自动展开过')
assert.equal(stateAfter.config.autoOpenPanel, true, '默认应允许自动展开一次')
const marked = await callRpc({ op: 'markPanelOpened' })
assert.equal(marked.panelAutoOpened, true)
assert.equal((await callRpc({ op: 'state' })).panelAutoOpened, true, '标记应持久化在状态里')
console.log('ok   自动展开标记（markPanelOpened）正常')

/* ---------------- 落盘 ---------------- */

for (const dispose of disposers.splice(0)) {
  try { dispose() } catch { /* ignore */ }
}
const stateFile = path.join(tmp, 'ai-lessons', 'state.json')
assert.ok(fs.existsSync(stateFile), `状态文件应已写入：${stateFile}`)
const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
assert.equal(persisted.lessons.length, 2, '落盘内容应一致')
assert.equal(persisted.sessionOverrides['sess-1'], true, '会话开关应落盘')
console.log('ok   状态已持久化到 ' + stateFile)

/* ---------------- 卸载不应抛错 ---------------- */

mod.apply({ ...ctx, inject: () => () => {} }, {})
console.log('ok   重复装载不会抛错')

console.log('\n=== 冒烟测试全部通过 ✔ ===')
fs.rmSync(tmp, { recursive: true, force: true })
