# 计划（PLAN）

> **三份文档的分工，不许混**
>
> | 文档 | 回答什么 | 谁能改 |
> |---|---|---|
> | `PRD.md` | **需求**：产品要什么、边界在哪 | 只有用户（人的决策） |
> | `architecture.md` | **结构**：宿主内部怎么搭 | AI，改了要说清道理 |
> | 本文件 | **计划**：先做什么、怎么算做完 | 优先级与范围归用户（§8），拆法与步骤归 AI（正文） |
>
> 本文每条都标了它的性质：
> **【需求】** 来自 PRD，不许改；**【人的决策】** 用户已裁定，AI 不改写；**【AI 的决策】** 是拆法与实现路径，写清理由，用户随时可否决。
>
> 历史：本文件取代四份已删的计划文件（见 §10），裁定编号 R1–R79 的原文在 git 历史里。
> **本版（2026-11-13）**：用户逐条裁定了 19 条（契约 / 宿主侧 12 条、TUI CLI 侧 6 条、桌面端 1 条），
> §8.1 是按主题归类的「已定」台账；波次从「P0 → P1 → P2」改成 W1–W5。

## 0. 硬约束（用户 2026-11-13 定，四条，任何一浪都不许违反）

1. **旧代码与旧门禁一律作废**（只针对 `cli` 与 `desktop`；`cli-old` 是只读参照物，与它无关）。
   不许为「让旧用例变绿」写兼容层，不许保留旧字段/旧方法/旧名称，不许用 `.skip` 换绿。
   旧用例里测的是**旧行为**就直接删（删掉比修好更对）；测的是**仍然成立**的行为，按新契约重写。
   不留历史问题、不留 `@deprecated`、不留「以后再说」。
2. **数据结构跟着上游走**。消息、内容段、用量、工具调用、思考档位、问题对象一律用
   `@ai-zen/agents-core` / `@ai-zen/agents-sdk` / 宿主 `wire` 的**既有形状**；不许自己发明一套
   再各种变形（adapter / mapper 层层套娃）。要变换只能发生在「渲染这一行」那一刻，且不新增类型。
3. **共享代码只做私有包**。`@ai-zen/agents-client` 这类一律 `private: true`、不发版；
   `cli` 与 `desktop` 构建时各自把它**内联进产物**，不许留运行时依赖。
4. **客户端对上游的依赖 = 类型 + 干净函数**。类型可以依赖（构建时抹除）；无副作用的纯函数可以依赖
   （构建时捆绑）。**产物里绝不许出现 `openai` 与 `@modelcontextprotocol/sdk`**（极重）。
   护栏：`cli` 的 `check:imports --forbid openai --forbid @modelcontextprotocol`、
   `desktop` 的 `check-no-host-runtime.mjs` / `check:inlined.mjs`；`@ai-zen/agents-client`
   本身也已加进禁令（内联之后它不该再出现在产物里）。

## 1. 现状快照（2026-11-13 实跑，不是估计）

| 仓 | 分支 / HEAD | 未提交 | 类型检查 | 用例 |
|---|---|---|---|---|
| `agents`（host + client） | `feat/server-rewrite` / `d0e85ff` | 0 | `tsc` **0 错**（host / client 各一遍） | host **763 绿 / 59 文件**、client **98 绿** |
| `cli`（TUI CLI） | `main` / `57a295f` | 0 | `tsc -p tsconfig.test.json` **0 错** | 默认用例集 **835 全绿 / 55 文件**；真进程 e2e **18 绿 / 1 跳过 / 0 失败**；产物已内联连接层，**四条护栏全过**（`check:imports`：`dist/index.js` / `dist/commands/index.js` / `dist/session.js` / `dist/stdio.js`，禁令含 `@ai-zen/agents-client` / `openai` / `@modelcontextprotocol`） |
| `desktop` | `feat/new-server` / `157959b` | 0 | `vue-tsc`（render）**0 错**；main 的构建走 rolldown + `check-inlined` | main **121 绿 + 3 跳过**、render **70 绿** |
| `cli-old` | detached @ `pre-split-20261111` / `ace42a0` | 0 | 只读冻结参照物（目录只读权限），不是迁移对象 | — |

**结论**：宿主已经完整（**65 方法 / 6 事件**、全绿）；TUI CLI 已经跟上新契约 —— 从「`tsc` 161 错、58 条失败用例」
到「0 错、835 绿、e2e 绿」。**「host ↔ TUI CLI」这条链已经通了**，剩下的欠账不是「编译不过」，而是两笔：
**契约还差 12 条**（W1）、**CLI 还差 6 条产品行为**（W2）。

## 2. 波次总览

| 波 | 目标 | 验收（一句话） | 依赖 |
|---|---|---|---|
| **W1 契约补齐**（P0-A） | 用户裁定的契约面 12 条落进 `wire` | 12 条各有用例；`METHOD_NAMES` **65 → 63**；capabilities / i18n 同步；每个新字段都举得出「哪个客户端哪一行用它」 | 无 |
| **W2 CLI 收口**（P0-B） | `npx` 拉起 + 下载屏 + `/ws` + `/shutdown` + 命令集增删 | 干净环境从零起一次宿主；失败 / 取消三条路径各有用例；命令表与 PRD F-E1 逐条对齐 | W1（契约先冻结，免得照着两份契约写两遍） |
| **W3 归档与文档** | `cli-old` 归档、旧包名清干净、`architecture.md` 跟上新契约 | 三份文档与代码一致；旧包名只剩归档目录 | W1、W2 |
| **W4 桌面端完整问答视图** | 标准完整问答视图（优先级最低） | 真 GUI 竖切一遍；`question.list/answer` 有调用点 | 无（排期在 W3 之后） |
| **W5 兜底治理** | `retry` / `fallback` / `catch` 密集文件逐文件清理 | 三列清单全覆盖；留的每条指得出消费者 | W1–W3 |

---

## 3. W1 契约补齐（P0-A，当前主线）

### 3.1 十二条（逐条可验收）

> 下面十二条都是**【人的决策】**（用户 2026-11-13 逐条裁定），条目的成因与验收是**【AI 的决策】**。

**W1-1【人的决策】补 `AgentView`（及 `agent.get`）的完整助手定义：`messages`（提示词）+ `function`（子 Agent 定义，非子 Agent 为 `null`）。**
- 为什么：现在是「能写不能读」—— `AgentInput` 有 `messages` / `function`，`AgentView` 没有，于是
  PRD F-F5「助手与子 Agent 定义编辑」做不到：客户端看不见提示词，就没有可编辑的对象。
- 验收：`agent.get` / `agent.list` 回来的同一个 `AgentView` 上带这两项；非子 Agent 的 `function === null`；
  「`agent.get` 拿到的 `messages` 原样交给 `agent.update`」等于没改（往返一致，一条用例）；
  子 Agent 的 `function` 内容能原样读回（不许只说 `isSubAgent: true`）。
- 客户端的哪一行：CLI 配置向导的助手编辑屏（`tui/config-wizard/*`）第一次能显示提示词；桌面端助手编辑同此。

**W1-2【人的决策】补 `agent.restoreFactory { agentId, dryRun? }`（与 `model.restoreFactory` 对称）。**
- 验收：改过的助手恢复出厂后 `custom === false`，提示词 / 模型 / 权限 / 思考参数都回到出厂那份；
  `dryRun: true` 只算代价、不落盘（跑完文件字节不变）；引用关系不动（这条不删任何东西）。

**W1-3【人的决策】`agent.setThinking` 支持 `level: null`（= 清掉助手定义上的思考参数）。**
- 验收：`level: null` 之后 `AgentView.modelParams` 里那份思考参数消失、`thinking` 回到「没有覆盖」；
  与 `conversation.setThinking(null)`（这段会话回到跟随助手默认）语义不同 —— 一条用例钉住
  「前者改文件、后者改会话行」。

**W1-4【人的决策】`DiscoveryEntryView` 带传输字段（`transport` / `command` / `args` / `env` / `url` / `headers`）与 `extra`（本版本不认识的键，写回原样带上）。**
- 为什么：对应 PRD F-F6「未知字段原样保留」；现在条目视图只给 `id` / `name` / `description` / `source` /
  `enabled` / `problem`，客户端连「这条 MCP 是怎么起的」都看不全，编辑屏没法做。
- 验收：读一份写了这六样 + 两个本版不认识的键的 MCP 文件 → 六个字段都在视图里、两个未知键进 `extra`；
  「读出来直接写回」之后文件里那两个未知键还在（round-trip 用例）。

**W1-5【人的决策】`config.patchMcps`（整层替换）改成按 id 的增删改：`config.saveMcp { scope, workspaceId?, entry }` + `config.deleteMcp { scope, workspaceId?, id }`。**
- 为什么：整层替换要求客户端「先读整层、再拼回去」，中间只要有一处它不认识就丢配置；
  按 id 改只动这一条。形状与 `config.saveEndpoint` 对齐，客户端只需一套写法。
- 验收：`saveMcp` 有 id 则改、无则建（一条用例两种走法）；`deleteMcp` 之后 `config.getDiscovery` 那一层里
  没有这个条目；`patchMcps` 从 `MethodMap` / `METHOD_NAMES` / handler / capabilities / i18n 全部消失。

**W1-6【人的决策】`DiscoveryLayerView` 加 `scope: McpEditableScope | null`。**
- 为什么：省掉客户端按 `editable` + `depth` 反推「这一层是 user 还是 workspace」。
- 验收：MCP 5 层里正好 2 层 `scope` 非空（`user` / `workspace`），其余 `null`；skill / tool / subagent
  三类恒 `null`；客户端里没有反推分支（W2 把它删干净）。

**W1-7【人的决策】`ModelInput.tokenThresholds` 改成可选，宿主套出厂默认。**
- 为什么：现在客户端建模型时必须自己填两个数（旧实现是「沿用已有模型那两个数」），那是把宿主的
  默认值复制到客户端。
- 验收：`model.create` 不给阈值能建成，`model.list` 读回来是出厂默认的两个数；客户端没有
  「沿用已有模型那两个数」的逻辑（W2 删）。

**W1-8【人的决策】`message.list` 加 `around?: messageId`（以某条为中心取一窗），供客户端把搜索命中的那条摆到眼前。**
- 验收：`around` 给了且该 id 存在 → 回来的窗口含它、`anchor` 指向它；客户端据此能把命中的那条渲染在眼前。
- 【AI 的决策】窗口多大、与 `after` 同时给时谁优先、id 不存在时怎么办 —— 由实现者定，但**必须写进
  `wire` 注释与 `architecture.md` A12**（A12 现在只写了 `after` 的规则）。

**W1-9【人的决策】删 `host.usage`。**
- 为什么：PRD F-I5 要的三样（本轮 / 累计含子 Agent / 速率）`conversation.state.usage`（`UsageSnapshot`）
  已经全覆盖；`host.usage` 的「项目 / 整机」聚合**没有任何客户端需要**。
- 验收：`METHOD_NAMES` 里没有它；capabilities 少一条、i18n 少一对键；
  `grep -rn "host.usage" agents/packages cli/src desktop/packages` 无输出。

**W1-10【人的决策】删 `credential.list/create/revoke` 的 wire 面（`MethodMap` + `METHOD_NAMES` + handler + capabilities + i18n），服务层与 `agents-host token create|list|revoke` 一字不动。**
- 为什么（用户原话的精神）：**宿主自己管理凭据、决定哪些凭据能访问宿主；客户端只有「连接管理 + 记住密码」** ——
  这是两件事。PRD L13 落文。
- 验收：真进程跑一遍 `agents-host token create / list / revoke` 照常（一条进程级用例，证明服务层没被带塌）；
  wire / handler / capabilities / i18n 里没有 credential；`METHOD_NAMES` 少三条。

**W1-11【人的决策】保留 `host.upgrade` 与 `host.shutdown`。**
- 为什么：TUI CLI 的 `/upgrade` 已经接 `host.upgrade`（它替代了旧的 `npm i -g` 自升级）；
  **关闭宿主是必要需求**（PRD D29）。
- 验收：两条都还在 `METHOD_NAMES` 与 capabilities 里；`/upgrade` 走它（已有）；`/shutdown` 走它（W2-5）。

**W1-12【人的决策】图片模型不做恢复出厂：不补 `model.restoreFactoryImage`。**
- 验收：`METHOD_NAMES` 里没有它；PRD §5 有这一条（防下一棒「顺手补对称」）。

### 3.2 连带改动（漏一条 W1 就不算完）

| 改动面 | 要做什么 |
|---|---|
| `wire/methods.ts` 注释 | 每条改动按新口径改注释 —— 这份注释就是下一棒的契约书，注释与形状必须一起走 |
| `METHOD_NAMES` / capabilities | **65 → 63**：−1 `host.usage`、−3 `credential.*`、−1 `config.patchMcps`；+1 `agent.restoreFactory`、+2 `config.saveMcp` / `config.deleteMcp` |
| i18n（`en` / `zh` 各一套） | 删 5 对 `capability.*` 键、加 3 对；不许留孤儿键，也不许少键（用例钉住两套键集合一致） |
| handler | 删 5 个 handler、加 3 个；被删方法原来有用例的，用例一起删（§0 第 1 条） |
| PRD | 已同批改完：L13 / L14、D29–D31、§4 十二条、§5 三条、§7 一行（本文件不重复需求） |
| `architecture.md` | **这一波不动**（用户明确要求等契约定稿一起改），W3 统一改 |

### 3.3 W1 的铁律

见 §9 第 7 条：每加一个字段 / 方法，提交说明里要写「哪个客户端的哪一行会用到它」，写不出来就不加。

---

## 4. W2 CLI 收口（P0-B）

### 4.1 前置：S1–S5 已完成（已落地并提交，HEAD `57a295f`）

| 步骤 | 落地证据 |
|---|---|
| **S1 连接层对齐** | `server-client/index.ts` 只剩「透传 + 身份」；`connection.ts` 把 CLI 的事实绑到 `ensureHost`；旧的 `ping` 探活换成「`ensureHost` 成功即连上」（握手本身校验凭证） |
| **S2 契约面改名** | 协议类型来源 `@ai-zen/agents-client`；`notice.ack` → `notice.list / dismiss / clear`；`PhaseInfo` 六态 → `RunState.phase` |
| **S3 薄服务层** | 落在 `agents-store.ts` / `config-editor.ts` / `mcp-command.ts` / `session/types.ts` 这几处，只做「界面要的形状 ↔ 契约调用」，不造新类型 |
| **S4 用例与 e2e** | `tsc -p tsconfig.test.json` **0 错**（原 161 错 / 37 文件）；默认用例 **835 绿 / 55 文件**（原 58 失败 / 745 通过）；e2e **18 绿 / 1 跳过 / 0 失败**（原来 `Daemon` 那条链跑不起来，现已换成真宿主进程） |
| **S5 打包** | `@ai-zen/agents-client` 内联进产物；四条 `check:imports` 全过（禁令含 `@ai-zen/agents-client` / `openai` / `@modelcontextprotocol`） |

### 4.2 六条（逐条可验收）

**W2-1【人的决策】本机模式 = `npx` 现下现起宿主（PRD L14）。**
- 【AI 的决策】做法：CLI 给 `ensureHost` 传自己的 `spawnHost` —— 按构建时注入的 range 拼
  `npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <数据根>`。包里的 `resolveHostEntry`
  （从已装的私有包解析入口）不动，它继续服务仓库内开发与桌面端；**CLI 的本机路径不再走它**。
  `server-client/index.ts` 那段「不走 npx、只认已装包」的注释要跟着改 —— 它现在与决策相反。
- 为什么：能用 CLI 的地方一定有 npm；要求用户先学会一条安装命令，等于把宿主的版本管理推给用户。
- 验收：注入点只有一处（构建脚本里那个 range）；一条用例注入假 spawn，断言命令、包坐标与 range；
  真机竖切一次：干净数据根、本机未预装宿主也能起来（走 npx 这条，不是已装包那条）。

**W2-2【人的决策】下载屏：阶段式、不确定进度 —— 解析版本 → 下载 → 安装 → 启动宿主 → 连上（PRD D31）。**
- 【AI 的决策】不解析 npm 的输出（那是别人的日志格式，改版就跟不上）：阶段由我们自己的动作推进
  （发起 npx → 子进程 spawn 成功 → 发现文件出现 → 握手成功）。
- 验收：一条用例钉住五个阶段各出现一次、顺序不乱；代码里没有解析子进程 stdout 的分支；
  **不假装百分比**（不确定进度就是不确定）。

**W2-3【人的决策】下载失败 / 取消就地处理：真原因 + `R` 重试 + `Esc` 折回远程连接屏；Ctrl+C 杀 npx 子进程回连接屏、不退出程序；stdio（一次性）模式直接报错退出。**
- 验收：三条 TUI 用例（失败显因并可重试 / `Esc` 折回 / Ctrl+C 不退出）+ 真进程手跑一次 Ctrl+C；
  stdio 模式一条用例，断言「报错 + 非 0 退出码 + stdout 干净」。

**W2-4【人的决策】`/ws`：工作区实体入口（列 / 选 / 建）；启动时自动进入（本机宿主用当前目录这条糖，远端用「上次进入的那个」，都没有才进选择环节）。**
- 【AI 的决策】「上次进入的那个」存在 CLI 自己的状态文件里（`<数据根>/cli/` 下），**不进 `settings.ts`** ——
  那份只记连接事实（D26），两件事不混一个文件。
- 验收：列 / 选 / 建三条路径各一次；启动顺序三条用例（本机 = 当前目录；远端 = 上次那个；都没有 = 进选择）；
  记着的那个工作区已被删（id 取不到）时回落进选择，不卡死。

**W2-5【人的决策】`/shutdown`：显式命令 + 一次二次确认，确认即关闭宿主；CLI 退出时**不**自动关宿主。**
- 验收：`host.shutdown` 的调用点只有一处（grep 举证）；退出路径里没有它（一条用例：退出时不发 shutdown）；
  二次确认取消则什么都不做。

**W2-6【人的决策】命令集增删：删 `/search`；撤回主名 `/back`（`/revert` 为别名）；`/pin` 保留；`/ws` 与 `/shutdown` 进表。**
- 为什么删 `/search`：**CLI 一阶段不做搜索** —— 搜索是桌面端的一个搜索框（F-C6），触发消息列表的搜索，
  宿主提供 `search.messages`，怎么搜由客户端定。
- 验收：`commands/registry.ts` 的命令名与 PRD F-E1 逐条对齐（对照表进提交说明）；`search.conversations`
  在 CLI 里零调用（grep）；i18n 删掉 `cmd.search.*`；帮助屏由 capabilities 渲染，不再多一条。

**W2-7【AI 的决策】`notice.clear` 现在零调用方 —— 在 CLI 通知屏加一个「全部清空」，给它真实出路，而不是删方法。**
- 为什么：宿主侧 `notice.clear` 是实现完整、行为正确的通道动作（L3 手动清）；删掉等于让「一片通知一次清完」
  没有入口，而通知屏现在只能一条条 dismiss。
- 验收：通知屏有「全部清空」且键位进帮助；`notice.clear` 有且只有这一个调用点；一条用例钉住「清完列表为空」。

### 4.3 存量复验（原 P1 的清单，W2 收尾时逐条点一遍）

【需求】PRD §4 里落点是 `C` 或 `S+C` 的条目，主战场就是 TUI CLI。这些实现已经随 S1–S5 接到新契约上，
W2 收尾时确认的是**「它接的到底是哪个方法」**（不是「文件在就算做完」）：

| 已存在的实现（文件） | 对应的 PRD 条目 | 要确认它接的方法 |
|---|---|---|
| `tui/screens/handoff-choice.ts` | F-D2 交接三选一 | `question.answer`（答完的后续动作在 `effects` 里，不用再发一次请求） |
| `tui/screens/notice.ts`、`pending-notices.ts`、`session-notice.ts` | F-I8 通知通道 | `notice.list / dismiss / clear`（`clear` 见 W2-7） |
| `tui/mention.ts` | F-H4 / F-H5 `@` 菜单 | `completion.files`（D7：远程前端看不到目录） |
| `status-segments.ts`、`session-rate.ts` | F-I6 状态栏块 / F-I5 速率 | `statusBlocks` / `conversation.state.usage`（只有这一个口径） |
| `tui/config-wizard/*`、`mcp-command.ts`、`agent-switch.ts`、`reasoning-effort.ts` | F-F1~F-F7、F-B4、F-B6 | `config.*` / `agent.*`（W1 之后 MCP 那屏走 `saveMcp` / `deleteMcp`） |
| `tui/key-debug.ts`、`mouse.ts`、`input-editing.ts`、`system-editor.ts`、`hook.ts`、`clipboard.ts` | F-J3、F-H1~H3、F-C11、F-A4、F-H6 | — （本机能力，不经宿主） |
| `version-compare.ts` | F-E3 升级 | `host.upgrade` + W2-1 的 range 比对 |

每条的验收照旧：真进程手跑一遍 + 一条钉住该行为的用例。
（`search.conversations` 从这张表里出去：一阶段不做搜索，见 W2-6。）

---

## 5. W3 归档与文档（W1、W2 之后）

**W3-1【人的决策】`cli-old` 降级为归档**：目录加 `-archive` 后缀（`cli-old` → `cli-old-archive`），
README 首行写「不要改、不要当实现依据」。
- 验收：目录名改到位；README 首行就是那句话；PRD §1 的出处名同步；仓库里指向旧路径的引用全部改到新名
  （`grep -rn "cli-old/" --exclude-dir=cli-old-archive` 无输出或已是新名）。
- 备注：该目录当前是只读权限（`dr-xr-xr-x`），改名动的是父目录，不必先 `chmod`。

**W3-2【AI 的决策】旧包名 `@ai-zen/agents-server` 改准**：文档与注释里残留的一律改成 `@ai-zen/agents-host`
（或按上下文直接去掉）。
- 为什么：宿主早改名（R77），残留旧名会让下一棒以为存在另一个包，或者去 npm 找一个不存在的坐标。
- 验收：`grep -rn "@ai-zen/agents-server" agents cli desktop` 只剩归档目录（或零）。

**W3-3【需求】`architecture.md` 随契约补齐更新。**
（W1 里明确「不动它」就是为了等契约定稿一起改；结构与实现相关，一次改对。）
- 内容：方法表 **65 → 63**（新增三条、删五条）；A13「每方法一条」的条数；A12 补 `around`；
  §6 接线补 `config.saveMcp` / `config.deleteMcp` / `agent.restoreFactory`；§3 对象图补 `AgentView` 的
  `messages` / `function`、`DiscoveryEntryView` 的传输字段 + `extra`、`DiscoveryLayerView.scope`。
- 验收：`architecture.md` 的方法条数与 `METHOD_NAMES` 逐条对齐（capabilities ↔ `METHOD_NAMES` 已有用例钉住，
  文档这边人工核一遍）；§9 已知缺口按本轮改写；§11 变更记录加一行。

---

## 6. W4 桌面端完整问答视图（优先级最低）

【人的决策】**做标准的完整问答视图**，不是只把死路堵上的最小方案。
【需求】PRD 里落点含 `S+C` / `C` 的条目，桌面端同样欠着（F-I9 已改成这个口径）。

要还的账，按「先救命、后补齐、最后体验」排：

1. **会跑死对话的 3 条（W4 内部优先级最高）**：问题对象没有作答通路（`question.list/answer` 零调用，
   `main/src/host/events.ts` 把 `QuestionView` 压成一条 notice）⇒ 跑到交接线后每次 `conversation.send`
   被 `question_pending` 拒，对话永久报废；交接 `handoff.start` 同一条链。
2. **完整问答视图本身**：消息列表（源码着色、代码高亮、工具调用压一行、失效消息删除线）、输入区
   （多行 + 限高 + `@` + 图片粘贴 + 草稿）、作答面板（`question.*`）、通知栏（`notice.*`）、状态栏块、
   用量（`conversation.state.usage`）、错误说人话。
3. **22 项 PRD 明文要求但零入口**：搜索、撤回、置顶、思考强度、临时对话、记住上次会话、帮助、能力清单、
   切语言、模型 / 图片模型 / 助手 / MCP / 端点编辑、默认项 3/5、工具输出上限、`/` 与 `@` 菜单、
   用量与状态栏、通知栏。
4. **体验欠账**：首启引导屏没跑过真 GUI（本机无 electron 二进制，但有 `xvfb-run`）、
   「选服务 + 填 Key」不是向导只是跳设置页。

**验收**：`xvfb-run` 里真 GUI 竖切一遍 —— 连上 → 发一条看到流式 → 跑到交接线作答 → 撤回 → 搜索命中并
定位到那条消息（`message.list` 的 `around`）→ 置顶；`question.list/answer` 有调用点、`QuestionView` 不再
被压成 notice；第 3 档逐条打勾，打不了勾的写清为什么不做（不许默默留空）。
**依赖**：无；排期在 W3 之后。

---

## 7. W5 兜底治理（在 W1–W3 之后做）

【人的决策】「复杂兜底」全仓审计要做：`retry` / `fallback` / `catch` 密集文件的**逐文件**清理；等契约与
客户端定型后再做，否则边修边被清理。

【AI 的决策】做法：扫出 `catch` / `retry` / `fallback` / `?? {}` / `|| default` 密集的文件，逐文件产出**三列清单**：

| 位置（文件:行） | 是什么兜底 | 处置 |
|---|---|---|
| `…` | 例：连不上就假装空列表 | **删**（没人会走到 / 走到了也只会掩盖真相） |
| `…` | 例：读配置文件失败回落默认 | **留** —— 谁在用：`cli/src/config-editor.ts:…`（理由：首次启动没有文件是正常状态） |

**验收**：清单覆盖审计范围内每一个兜底点；每条「留」的都指得出消费者与理由，**指不出来就删**
（§0 第 1 条、§9 第 4 条同一把尺子）；删完 `tsc` 0 错、用例全绿、真进程竖切不回归。
**依赖**：W1–W3（先让契约与客户端定型）。

---

## 8. 人的决策

### 8.1 已定（2026-11-13，19 条，按主题归类）

| 主题 | 已定的内容 | 落在哪 |
|---|---|---|
| **契约 · 助手定义** | 定义读得回（`messages` + `function`）；助手能恢复出厂；思考参数能清掉 | PRD F-B2 / F-B6 / F-F5；W1-1…W1-3 |
| **契约 · MCP** | 条目字段齐全（含传输参数）+ 未知键 `extra` 原样保留；按 id 增删改；可编辑作用域由宿主点名 | PRD F-F6；W1-4…W1-6 |
| **契约 · 模型 / 消息 / 用量** | 阈值可不给（宿主套出厂默认）；`message.list` 能以某条为中心取一窗；用量只有 `conversation.state.usage` 一个口径 | PRD F-F3 / F-C6 / F-I5；W1-7…W1-9 |
| **契约 · 减法** | 删 `host.usage`；删 `credential.*` 的 wire 面（服务层与 `token` 子命令一字不动） | PRD L13 / F-I5；W1-9 / W1-10 |
| **契约 · 保留** | `host.upgrade`（`/upgrade` 已接）、`host.shutdown`（关闭宿主是必要需求） | PRD F-E3 / D29；W1-11 |
| **契约 · 不做** | 图片模型不补恢复出厂 | PRD §5；W1-12 |
| **本机拉起** | `npx` 现下现起 + CLI 声明宿主 semver range；下载屏（阶段式、不确定进度）；失败 / 取消就地处理，stdio 直接报错 | PRD L14 / D31 / F-E3；W2-1…W2-3 |
| **工作区与退出** | `/ws` 实体入口 + 启动自动进入；`/shutdown` + 一次二次确认；退出不自动关宿主 | PRD D30 / D29 / F-E1 / F-A6；W2-4 / W2-5 |
| **命令集** | 删 `/search`；`/back` 为主名、`/revert` 为别名；`/pin` 保留 | PRD F-E1 / F-C6；W2-6 |
| **桌面端** | 完整问答视图（不是最小方案），优先级最低 | PRD F-I9；W4 |
| **目录** | `cli-old` 降级为归档（`-archive` 后缀 + README 首行） | W3-1 |
| **旧的四个问题** | Q1 已定：删 wire 面、留服务层、`host.upgrade` 保留；Q2 已定：PRD 的 TUI 专属条目不动，归 W2 复验；Q4 已定：兜底审计要做，放 W5 | §8.2 只剩 Q3 |

### 8.2 仍待你裁定（1 条）

| 编号 | 问题 | 现状事实（供你判断） | 我的建议 |
|---|---|---|---|
| Q3 | desktop 的类型检查要不要前置 `agents/packages/host/dist` 的构建 | 现状靠已存在的 dist，构建顺序没写进脚本 | 前置（一次显式依赖，胜过一条隐式约定） |

---

## 9. 每波的验收标准（五波共用，不许减项）

1. 类型检查 0 错（host / client 的 `tsc`、cli 的 `tsc -p tsconfig.test.json`、desktop 的 `vue-tsc`）
2. 用例全绿；**失败不许用 `.skip` 换绿**，要么修好要么删掉并说明
3. 真进程竖切跑通（不是只有单测绿）
4. **不必要性审查**（铁律 10）：新增的每个可选入参、可空返回、防御分支，都要答得出「哪个客户端的哪一行会走到」
5. 文档同步：改了行为就改 PRD / architecture 的对应条目，不许文档落后于代码
6. 不自己 commit（用户的规矩）
7. **契约面铁律（W1 用，也用于以后每一次补契约）**：每加一个字段 / 方法 / 入参，提交说明里必须能举出
   「**哪个客户端的哪一行会用到它**」——举不出来就不补。删的方向同理，先答「谁在依赖它」：
   答不出来（没人依赖 + 没有需求条目要求）就是可以直接删；答得出来就必须同时交代它怎么改。
   （W1-9 删 `host.usage`、W1-10 删 `credential.*` 都是照这条走的：前者没人依赖、口径已被覆盖；
   后者依赖方是宿主自己的 `token` 子命令，所以只删 wire 面、服务层一字不动。）

---

## 10. 文档地图（历史去哪了）

| 路径 | 是什么 |
|---|---|
| `agents/packages/host/docs/PRD.md` | 需求唯一来源（83 条能力 + 锁定决策 L / D） |
| `agents/packages/host/docs/architecture.md` | 宿主结构（A1–A13） |
| `agents/packages/host/docs/plan-questions.md` | 实施者自决与待核（QD 条目） |
| `agents/packages/host/docs/PLAN.md` | **本文件** |
| `agents/.ai-zen/handoffs/*.md` | 交接记录（历史，不假造过去，不改） |

**本次删掉的四份**（内容已被本文件吸收，原文在 git 历史里）：

| 删除的文件 | 里面还有价值的东西去哪了 | 怎么找回原文 |
|---|---|---|
| `agents/.ai-zen/plan-host-rewrite.md`（36KB） | 裁定 R1–R79 的原文、目录契约、旧验收标准 → 仍在生效的约束已体现在 PRD / architecture / 本文件 §0 / §9 | `git show HEAD:agents/.ai-zen/plan-server-rewrite.md`（289 行，HEAD 里还是改名前的旧名） |
| `agents/.ai-zen/plan-clients.md` | C1–C4 客户端波次 → 在 §2 / §3 / §4 | `git show HEAD:agents/.ai-zen/plan-clients.md`（26 行） |
| `agents/.ai-zen/gap-report-20261113.md` | 完成度普查（65 方法 / 46 零调用）→ 结论进 §6，明细随该文件删除 | 未入库，只在上一轮对话里 |
| `desktop/TODO.md` | 首启真 GUI 验收 5 条、凭据向导 5 条 → §6 第 4 档 | `git -C desktop show HEAD:TODO.md`（71 行） |

## 附录 A —— TUI CLI 曾缺的客户端库导出（`tsc` 58 条 TS2305 去重）

> **已清**（HEAD `57a295f`：`tsc -p tsconfig.test.json` **0 错**）。留作历史清单：这类错误再出现时照这张表拆。

连接与地址：`ServerConnection`、`ensureServer`、`ServerClient`、`ServerTargetSource`、`parseServerUrl`、
`normalizeServerAddress`、`connectionSettingsPath`、`connectionSettingsToTarget`、`readConnectionSettings`、
`writeConnectionSettings`、`connectionLabel`、`readDescriptor`、`resolveToken`、`explainUnauthorized`、`SocketServerClient`

配置与 MCP：`ConfigPort`、`createRemoteConfigPort`、`McpConfig`、`McpReadResult`、`McpScope`、`McpServerEntry`、
`McpServersMap`、`ModelParams`、`ModelLevel`、`clientWorkspacePath`、`WorkspaceFileEntry`、`MAX_TEXT_BYTES`

会话与消息：`AgentKind`、`AgentStore`、`RemoteSessions`、`SessionStreamState`、`SessionSnapshotResult`、
`SessionQuestionEvent`、`SessionNoticeCode`、`ServerNoticeCode`、`SessionChannel`、`MessageContent`、
`MessageContentBlock`、`UploadContentInput`、`ContentUploadResult`、`ChannelNoticePayload`、`GlobalNoticeSlot`

宿主状态：`ServerStatus`、`ServerStatusDeps`、`readServerStatus`、`PhaseInfo`、`NoticeListResult`
