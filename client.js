/**
 * dsh-ai-lessons — 浏览器半身
 *
 * 在 DSH 右侧栏注册一个 "AI 教训" 面板：
 *   · 查看 / 编辑 / 删除已记录的教训
 *   · 手动补录一条教训
 *   · 总开关、自动识别开关、注入预览
 *   · 针对"当前会话"单独开关（新开对话后可自行决定要不要带着经验）
 *
 * 打包格式与官方插件一致：window.__ModuleLoader__ 提供 load()，factory 收到一个
 * require 函数，用来拿 react / react-dom / UI 原语。无需构建步骤。
 */

window.__ModuleLoader__.load({
  id: 'dsh-ai-lessons',
  factory: (req) => {
    const t = { exports: {} }
    const React = req('react')
    const h = React.createElement

    /** UI 原语是可选的：拿不到就全部用原生元素。 */
    let primitives = null
    try {
      primitives = req('@deepseek-ai/dsh-client-ui-primitives') ?? null
    } catch {
      primitives = null
    }

    /** 引导页入口的配图：官方类型的 guide 条目都带一个，缺了会显得突兀。 */
    const GUIDE_ICON = primitives?.GuideArtworkFiles ?? primitives?.GuideArtworkBrowser ?? null

    const NS = 'dsh-ai-lessons'
    const API = '/api/dsh-ai-lessons/rpc'
    const TAB_ID = 'dsh-ai-lessons'

    const DICT = {
      zh: {
        'panel.title': 'AI 教训',
        'panel.subtitle': '记录犯过的错，下次不再重复',
        'tab.label': 'AI 教训',
        'guide.desc': '查看并管理 AI 的历史教训，可随手补录；这些条目会自动进入每次对话的系统提示词。'
      },
      en: {
        'panel.title': 'AI Lessons',
        'panel.subtitle': 'Log the mistakes, stop repeating them',
        'tab.label': 'AI Lessons',
        'guide.desc': 'Review and manage the AI lessons. Every entry is injected into the system prompt of each new turn.'
      }
    }

    /** 与主题无关即可读的中性配色（明暗主题都能用）。 */
    const S = {
      root: {
        height: '100%',
        boxSizing: 'border-box',
        overflowY: 'auto',
        padding: '12px 12px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        fontSize: 13,
        lineHeight: 1.55,
        color: 'inherit'
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      card: {
        border: '1px solid rgba(128,128,128,.30)',
        borderRadius: 8,
        padding: '9px 10px',
        background: 'rgba(128,128,128,.07)'
      },
      btn: {
        cursor: 'pointer',
        border: '1px solid rgba(128,128,128,.38)',
        background: 'rgba(128,128,128,.12)',
        color: 'inherit',
        borderRadius: 6,
        padding: '3px 9px',
        fontSize: 12,
        fontFamily: 'inherit'
      },
      btnOn: {
        cursor: 'pointer',
        border: '1px solid rgba(64,160,110,.65)',
        background: 'rgba(64,160,110,.20)',
        color: 'inherit',
        borderRadius: 6,
        padding: '3px 9px',
        fontSize: 12,
        fontFamily: 'inherit'
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        border: '1px solid rgba(128,128,128,.38)',
        background: 'rgba(0,0,0,.06)',
        color: 'inherit',
        borderRadius: 6,
        padding: '5px 7px',
        fontSize: 12.5,
        fontFamily: 'inherit',
        resize: 'vertical'
      },
      muted: { opacity: 0.62, fontSize: 11.5 },
      tag: {
        display: 'inline-block',
        border: '1px solid rgba(128,128,128,.35)',
        borderRadius: 4,
        padding: '0 4px',
        fontSize: 10.5,
        opacity: 0.85
      },
      pre: {
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        background: 'rgba(0,0,0,.10)',
        border: '1px solid rgba(128,128,128,.24)',
        borderRadius: 6,
        padding: 8,
        fontSize: 11.5,
        margin: 0,
        maxHeight: 260,
        overflow: 'auto'
      }
    }

    const CATEGORY_LABEL = {
      feedback: '用户反馈',
      manual: '手动记录',
      'tool-error': '工具报错'
    }

    async function rpc(op, payload) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, ...(payload ?? {}) })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (!json || json.ok !== true) throw new Error(json?.error ?? '请求失败')
      return json.value
    }

    /** 把浏览器半身的加载情况回报给宿主（写进 boot.log），用于排查面板没出现的问题。 */
    function report(event, extra) {
      try {
        void rpc('debug', { event, ...(extra ?? {}) }).catch(() => {})
      } catch {
        /* 上报失败无所谓，绝不影响主流程 */
      }
    }

    /* ---------------------------------------------------------------- *
     * 面板
     * ---------------------------------------------------------------- */

    function Panel() {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [tab, setTab] = React.useState('list')

      const refresh = React.useCallback(async () => {
        setBusy(true)
        try {
          setState(await rpc('state'))
          setError('')
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      const call = React.useCallback(async (op, payload) => {
        setBusy(true)
        try {
          await rpc(op, payload)
          await refresh()
        } catch (err) {
          setError(String(err?.message ?? err))
          setBusy(false)
        }
      }, [refresh])

      if (state === null) {
        return h('div', { style: S.root },
          h('div', { style: S.row }, h('strong', null, 'AI 教训')),
          error
            ? h('div', { style: { ...S.card, borderColor: 'rgba(200,80,80,.6)' } }, '无法连接插件：' + error)
            : h('div', { style: S.muted }, busy ? '读取中…' : '暂无数据')
        )
      }

      const cfg = state.config ?? {}
      const lessons = state.lessons ?? []
      const activeCount = lessons.filter((l) => l.enabled !== false).length

      return h('div', { style: S.root },
        // 头部
        h('div', null,
          h('div', { style: { ...S.row, justifyContent: 'space-between' } },
            h('strong', null, 'AI 教训'),
            h('button', { style: S.btn, onClick: refresh, disabled: busy }, busy ? '…' : '刷新')
          ),
          h('div', { style: S.muted }, `已记录 ${lessons.length} 条 · 生效 ${activeCount} 条`)
        ),

        error ? h('div', { style: { ...S.card, borderColor: 'rgba(200,80,80,.6)' } }, error) : null,

        // 开关区
        h('div', { style: S.card },
          h('div', { style: { ...S.row, justifyContent: 'space-between' } },
            h('span', null, '总开关'),
            h('button', {
              style: cfg.enabled ? S.btnOn : S.btn,
              onClick: () => call('setConfig', { config: { enabled: !cfg.enabled } })
            }, cfg.enabled ? '已开启' : '已关闭')
          ),
          h('div', { style: { ...S.row, justifyContent: 'space-between', marginTop: 6 } },
            h('span', null, '自动识别不满'),
            h('button', {
              style: cfg.autoDetect ? S.btnOn : S.btn,
              onClick: () => call('setConfig', { config: { autoDetect: !cfg.autoDetect } })
            }, cfg.autoDetect ? '已开启' : '已关闭')
          ),
          h('div', { style: { ...S.row, justifyContent: 'space-between', marginTop: 6 } },
            h('span', null, '记录工具报错'),
            h('button', {
              style: cfg.recordToolErrors ? S.btnOn : S.btn,
              onClick: () => call('setConfig', { config: { recordToolErrors: !cfg.recordToolErrors } })
            }, cfg.recordToolErrors ? '已开启' : '已关闭')
          ),
          h('div', { style: { ...S.row, justifyContent: 'space-between', marginTop: 6 } },
            h('span', null, '当前对话',
              h('span', { style: { ...S.muted, marginLeft: 6 } },
                state.currentSessionId ? state.currentSessionId.slice(0, 14) : '（未开始）')
            ),
            h('button', {
              style: state.currentSessionEnabled ? S.btnOn : S.btn,
              onClick: () => call('toggleSession', { enabled: !state.currentSessionEnabled })
            }, state.currentSessionEnabled ? '本对话生效' : '本对话停用')
          )
        ),

        // 子标签
        h('div', { style: S.row },
          tabBtn('list', `教训 (${lessons.length})`),
          tabBtn('preview', '注入预览'),
          tabBtn('settings', '更多设置')
        ),

        tab === 'list' ? listView() : null,
        tab === 'preview' ? previewView() : null,
        tab === 'settings' ? settingsView() : null
      )

      function tabBtn(key, label) {
        return h('button', {
          key,
          style: tab === key ? S.btnOn : S.btn,
          onClick: () => setTab(key)
        }, label)
      }

      function listView() {
        return [
          // 手动补录
          h('div', { key: 'add', style: S.card },
            h('div', { style: { marginBottom: 6, ...S.muted } }, '手动补录一条教训'),
            h('textarea', {
              style: S.input,
              rows: 2,
              placeholder: '例如：不要擅自删除文件，动手前先确认',
              value: draft,
              onChange: (ev) => setDraft(ev.target.value)
            }),
            h('div', { style: { ...S.row, justifyContent: 'flex-end', marginTop: 6 } },
              h('button', {
                style: S.btn,
                disabled: draft.trim() === '',
                onClick: async () => {
                  const text = draft.trim()
                  if (text === '') return
                  setDraft('')
                  await call('add', { text, category: 'manual' })
                }
              }, '记录')
            )
          ),

          lessons.length === 0
            ? h('div', { key: 'empty', style: S.card },
                '还没有教训。当你对 AI 说“你又搞错了”“不是这样”时，它会自动记下来；你也可以说“记一下：……”，或在上方手动补录。')
            : null,

          ...lessons.map((lesson) => h('div', { key: lesson.id, style: S.card },
            h('div', { style: { ...S.row, justifyContent: 'space-between' } },
              h('span', { style: S.tag }, CATEGORY_LABEL[lesson.category] ?? lesson.category),
              h('span', { style: S.row },
                h('button', {
                  style: lesson.enabled === false ? S.btn : S.btnOn,
                  onClick: () => call('update', { id: lesson.id, enabled: lesson.enabled === false })
                }, lesson.enabled === false ? '已停用' : '生效中'),
                h('button', {
                  style: S.btn,
                  onClick: () => {
                    if (typeof window !== 'undefined' && window.confirm && !window.confirm('删除这条教训？')) return
                    call('delete', { id: lesson.id })
                  }
                }, '删除')
              )
            ),
            h('div', { style: { marginTop: 6, wordBreak: 'break-word' } }, lesson.text),
            lesson.trigger
              ? h('div', { style: { ...S.muted, marginTop: 4 } }, '触发：“' + lesson.trigger + '”')
              : null
          ))
        ]
      }

      function previewView() {
        return h('div', { style: S.card },
          h('div', { style: { ...S.muted, marginBottom: 6 } },
            '这就是每次对话时附加在系统提示词末尾的内容：'),
          state.preview
            ? h('pre', { style: S.pre }, state.preview)
            : h('div', { style: S.muted }, '当前没有会注入的内容（总开关关闭 / 本对话已停用 / 还没有教训）。')
        )
      }

      function settingsView() {
        return h('div', { style: S.card },
          h('div', { style: { ...S.row, justifyContent: 'space-between' } },
            h('span', null, '注入条数上限'),
            h('input', {
              type: 'number',
              min: 1,
              max: 200,
              style: { ...S.input, width: 80 },
              defaultValue: cfg.maxInject,
              onBlur: (ev) => {
                const value = Number(ev.target.value)
                if (Number.isFinite(value) && value >= 1) call('setConfig', { config: { maxInject: value } })
              }
            })
          ),
          h('div', { style: { ...S.row, justifyContent: 'space-between', marginTop: 8 } },
            h('span', null, '单条最大字符'),
            h('input', {
              type: 'number',
              min: 40,
              max: 2000,
              style: { ...S.input, width: 80 },
              defaultValue: cfg.maxLessonChars,
              onBlur: (ev) => {
                const value = Number(ev.target.value)
                if (Number.isFinite(value) && value >= 40) call('setConfig', { config: { maxLessonChars: value } })
              }
            })
          ),
          h('div', { style: { ...S.row, justifyContent: 'space-between', marginTop: 8 } },
            h('span', null, '新对话默认生效'),
            h('button', {
              style: cfg.defaultSessionEnabled ? S.btnOn : S.btn,
              onClick: () => call('setConfig', { config: { defaultSessionEnabled: !cfg.defaultSessionEnabled } })
            }, cfg.defaultSessionEnabled ? '是' : '否')
          ),
          h('div', { style: { marginTop: 12, ...S.muted } },
            '这个面板住在「右侧栏」。收起之后，点会话标题栏最右端那个方块图标（左右两半、右半带一条竖线）就能把它再拉出来。'
          ),
          h('div', { style: { marginTop: 12, ...S.muted } },
            '数据文件：~/.dsh/ai-lessons/state.json',
            h('br'),
            '也可以直接在对话里说：/lessons off、/lessons on、记一下：……'
          ),
          h('div', { style: { ...S.row, justifyContent: 'flex-end', marginTop: 10 } },
            h('button', {
              style: S.btn,
              onClick: () => {
                if (typeof window === 'undefined' || !window.confirm) return
                if (window.confirm('清空全部教训？此操作不可撤销。')) call('clear', {})
              }
            }, '清空全部')
          )
        )
      }
    }

    /* ---------------------------------------------------------------- *
     * 注册
     * ---------------------------------------------------------------- */

    function apply(ctx) {
      report('client/apply', {
        hasSlots: ctx?.slots != null,
        hasInject: typeof ctx?.inject === 'function'
      })

      // 先看看是不是已经注册过（热重载时可能重复执行）
      try {
        const existing = ctx.slots?.entries?.(TAB_ID)
        if (Array.isArray(existing) && existing.length > 0) {
          report('client/already-registered')
          return
        }
      } catch {
        /* 读不到就继续注册 */
      }

      let translate = (key) => key
      try {
        const locale = ctx.get?.('locale')
        if (locale && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, DICT), 'dsh-ai-lessons: dictionaries')
          if (typeof locale.bind === 'function') translate = locale.bind(NS)
        }
      } catch {
        /* 没有国际化服务就用中文兜底 */
      }

      /**
       * DSH 的右侧栏是「一列可折叠的面板」，宽度默认 0 且会持久化。
       * 插件只注册 tab 并不会把这一列拉开 —— 用户会以为面板压根没做出来。
       * 所以首次安装后主动展开一次，成功即回报宿主，之后再不做这件事。
       */
      function autoOpenPanel(scope) {
        let done = false
        let attempts = 0
        let lastError = ''
        const MAX_ATTEMPTS = 12

        const resolveController = () => {
          try {
            const fromScope = typeof scope?.get === 'function' ? scope.get('sidebarRight') : null
            if (fromScope != null) return fromScope
          } catch {
            /* 落到 ctx 上再取一次 */
          }
          try {
            return typeof ctx.get === 'function' ? ctx.get('sidebarRight') : null
          } catch {
            return null
          }
        }

        const tick = async () => {
          if (done) return
          attempts += 1
          try {
            const snapshot = await rpc('state')
            if (snapshot?.panelAutoOpened === true) {
              done = true
              return
            }
            if (snapshot?.config?.autoOpenPanel === false) {
              done = true
              return
            }
            const controller = resolveController()
            if (controller != null && typeof controller.openTab === 'function') {
              // openTab 会顺带展开这一列（DSH 的规则：看不到的内容不算打开）。
              // 没有挂载中的会话时它会 throw，那就等下一轮。
              controller.openTab(TAB_ID)
              done = true
              report('client/auto-opened', { attempts })
              void rpc('markPanelOpened').catch(() => {})
              return
            }
          } catch (error) {
            lastError = String(error?.message ?? error)
          }
          if (attempts < MAX_ATTEMPTS) setTimeout(tick, 1500)
          else report('client/auto-open-skipped', { attempts, reason: lastError })
        }

        setTimeout(tick, 1500)
      }

      /** 有没有真正把标签页注册上 —— 4 秒后还没成，就说明服务没出现。 */
      let registered = false

      ctx.inject(['sidebarRightTabs'], (inner) => {
        const cleanups = []
        const push = (fn) => {
          if (typeof fn === 'function') cleanups.push(fn)
        }
        try {
          const tabs = inner.sidebarRightTabs
          if (!tabs || typeof tabs.register !== 'function') {
            report('client/no-sidebar-service', { serviceType: typeof tabs })
            return
          }
          push(tabs.register({
            id: TAB_ID,
            kind: TAB_ID,
            title: () => translate('tab.label'),
            guide: [{
              order: 25,
              title: () => translate('tab.label'),
              description: () => translate('guide.desc'),
              ...(GUIDE_ICON === null ? {} : { icon: GUIDE_ICON })
            }]
          }))
          push(inner.slots.inject('sidebar.right.pane.tab', () => inner.slots.register(
            { name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS },
            (props) => h(Panel, { ...props, host: 'sidebar' })
          )))
          push(inner.slots.inject('sidebar.right.pane.tab.title', () => inner.slots.register(
            { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
            () => h('span', null, translate('tab.label'))
          )))
          registered = true
          report('client/tab-registered', { id: TAB_ID, cleanups: cleanups.length })
          autoOpenPanel(inner)
        } catch (error) {
          report('client/register-failed', { reason: String(error) })
        }
        return () => {
          for (const fn of cleanups.splice(0)) {
            try {
              fn()
            } catch {
              /* ignore */
            }
          }
        }
      })

      // sidebarRightTabs 若始终不出现，这个 inject 回调根本不会触发，
      // 面板就会"凭空消失"。留一条记录，免得下次再靠猜。
      setTimeout(() => {
        if (!registered) {
          report('client/sidebar-service-missing', { hasSlots: ctx?.slots != null })
        }
      }, 4000)
    }

    t.exports = {
      name: 'dsh-ai-lessons',
      inject: ['slots'],
      apply
    }
    return t.exports
  }
})
