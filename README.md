# dsh-ai-lessons

给 **DeepSeek Harness (DSH)** 用的插件：把本地模型「犯蠢的时刻」记下来，并把教训自动带进之后的每一次对话。

命中一句话就能概括：**记录犯过的错 → 沉淀成清单 → 下次开口前先看一眼。**

仓库：<https://github.com/dusktin71-lang/dsh-lessons> · License: MIT

---

## 它做了什么

| 能力 | 说明 |
| --- | --- |
| **自动识别** | 你对 AI 说「你又搞错了」「不是这样的」「答非所问」这类短促不满时，自动记一条，并附上当时被纠正的回答要点 |
| **随手补录** | 说「记一下：动手删文件前先问我」或 `/lesson xxx`，直接入库 |
| **工具报错留档** | 可选：工具执行失败时也记一条（默认关闭，避免噪声） |
| **动态注入** | 通过 `systemPrompt.section()` 注册一段**每次组装请求时实时求值**的提示词 —— 记完立刻生效，不用重启 |
| **会话级开关** | 新开一个对话后，可以单独决定这个对话要不要带着历史教训；也可以在对话里直接说 `/lessons off`、`/lessons on` |
| **可视化面板** | DSH 右侧栏的「AI 教训」标签页：查看 / 停用 / 删除 / 补录，以及「注入预览」看模型实际读到了什么 |

注入到提示词里的样子：

```
## 历史教训（此前对话中被明确纠正过的问题）

下面是用户在过去的对话里明确表达过不满、或主动要求牢记的事项。
请在本次回答中主动规避这些错误；与当前任务无关的条目可以忽略，但不要重复犯同样的错。

- 避免重复这个问题：用户当时说“你又搞错了，我根本没让你删东西”。
   · 当时用户的反应：“你又搞错了，我根本没让你删东西”
   · 当时 AI 的回答要点：好的，我已经删除了那个文件夹。
- 动手删除文件前必须先问我
```

---

## 用法

### 自动（什么都不用做）

对 AI 表达不满即可，例如：

- 你又搞错了 / 不对 / 不是这样的 / 重新做一遍
- 你没理解我的意思 / 答非所问 / 胡说

判定刻意保持保守：**只对 120 字以内、且命中明确负面词语**的消息入库，避免把正常讨论误判成抱怨。误记了在面板里删掉就行。

### 手动

| 你输入 | 效果 |
| --- | --- |
| `记一下：<内容>` / `记住：<内容>` | 记一条教训 |
| `/lesson <内容>` | 同上 |
| `/lessons off` / `/lessons on` | 本对话停用 / 启用教训注入 |

### 面板

DSH 右侧栏 →「AI 教训」：

- 顶部开关：总开关、自动识别、工具报错、**当前对话**是否生效
- **教训**：补录、逐条停用、删除
- **注入预览**：模型实际会读到的原文
- **更多设置**：注入条数上限、单条字符上限、新对话默认是否生效、清空全部

---

## 文件位置

| 内容 | 路径 |
| --- | --- |
| 插件源码 | `<本目录>`（通过目录联接挂在 profile 下，改这里就是改生效代码） |
| 数据文件 | `~/.dsh/ai-lessons/state.json` |

---

## 安装 / 卸载

```bash
git clone https://github.com/dusktin71-lang/dsh-lessons.git
cd dsh-lessons
node install.mjs              # 安装（会备份 profile/package.json）
node install.mjs --no-install # 只改配置，不建链接
node verify-install.mjs       # 校验安装结果
node selftest.mjs             # 校验判定规则
node smoketest.mjs            # 用假 ctx 跑通宿主半身
```

安装做了三件事：

1. profile `package.json` 里加一条 `link:` 依赖；
2. `dsh.profile.bundles` 里登记 `dsh-ai-lessons`；
3. 建立 `node_modules/dsh-ai-lessons` → 本目录的联接（pnpm 可用时走 pnpm，否则用目录联接）。

**改完代码后重启 DSH 生效。**

卸载：删掉上面那两处登记，或把 `package.json.bak-*` 还原回去，即可。

---

## 实现说明

DSH 插件由两个半身组成，本插件都用官方约定的方式接入，没有额外构建步骤。

### 宿主半身 `index.js`

| 用到的能力 | 用途 |
| --- | --- |
| `ctx.on('session/event', (session, event) => …, { global: true })` | 监听全量会话事件：`user/message`、`assistant/message`、`tool/result` |
| `ctx.inject(['systemPrompt'], …)` → `systemPrompt.section({ name, order, text })` | 注册提示词段。`text` 传**函数**，每次组装请求时求值，所以「记录即生效」 |
| `systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 1` | 段位置：排在部署人设之后 |
| `interpolate: false` | 教训原文里可能出现 `{{`，必须关掉变量插值，否则会抛错 |
| `ctx.inject(['connection'], …)` → `connection.fetch.register({ path, methods, requestBody, fetch })` | 给面板用的本地接口 `/api/dsh-ai-lessons/rpc` |
| `ctx.get('dshHomePath')` | 数据目录，拿不到时回退到 `~/.dsh` |

任一服务缺失只会让对应功能降级（例如没有 HTTP 服务就没有面板），插件本体不会挂。

### 浏览器半身 `client.js`

按官方打包格式暴露：

```js
window.__ModuleLoader__.load({ id: 'dsh-ai-lessons', factory: (req) => { … } })
```

`req` 用来取 `react` / `react-dom` / UI 原语。UI 用 `React.createElement` 直接写，不依赖任何构建工具；`@deepseek-ai/dsh-client-ui-primitives` 是可选依赖，取不到就全部退化成原生元素。

面板通过 `ctx.inject(['sidebarRightTabs'], …)` + `ctx.slots.register('sidebar.right.pane.tab', …)` 挂到右侧栏，数据和操作走上面那个本地接口。

---

## 可调项

面板「更多设置」里可以直接改；也可以手改 `~/.dsh/ai-lessons/state.json` 的 `config`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `autoDetect` | `true` | 自动识别用户不满 |
| `recordToolErrors` | `false` | 工具报错也记一条 |
| `maxInject` | `30` | 注入条数上限 |
| `maxLessonChars` | `240` | 单条注入的字符上限 |
| `defaultSessionEnabled` | `true` | 新对话默认是否生效 |
| `includeSubagents` | `false` | 预留：是否注入子智能体 |
