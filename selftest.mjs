/**
 * 自检脚本：校验 Host 半身的语法、导出、以及"愚蠢时刻"判定规则。
 * 运行： node selftest.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const mod = await import(pathToFileURL(path.join(here, 'index.js')).href)
assert.equal(mod.name, 'dsh-ai-lessons', 'name 导出')
assert.equal(typeof mod.apply, 'function', 'apply 导出')
assert.ok(Array.isArray(mod.inject), 'inject 导出')

const { messageText, DEFAULT_CONFIG } = mod.__internals
assert.ok(DEFAULT_CONFIG.enabled === true)

// --- messageText ---
assert.equal(messageText({ content: 'hello' }), 'hello')
assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
assert.equal(messageText(null), '')
assert.equal(messageText({ content: [{ type: 'image' }] }), '')

// --- 判定规则：复刻 index.js 内部的 classifyUserText ---
const {
  FEEDBACK_SIGNALS,
  MANUAL_PATTERNS
} = mod.__internals

function classify(text, cfg = { autoDetect: true }) {
  const raw = (text ?? '').trim()
  if (raw === '') return null
  for (const re of MANUAL_PATTERNS) {
    const m = re.exec(raw)
    if (m && m[1] && m[1].trim() !== '') return { kind: 'manual', text: m[1].trim() }
  }
  if (raw.length > 120) return null
  if (raw.startsWith('/')) return null
  const hits = FEEDBACK_SIGNALS.filter((re) => re.test(raw)).length
  if (hits === 0) return null
  if (hits === 1 && raw.length > 50) return null
  return { kind: 'feedback', text: raw }
}

const cases = [
  ['你又搞错了，我要的是 A 不是 B', 'feedback'],
  ['不对', 'feedback'],
  ['不是这样的', 'feedback'],
  ['重新做一遍', 'feedback'],
  ['你没理解我的意思', 'feedback'],
  ['答非所问', 'feedback'],
  ['我说过多少次了', 'feedback'],
  ['wrong', 'feedback'],
  ['记一下：不要擅自删除文件', 'manual'],
  ['记住：先说结论再展开', 'manual'],
  ['/lesson 不要用 emoji', 'manual'],
  ['今天天气怎么样？', null],
  ['帮我写一个 Python 脚本', null],
  ['这个函数的作用是什么', null],
  ['请把这份文档翻译成英文，注意保留原有的标题层级和表格结构，不要改变术语的译法', null],
  ['/context', null]
]

let failed = 0
for (const [input, expected] of cases) {
  const got = classify(input)
  const kind = got?.kind ?? null
  const pass = kind === expected
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${JSON.stringify(input)} -> ${kind} (期望 ${expected})`)
}

// 长度保护：长抱怨不自动入库
assert.equal(classify('你又搞错了'.repeat(30)), null, '超长文本不应自动记录')

console.log('\n=== 结果 ===')
console.log(failed === 0 ? '全部通过 ✔' : `${failed} 条失败 ✘`)
process.exit(failed === 0 ? 0 : 1)
