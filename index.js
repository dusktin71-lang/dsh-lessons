/**
 * dsh-ai-lessons — Host 半身
 *
 * 目标：把「AI 犯蠢的时刻」沉淀下来，并让本地模型在之后的每一次对话里
 * 都能看到这些教训，从而不再重复同一个错误。
 *
 * 三件事：
 *   1. 监听  —— 订阅全量会话事件（ctx.on('session/event', …, { global: true })），
 *               捕获用户消息、助手回复、工具结果。
 *   2. 判定  —— 自动识别负面反馈（"你又搞错了""不是这样"）与显式标记
 *               （"记一下：…"），也可记录工具报错；全部落盘。
 *   3. 注入  —— 通过 systemPrompt.section() 注册一个**动态**提示词段，
 *               每次组装请求时实时读取教训清单并渲染，做到"每次使用都带着经验"。
 *
 * 另外注册一组本地 HTTP 接口，供浏览器半身的面板读写。
 *
 * 所有 harness 能力都经 ctx 获取，任一缺失只会降级、不会让插件挂掉。
 *
 * @module index.js
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export const name = 'dsh-ai-lessons'
/** 不硬性依赖任何服务：缺了谁就降级谁，插件本体始终可用。 */
export const inject = []

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const DATA_DIR_NAME = 'ai-lessons'
const STATE_FILE_NAME = 'state.json'
const BOOT_LOG_FILE_NAME = 'boot.log'
const SECTION_NAME = 'dsh-ai-lessons:lessons'
const API_PATH = '/api/dsh-ai-lessons/rpc'
const SAVE_DEBOUNCE_MS = 400

const DEFAULT_CONFIG = {
  /** 总开关：关闭后任何会话都不注入。 */
  enabled: true,
  /** 是否自动识别用户的不满/纠正并记录。 */
  autoDetect: true,
  /** 是否把工具执行失败也记一条。 */
  recordToolErrors: false,
  /** 注入时最多带多少条教训。 */
  maxInject: 30,
  /** 单条教训注入时的最大字符数。 */
  maxLessonChars: 240,
  /** 新会话默认是否在生效范围内。 */
  defaultSessionEnabled: true,
  /** 注入到子智能体（subagent）的请求里。 */
  includeSubagents: false,
  /**
   * 首次加载后自动把右侧栏展开一次。
   * DSH 的右列宽度默认是 0（收起）且会持久化 —— 插件注册 tab 并不会
   * 把它拉开，所以不主动展开一次的话，用户根本不知道面板在哪。
   * 只做一次（见 state.panelAutoOpened），之后完全交给用户。
   */
  autoOpenPanel: true
}

/**
 * 负面反馈的强信号。命中任意一条即视为"AI 在这里让用户不爽了"。
 * 刻意保持保守：宁可漏记，也不要满屏噪声。
 */
const FEEDBACK_SIGNALS = [
  /(你|又|还)?(搞错|弄错|做错|写错|看错|理解错|答错|算错)/,
  /(不对|错了|不正确|有误)/,
  /不是(这个|这样|我要的|那个|这么)/,
  /(重新|重来|再来|再答|再看)(一遍|一次|一下)?/,
  /(没|不)(有)?(理解|明白|听懂|看懂|抓住)(我|我的)?(意思|重点)?/,
  /(胡说|乱说|瞎说|离谱|答非所问|驴唇不对马嘴)/,
  /(我说过|说过多少次|多少次了|第几次了)/,
  /(你怎么|为什么你)(又|会|老是|总是)/,
  /^(no|nope|wrong|incorrect|that's not)\b/i,
  /\b(you (are|'re) wrong|try again|redo|that's not what)\b/i
]

/** 用户明确要求"记下来"的写法。 */
const MANUAL_PATTERNS = [
  /^\/lesson\s+([\s\S]+)$/,
  /^\/教训\s+([\s\S]+)$/,
  /^(?:请)?(?:记一下|记下来|记录一下|记住|记得)[：:，,\s]*([\s\S]+)$/,
  /^(?:add lesson|remember)[：:\s]+([\s\S]+)$/i
]

/** 会话级开关的手写指令。 */
const TOGGLE_OFF_PATTERNS = [
  /^\/lessons\s+off$/i,
  /^\/教训\s*(?:关|关闭|off)$/i,
  /^(?:本轮|这次|本次)(?:对话)?(?:先)?(?:别用|不要用|不用)(?:教训|经验)$/,
  /^暂停(?:教训|经验)(?:注入)?$/
]
const TOGGLE_ON_PATTERNS = [
  /^\/lessons\s+on$/i,
  /^\/教训\s*(?:开|开启|on)$/i,
  /^(?:本轮|这次|本次)(?:对话)?(?:恢复|启用|开启)(?:教训|经验)$/,
  /^恢复(?:教训|经验)(?:注入)?$/
]

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function nowMs() {
  return Date.now()
}

function newId() {
  try {
    return 'L' + crypto.randomUUID().replace(/-/g, '').slice(0, 10)
  } catch {
    return 'L' + Math.random().toString(36).slice(2, 12)
  }
}

/** 从一条 message 中抽出纯文本（content 可能是字符串，也可能是 content block 数组）。 */
function messageText(message) {
  if (message == null) return ''
  if (typeof message === 'string') return message
  if (typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (block != null && typeof block === 'object') {
      if (typeof block.text === 'string') parts.push(block.text)
      else if (typeof block.content === 'string') parts.push(block.content)
    }
  }
  return parts.join('\n').trim()
}

function clamp(text, max) {
  if (typeof text !== 'string') return ''
  return text.length > max ? text.slice(0, max) + '…' : text
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */

export function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(ctx)
  const statePath = path.join(dataDir, STATE_FILE_NAME)
  const bootLogPath = path.join(dataDir, BOOT_LOG_FILE_NAME)

  /**
   * 启动自检日志。GUI 模式下拿不到 DSH 的宿主 stdout，这里自己留一份，
   * 用来确认「插件有没有被加载」「哪些能力没接上」。
   * 只追加，超过 64KB 就清空重来，不会无限膨胀。
   */
  function logBoot(fields) {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      if (fs.existsSync(bootLogPath) && fs.statSync(bootLogPath).size > 64 * 1024) {
        fs.writeFileSync(bootLogPath, '', 'utf8')
      }
      fs.appendFileSync(
        bootLogPath,
        JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...fields }) + '\n',
        'utf8'
      )
    } catch {
      /* 自检日志出问题不影响插件本身 */
    }
  }

  let harnessVersion = 'unknown'
  try {
    harnessVersion = ctx.get?.('harnessVersion') ?? ctx.get?.('version') ?? 'unknown'
  } catch {
    /* 拿不到就算了 */
  }
  logBoot({ event: 'apply', dataDir, harnessVersion, hasStateFile: fs.existsSync(statePath) })

  /** @type {State} */
  let state = loadState(statePath)
  let saveTimer = null
  /** 最近一次收到用户消息的会话 —— 用于判断"当前对话"的注入开关。 */
  let lastSessionId = null
  /** sessionId -> 最近一条助手回复的摘要，用于给"被纠正的时刻"提供上下文。 */
  const lastAnswer = new Map()

  /* -------------------- 持久化 -------------------- */

  function scheduleSave() {
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        fs.mkdirSync(dataDir, { recursive: true })
        const tmp = statePath + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
        fs.renameSync(tmp, statePath)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-ai-lessons: 写入失败 ${String(error)}`)
      }
    }, SAVE_DEBOUNCE_MS)
    saveTimer.unref?.()
  }

  ctx.effect(() => () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
      try {
        fs.mkdirSync(dataDir, { recursive: true })
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
      } catch {
        /* 卸载路径上不再抱怨 */
      }
    }
  }, 'dsh-ai-lessons: flush state')

  /* -------------------- 教训读写 -------------------- */

  function lessonsOf(sessionId) {
    const cfg = state.config
    if (!cfg.enabled) return []
    if (!sessionEnabled(sessionId)) return []
    return state.lessons
      .filter((lesson) => lesson.enabled !== false)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, Math.max(1, cfg.maxInject | 0 || DEFAULT_CONFIG.maxInject))
  }

  function sessionEnabled(sessionId) {
    if (!sessionId) return state.config.defaultSessionEnabled
    const override = state.sessionOverrides?.[sessionId]
    return typeof override === 'boolean' ? override : state.config.defaultSessionEnabled
  }

  function addLesson(input, meta = {}) {
    const text = oneLine(input?.text)
    if (text === '') return null
    const lesson = {
      id: newId(),
      text: clamp(text, 600),
      category: input?.category ?? 'manual',
      trigger: typeof input?.trigger === 'string' ? clamp(oneLine(input.trigger), 300) : '',
      answer: typeof input?.answer === 'string' ? clamp(oneLine(input.answer), 300) : '',
      enabled: true,
      hits: 0,
      createdAt: nowMs(),
      updatedAt: nowMs(),
      sessionId: meta.sessionId ?? null,
      cwd: meta.cwd ?? null
    }
    state.lessons.unshift(lesson)
    if (state.lessons.length > 500) state.lessons.length = 500
    state.stats.totalRecorded = (state.stats.totalRecorded ?? 0) + 1
    scheduleSave()
    return lesson
  }

  function renderInjection(sessionId) {
    const lessons = lessonsOf(sessionId)
    if (lessons.length === 0) return ''
    const cfg = state.config
    const lines = []
    for (const lesson of lessons) {
      let body = clamp(oneLine(lesson.text), Math.max(40, cfg.maxLessonChars | 0 || 240))
      if (lesson.trigger) body += `\n   · 当时用户的反应：“${clamp(oneLine(lesson.trigger), 120)}”`
      if (lesson.answer) body += `\n   · 当时 AI 的回答要点：${clamp(oneLine(lesson.answer), 120)}`
      lines.push(`- ${body}`)
    }
    return [
      '## 历史教训（此前对话中被明确纠正过的问题）',
      '',
      '下面是用户在过去的对话里明确表达过不满、或主动要求牢记的事项。',
      '请在本次回答中主动规避这些错误；与当前任务无关的条目可以忽略，但不要重复犯同样的错。',
      '',
      ...lines
    ].join('\n')
  }

  /* -------------------- 判定引擎 -------------------- */

  /** @returns {{kind:'manual'|'toggle'|'feedback'|null, text?:string, enabled?:boolean}} */
  function classifyUserText(raw) {
    const text = (raw ?? '').trim()
    if (text === '') return { kind: null }

    for (const re of MANUAL_PATTERNS) {
      const m = re.exec(text)
      if (m && m[1] && m[1].trim() !== '') return { kind: 'manual', text: m[1].trim() }
    }
    if (TOGGLE_OFF_PATTERNS.some((re) => re.test(text))) return { kind: 'toggle', enabled: false }
    if (TOGGLE_ON_PATTERNS.some((re) => re.test(text))) return { kind: 'toggle', enabled: true }

    if (!state.config.autoDetect) return { kind: null }
    if (text.length > 120) return { kind: null }          // 长文多半是在正常说话
    if (text.startsWith('/')) return { kind: null }        // 斜杠命令交给命令系统
    const hits = FEEDBACK_SIGNALS.filter((re) => re.test(text)).length
    if (hits === 0) return { kind: null }
    // 只有很短的抱怨才自动入库，降低误判
    if (hits === 1 && text.length > 50) return { kind: null }
    return { kind: 'feedback', text }
  }

  /* -------------------- 事件监听 -------------------- */

  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type
      const sessionId = typeof session?.id === 'string' ? session.id : null
      if (sessionId !== null) lastSessionId = sessionId

      if (type === 'assistant/message') {
        const text = messageText(event?.data?.message)
        if (sessionId !== null && text !== '') lastAnswer.set(sessionId, clamp(oneLine(text), 220))
        return
      }

      if (type === 'tool/result') {
        if (!state.config.recordToolErrors) return
        const message = event?.data?.message
        if (message?.isError !== true) return
        const detail = messageText(message)
        addLesson(
          { text: `工具调用失败：${detail || '未知错误'}`, category: 'tool-error' },
          { sessionId, cwd: session?.cwd }
        )
        return
      }

      if (type !== 'user/message') return

      const raw = messageText(event?.data)
      const verdict = classifyUserText(raw)
      if (verdict.kind === null) return

      if (verdict.kind === 'toggle') {
        if (sessionId === null) return
        state.sessionOverrides = state.sessionOverrides ?? {}
        state.sessionOverrides[sessionId] = verdict.enabled
        scheduleSave()
        ctx.logger?.info?.(`dsh-ai-lessons: 会话 ${sessionId} 教训注入 ${verdict.enabled ? '开启' : '关闭'}`)
        return
      }

      if (verdict.kind === 'manual') {
        addLesson(
          { text: verdict.text, category: 'manual', trigger: raw },
          { sessionId, cwd: session?.cwd }
        )
        ctx.logger?.info?.('dsh-ai-lessons: 已记录一条手动教训')
        return
      }

      // feedback：把用户的原话 + 当时被纠正的回答一起留档
      const previous = sessionId !== null ? lastAnswer.get(sessionId) : ''
      addLesson(
        {
          text: `避免重复这个问题：用户当时说“${clamp(oneLine(raw), 120)}”。`,
          category: 'feedback',
          trigger: raw,
          answer: previous
        },
        { sessionId, cwd: session?.cwd }
      )
      ctx.logger?.info?.('dsh-ai-lessons: 已记录一条用户反馈')
    } catch (error) {
      ctx.logger?.warn?.(`dsh-ai-lessons: 事件处理失败 ${String(error)}`)
    }
  }, { global: true })

  /* -------------------- 系统提示词注入 -------------------- */

  ctx.inject(['systemPrompt'], (inner) => {
    try {
      const systemPrompt = inner.systemPrompt
      if (systemPrompt == null || typeof systemPrompt.section !== 'function') {
        logBoot({ event: 'section', ok: false, reason: 'systemPrompt.section 不可用' })
        return
      }
      const anchor = typeof systemPrompt.getSectionOrder === 'function'
        ? systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
        : undefined
      const order = Number.isFinite(anchor) ? anchor + 1 : 10201
      systemPrompt.section({
        name: SECTION_NAME,
        order,
        // 关键：每次组装请求时现算，所以"记录即生效"，无需重启。
        text: () => renderInjection(lastSessionId),
        interpolate: false
      })
      logBoot({ event: 'section', ok: true, name: SECTION_NAME, order, anchor: anchor ?? null })
      ctx.logger?.info?.('dsh-ai-lessons: 系统提示词注入已就绪')
    } catch (error) {
      logBoot({ event: 'section', ok: false, reason: String(error) })
      ctx.logger?.warn?.(`dsh-ai-lessons: 注入失败 ${String(error)}`)
    }
  })

  /* -------------------- 浏览器半身用的本地接口 -------------------- */

  ctx.inject(['connection'], (inner) => {
    try {
      const connection = inner.get('connection')
      const register = connection?.fetch?.register
      if (typeof register !== 'function') {
        logBoot({ event: 'route', ok: false, reason: 'connection.fetch.register 不可用' })
        return
      }
      inner.effect(() => register({
        path: API_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body = {}
          try {
            body = await request.json()
          } catch {
            body = {}
          }
          const result = await dispatch(String(body?.op ?? ''), body ?? {}, lastSessionId)
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
          })
        }
      }), 'dsh-ai-lessons: rpc route')
      logBoot({ event: 'route', ok: true, path: API_PATH })
      ctx.logger?.info?.(`dsh-ai-lessons: 已挂载 ${API_PATH}`)
    } catch (error) {
      logBoot({ event: 'route', ok: false, reason: String(error) })
      ctx.logger?.warn?.(`dsh-ai-lessons: 接口挂载失败 ${String(error)}`)
    }
  })

  async function dispatch(op, body, currentSession) {
    try {
      switch (op) {
        case 'state':
          return ok({
            config: state.config,
            lessons: state.lessons,
            stats: state.stats,
            currentSessionId: currentSession,
            currentSessionEnabled: sessionEnabled(currentSession),
            panelAutoOpened: state.panelAutoOpened === true,
            preview: renderInjection(currentSession)
          })

        case 'setConfig': {
          const patch = body.config ?? {}
          for (const key of Object.keys(DEFAULT_CONFIG)) {
            if (key in patch) state.config[key] = patch[key]
          }
          scheduleSave()
          return ok({ config: state.config })
        }

        case 'add': {
          const lesson = addLesson({ text: body.text, category: body.category ?? 'manual' })
          if (lesson === null) return fail('教训内容不能为空')
          return ok({ lesson })
        }

        case 'update': {
          const lesson = state.lessons.find((item) => item.id === body.id)
          if (!lesson) return fail('未找到该教训')
          if (typeof body.text === 'string' && oneLine(body.text) !== '') lesson.text = clamp(oneLine(body.text), 600)
          if (typeof body.enabled === 'boolean') lesson.enabled = body.enabled
          if (typeof body.category === 'string') lesson.category = body.category
          lesson.updatedAt = nowMs()
          scheduleSave()
          return ok({ lesson })
        }

        case 'delete': {
          const before = state.lessons.length
          state.lessons = state.lessons.filter((item) => item.id !== body.id)
          if (state.lessons.length === before) return fail('未找到该教训')
          scheduleSave()
          return ok({ removed: before - state.lessons.length })
        }

        case 'clear':
          state.lessons = []
          scheduleSave()
          return ok({ lessons: [] })

        case 'toggleSession': {
          const target = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : currentSession
          if (!target) return fail('当前没有可操作的会话')
          const next = typeof body.enabled === 'boolean' ? body.enabled : !sessionEnabled(target)
          state.sessionOverrides = state.sessionOverrides ?? {}
          state.sessionOverrides[target] = next
          scheduleSave()
          return ok({ sessionId: target, enabled: next })
        }

        case 'preview':
          return ok({ preview: renderInjection(currentSession) })

        // 浏览器半身首次自动展开右栏成功后回报，免得以后每次启动都强行展开。
        case 'markPanelOpened':
          state.panelAutoOpened = true
          scheduleSave()
          return ok({ panelAutoOpened: true })

        // 浏览器半身上报自己的加载情况 —— 面板没出现时用来定位问题。
        case 'debug':
          logBoot({ event: 'client-report', payload: body ?? {} })
          return ok({ logged: true })

        default:
          return fail(`未知操作：${op}`)
      }
    } catch (error) {
      return fail(String(error))
    }
  }
}

/* ------------------------------------------------------------------ *
 * 状态文件
 * ------------------------------------------------------------------ */

function ok(value) {
  return { ok: true, value }
}

function fail(error) {
  return { ok: false, error: String(error) }
}

function resolveDataDir(ctx) {
  try {
    const home = ctx.get?.('dshHomePath')
    if (typeof home === 'function') {
      const resolved = home(DATA_DIR_NAME)
      if (typeof resolved === 'string' && resolved !== '') return resolved
    }
  } catch {
    /* 落到默认值 */
  }
  return path.join(os.homedir(), '.dsh', DATA_DIR_NAME)
}

function loadState(statePath) {
  const empty = {
    version: 1,
    config: { ...DEFAULT_CONFIG },
    lessons: [],
    sessionOverrides: {},
    panelAutoOpened: false,
    stats: { totalRecorded: 0 }
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object') return empty
    return {
      version: 1,
      config: { ...DEFAULT_CONFIG, ...(parsed.config ?? {}) },
      lessons: Array.isArray(parsed.lessons) ? parsed.lessons.filter((item) => item != null && typeof item === 'object') : [],
      sessionOverrides: parsed.sessionOverrides != null && typeof parsed.sessionOverrides === 'object' ? parsed.sessionOverrides : {},
      panelAutoOpened: parsed.panelAutoOpened === true,
      stats: parsed.stats != null && typeof parsed.stats === 'object' ? parsed.stats : { totalRecorded: 0 }
    }
  } catch {
    return empty
  }
}

/** 供自检脚本导入（不参与运行时逻辑）。 */
export const __internals = { messageText, FEEDBACK_SIGNALS, MANUAL_PATTERNS, DEFAULT_CONFIG }
