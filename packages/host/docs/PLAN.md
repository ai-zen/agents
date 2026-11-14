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

## 1. 现状快照（2026-11-15 实跑，不是估计）

| 仓 | 分支 / HEAD | 未提交 | 类型检查 | 用例 |
|---|---|---|---|---|
| `agents`（host） | `feat/server-rewrite` / `a501730`（本波只在它上面叠一个 `.md` 提交） | 0（本轮只改 `.md`） | `tsc --noEmit -p tsconfig.json` **0 错** | **796 绿 / 54 文件**（22.9s） |
| `agents`（client） | `feat/server-rewrite` / 同上 | 0（同上） | `tsc --noEmit -p tsconfig.json` **0 错** | **110 绿 / 11 文件**（2.1s） |
| `cli`（TUI CLI） | `main` / `fb29f4e`（本波只在它上面叠一个 `.md` 提交） | 0（本轮只改 `docs/*.md` 与两个 README） | `tsc --noEmit -p tsconfig.test.json` **0 错** | 默认集 **953 绿 / 63 文件**（17.9s）；真进程 e2e 本轮**未复跑** |
| `desktop` | `feat/new-server` / `0b34dc0` | 0 | 本轮**未复跑**（只改了夹具与 `chat.send` 的 `queued` 分支） | 同上（上一轮记的是 main 121 + 3 跳过 / render 70 / 8 文件） |
| `cli-old-archive`（旧 TUI CLI 冻结快照） | detached @ `pre-split-20261111` / `ace42a0` | 0（只读目录；只有 README 首行那行归档声明是新增内容） | 不参与 | 只读参照物，不是迁移对象 |

**结论**：契约面已经定稿 —— **62 个方法 / 6 个事件**（`METHOD_NAMES` 实测 62 条；2026-11-14 删掉 `host.capabilities` 后 63 → 62，能力清单连同 252 条 `capability.*` 文案一起下架，见 PRD F-E5 的订正），文档与代码在这一轮对齐（`architecture.md` 的方法表逐条核过）。「host ↔ TUI CLI」这条链已经通了**并且发过一版**：`@ai-zen/agents-host@0.1.0-alpha.1`（上游 `@ai-zen/agents-core@4.6.0-alpha.0` / `@ai-zen/agents-sdk@1.2.0-alpha.0` 同批发布）。`cli-old` 已降级为只读归档（`cli-old-archive`）。

**干完的与剩下的**：W1（契约补齐）、W2（CLI 收口）、W3（归档与文档）、W6（运行期可输入与重开回看，见 §7.6）**完成**；剩下两笔 —— **W4**（桌面端完整问答视图，优先级最低）与 **W5**（兜底治理，等契约与客户端定型后再动）。

## 2. 波次总览

| 波 | 目标 | 验收（一句话） | 依赖 | 状态 |
|---|---|---|---|---|
| **W1 契约补齐**（P0-A） | 用户裁定的契约面 12 条落进 `wire` | 12 条各有用例；`METHOD_NAMES` **65 → 63**；capabilities / i18n 同步；每个新字段都举得出「哪个客户端哪一行用它」 | 无 | **✅ 完成**（2026-11-14，落地方式见 §3.4） |
| **W2 CLI 收口**（P0-B） | `npx` 拉起 + 下载屏 + `/ws` + `/shutdown` + 命令集增删 | 干净环境从零起一次宿主；失败 / 取消三条路径各有用例；命令表与 PRD F-E1 逐条对齐 | W1 | **✅ 完成**（2026-11-14，落地方式见 §4.4；同批发布 `agents-host@0.1.0-alpha.1`） |
| **W3 归档与文档** | `cli-old` 归档、旧包名清干净、`architecture.md` 跟上新契约 | 三份文档与代码一致；旧包名只剩归档目录 | W1、W2 | **✅ 完成**（2026-11-14，见 §5） |
| **W4 桌面端完整问答视图** | 标准完整问答视图（优先级最低） | 真 GUI 竖切一遍（六步，见 §6）；`question.list/answer` 有调用点 | 无（排期在 W3 之后） | ⬜ 未开始 |
| **W5 兜底治理** | `retry` / `fallback` / `catch` 密集文件逐文件清理 | 三列清单全覆盖；留的每条指得出消费者 | W1–W3 | ⬜ 未开始（依赖已就绪） |
| **W6 运行期可输入与重开回看** | 跑中发送进 inbox（D14 改写）、`queued` 回包、排队数进运行状态、重开后子代理页签、会话列表带运行状态；客户端侧：运行中可输入、`/sessions`、状态栏对齐旧版 | PRD D14 / F-C12–F-C15 / F-I14 / F-I15 各有代码落点与用例；真 core 跑进真 `ChatRunner` 取到证 | W1 | **✅ 完成**（2026-11-15，落地方式见 §7.6） |

---

## 3. W1 契约补齐（P0-A）—— ✅ 已完成（2026-11-14）

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

### 3.4 落地方式（2026-11-14 复核，实测不是估计）

**方法表 65 → 63 的账是「− 5 + 3」**（63 条由 `node` 直接数 `src/wire/methods.ts` 的 `METHOD_NAMES` 数组得出，`src/handlers/capabilities.ts` 的能力条数也是 63，两边一一对应）：

| 增减 | 方法 | 去向 |
|---|---|---|
| −1 | `host.usage` | 整条删除，用量只剩 `conversation.state.usage`（`UsageSnapshot` 的 `turn` / `total` / `subAgent` / `rate`） |
| −3 | `credential.list` / `create` / `revoke` | **只删 wire 面**（`MethodMap` + `METHOD_NAMES` + handler + capabilities + i18n 键）；`CredentialService` / `CredentialRepository` / `<数据根>/run/token` / `agents-host token create\|list\|revoke` 一字未动，`Credential*` 形状留着给那三个子命令用 |
| −1 | `config.patchMcps` | 整层替换删除，由下面两条按 id 的写法取代 |
| +1 | `agent.restoreFactory` | 新增：`{ agentId, dryRun? }`，与 `model.restoreFactory` 同形 |
| +2 | `config.saveMcp` / `config.deleteMcp` | 新增：按 id 的增删改，形状与 `config.saveEndpoint` / `deleteEndpoint` 一套 |

`grep -rn "host.usage"` 现在只命中注释与一条**防回归用例** —— `src/wire/methods.test.ts` 的「已删掉的方法不许自己长回来（裁定 2026-11-13）」把 `host.usage` / `credential.list` / `credential.create` / `credential.revoke` 四个名字钉成运行期 + 编译期两道断言（`Extract<MethodName, …> extends never`）。契约表里没有它们。

| 条 | 落地方式（做成什么样） | 证据（能指回的那一条） |
|---|---|---|
| W1-1 | `AgentView` 加 `messages` / `function`（`wire/methods.ts`）；`AgentService.toView` 原样转出 SDK 的 `AgentDefinition["messages"]` / `["function"]`，读不出来就给 `null`，非子 Agent 的 `function` 恒为 `null` | `AgentService.test.ts`：「读-改-写往返：get 到的 messages 原样交给 update 等于没改」「…子 Agent 的 function 原样写回也不变」 |
| W1-2 | `agent.restoreFactory` 进 `MethodMap` / `METHOD_NAMES` / handler 表 / capabilities；`dryRun: true` 只算代价、不落盘；本来就在出厂状态时回 `restored: false`（不是错） | `agentHandlers.test.ts`：「八个方法都注册上了（含 F-F5 的 `agent.restoreFactory`）」「本来就在出厂状态的助手回 `restored: false`，这不是错误」 |
| W1-3 | `agent.setThinking` 的 `level: string \| null`，`null` = 删掉定义上的思考参数（撤回设值，不是设成某一档） | `AgentService.test.ts`:「`AgentService.setThinking { level: null }`（F-B6：撤回设值，不是设成某一档）」 |
| W1-4 | `DiscoveryEntryView` 带齐六个传输字段 + `extra`；非 MCP 三类恒为 `null` / 空对象；回写时 `extra` 逐字带回 | `DiscoveryService.test.ts`：「条目视图带齐传输入口：传输方式与它的参数，加上两个未知键进 extra（F-F6）」 |
| W1-5 | `config.patchMcps` 从 `MethodMap` / `METHOD_NAMES` / handler / capabilities / i18n 全部消失；改由 `config.saveMcp`（有 id 则改、无则建）/ `config.deleteMcp` 按 id 动一条；服务层的 `DiscoveryService.writeMcpEntry` / `deleteMcpEntry` 以磁盘原文为底、只覆盖明确给了的字段 | `DiscoveryService.test.ts` 的 deleteMcpEntry 组（删两次 / 跨作用域拒 / 空 id 拒） |
| W1-6 | `DiscoveryLayerView.scope: McpEditableScope \| null`：MCP 5 层里正好 2 层非空（`user` / `workspace`），其余与另外三类恒 `null` | `DiscoveryService.test.ts`：`discovery.mcps.map((layer) => layer.scope)` 的逐层断言 |
| W1-7 | `ModelInput.tokenThresholds` 可选：`model.create` 省略时套出厂默认（SDK `DEFAULT_APP_CONFIG` 那份，宿主不另写数字），`model.update` 省略时不动 | `ModelService.test.ts`：「不传阈值就套出厂默认那一档（来源是 SDK 的出厂清单，宿主不另写数字）」 |
| W1-8 | `message.list` 加 `around`；窗口 `AROUND_WINDOW` = **40**（`MessageService`），前后尽量均分、命中那条一定在里面，`anchor` 报它；没命中回空页 + `anchor: null` 不报错；与 `after` 同给时 `around` 优先 | `MessageService.test.ts` 的「`MessageService.list` 的 around（F-C6 的定位）」一组（中间 / 头 / 尾 / 已撤回 / 与 after 一起给） |
| W1-9 | `host.usage` 不存在于 `MethodMap` / `METHOD_NAMES` / handler / capabilities / i18n | `wire/methods.test.ts` 的防回归用例（见上） |
| W1-10 | `credential.*` 的 wire 面全删、服务层与 `token` 子命令全留（两句区分已写进 `wire/methods.ts` 的注释与 `architecture.md` §6） | 同上；`agents-host token create\|list\|revoke` 的进程级用例仍在 |
| W1-11 | `host.upgrade` / `host.shutdown` 都还在；CLI 的 `/upgrade` 与 `/shutdown` 各接它们 | `cli/src/commands/handlers.ts`:813（`host.upgrade`）、:948（`host.shutdown { reason: "cli" }`） |
| W1-12 | 没有 `model.restoreFactoryImage`（`grep -rn restoreFactoryImage src/` 为空），防下一棒「顺手补对称」 | 同上 grep |

**capabilities 同步**：~~能力清单 63 条与 `METHOD_NAMES` 一一对应~~ —— 这条要求在 2026-11-14 作废：能力清单（`host.capabilities` / `hello.capabilities` / `handlers/capabilities.ts` / `CapabilityView`）整个删掉了，两端零消费者（CLI 的 `/help` 用自己的命令表，桌面端从握手回执里就丢）。`architecture.md` 的方法表（62 条）/ A13 / §7 已同批对齐。

---

## 4. W2 CLI 收口（P0-B）—— ✅ 已完成（2026-11-14）

### 4.1 前置：S1–S5 已完成（已落地并提交，当时 HEAD `57a295f`；本轮 HEAD `57bcfdb`）

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
  在 CLI 里零调用（grep）；i18n 删掉 `cmd.search.*`；帮助屏由 CLI 自己的命令表渲染（2026-11-14 订正：原计划走 capabilities，见 PRD F-E5），不再多一条。

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
| `status-blocks.ts`、`status-segments.ts`、`session-rate.ts` | F-I6 状态栏块 / F-I5 速率 | 块**由客户端现拼**（2026-11-14 起 `statusBlocks` 不在契约里）：助手 / 模型 / 思考档 / 目录取 `conversation.get` 的视图，上下文与用量取 `conversation.state`，工具与子 Agent 取 `run`；只有速率走 `conversation.state.usage`（就这一个口径） |
| `tui/config-wizard/*`、`mcp-command.ts`、`agent-switch.ts`、`reasoning-effort.ts` | F-F1~F-F7、F-B4、F-B6 | `config.*` / `agent.*`（W1 之后 MCP 那屏走 `saveMcp` / `deleteMcp`） |
| `tui/key-debug.ts`、`mouse.ts`、`input-editing.ts`、`system-editor.ts`、`hook.ts`、`clipboard.ts` | F-J3、F-H1~H3、F-C11、F-A4、F-H6 | — （本机能力，不经宿主） |
| `version-compare.ts` | F-E3 升级 | `host.upgrade` + W2-1 的 range 比对 |

每条的验收照旧：真进程手跑一遍 + 一条钉住该行为的用例。
（`search.conversations` 从这张表里出去：一阶段不做搜索，见 W2-6。）

### 4.4 落地方式（2026-11-14 复核）

| 条 | 落地方式（做成什么样） | 证据 |
|---|---|---|
| W2-1 npx 现下现起 | 缺省实现是连接层的 `spawnHostViaNpx`（`packages/client/src/connection.ts`）：`npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <数据根>`。`<range>` 只有一处来源 —— CLI 的 `version.ts` 从 `devDependencies` 读 `@ai-zen/agents-host` 得 `AGENTS_HOST_RANGE`，构建时由 `rolldown.config.mjs` 的 `__AGENTS_HOST_RANGE__` 注入。两条路的判据只有一句：`context.entry === undefined` 就 npx（桌面端把宿主捆进产物、递 `entry`） | `cli/src/version.ts`、`cli/rolldown.config.mjs`；e2e 用**假 npx**（`src/__tests__/e2e.test.ts` 的注释写明参数形状 `-y @ai-zen/agents-host@<range> serve --ai-zen-dir <目录>`），不联网 |
| W2-2 下载屏 | `cli/src/tui/screens/host-download.tsx`：阶段式、不确定进度；阶段由连接层的 `HostLaunchStage` 给（`resolving` / `installing` / `starting` / `connected`），**不解析 npm 输出、不报百分比**；「有就上」时一个阶段都不来，这时一个字节都不画（不为一次什么都没做的检查闪一下屏） | `host-download.test.tsx`：「解析版本 → 下载并安装 → 启动宿主 → 连上，最后报 connected」「每个阶段都在屏幕上真的出现过（不是一口气跳到结尾）」「只来了 connected → 一个字节都不画」 |
| W2-3 失败 / 取消 | 失败：屏上多一行「子进程自己说的那句原因」+ `R` 重试；`Esc` / `Ctrl+C` 同义 → 停手（`AbortSignal` 杀掉正在拉起的子进程）并回连接屏、**不退出程序**；stdio（一次性）没有屏：只有一行原因 + 非 0 退出码 + stdout 为空 | `host-download.test.tsx` 的失败 / `R` / `Esc` / `Ctrl+C` 四条；`stdio.test.ts` 的「runStdio：本机拉起宿主失败（一次性调用没有屏）」 |
| W2-4 `/ws` | 命令表里的 `ws`；三种动作 = **列 / 选 / 建**，三个入口（TUI 启动 / stdio / `/ws`）共用 `src/workspace.ts` 一份判据。启动策略：**本机** = 当前目录这条糖（`workspace.create` 递 cwd，有就复用）；**远端** = 只认「上次进入的那个」（`<数据根>/cli/last-workspace.json`，按宿主分键），都没有才进选择环节，且**绝不**把客户端路径递上去 | `src/workspace.test.ts`（含「远端 + 从没记过 → `null`，一条 `workspace.create` 都不发」） |
| W2-5 `/shutdown` | `commands/handlers.ts` 的 `/shutdown` → `host.shutdown { reason: "cli" }`，**一次**二次确认（确认框把「会踢掉同一台机器上的其他客户端」说清楚）；取消那一支一个方法都不调；退出 CLI 本身**不**发 shutdown | `handlers.test.ts` 的 `/shutdown` 一组（确认框文案 / 取消不调 / 确认带 `reason` 回连接屏 / `accepted: false` 不自己编原因 / 拒绝走兜底出口） |
| W2-6 命令集 | 删 `/search`（`commands/registry.ts` 的注释写明「搜索只服务桌面端」）；`/back` 为主名、`/revert` 退成别名；`/pin` 保留；`/ws` 与 `/shutdown` 进表 | `commands/registry.ts` 的 `REGISTRY_ENTRIES` |
| W2-7 `notice.clear` | 通知屏 `Alt+X` 全部清空 → `notice.clear`（按对话清一片），这是它唯一的调用点（不删方法，给它真实出路） | `i18n` 的 `notice.clearHint` / `notice.clearedAll`；`src/pending-notices.ts` 的 `connection.call("notice.clear", { conversationId })` |
| **那次发布** | `@ai-zen/agents-host@0.1.0-alpha.1`（registry 上的版本序列是 `0.0.0-stage` → `0.1.0-alpha.0` → `0.1.0-alpha.1`，`latest` 与 `alpha` 两个 dist-tag 都指 alpha.1）；上游同批发布 `@ai-zen/agents-core@4.6.0-alpha.0` / `@ai-zen/agents-sdk@1.2.0-alpha.0`（sdk 的 `alpha` tag = 1.2.0-alpha.0，`latest` 仍是 1.1.0） | `npm view` 实测（本机无提交任何包配置） |
| **2026-11-14 之后那一版** | `@ai-zen/agents-host@0.1.0-alpha.5`（`latest` 与 `alpha` 双 tag）+ **`@ai-zen/cli@1.1.0-alpha.0`**（只打到 `alpha` tag，`latest` 仍是稳定版 `1.0.2` —— 不许预发布顶掉稳定线）。上游 `core@4.6.0-alpha.0` / `sdk@1.2.0-alpha.2` 自 alpha.3 起 `src` 零改动，**未重发**。CLI 的 `devDependencies` 里宿主范围提到 `^0.1.0-alpha.5`（`AGENTS_HOST_RANGE` 是构建期烧进产物的，改完必须重新 build 才生效；`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 同步加白）。`0.1.0-alpha.4` 同批发出后几分钟即被 alpha.5 取代：运行期代码一致，差别只是 `.d.ts` 里指向已删 `host.capabilities` 的残注释被清掉了 | registry 实测 + `npx -y` 真拉真跑（`agents-host version` → `0.1.0-alpha.5（协议 1）`） |

---

## 5. W3 归档与文档（W1、W2 之后）—— ✅ 已完成（2026-11-14）

**W3-1【人的决策】`cli-old` 降级为归档**：目录加 `-archive` 后缀（`cli-old` → `cli-old-archive`），
README 首行写「不要改、不要当实现依据」。
- 验收：目录名改到位；README 首行就是那句话；PRD §1 的出处名同步；仓库里指向旧路径的引用全部改到新名
  （`grep -rn "cli-old/" --exclude-dir=cli-old-archive` 无输出或已是新名）。
- 备注：该目录当前是只读权限（`dr-xr-xr-x`），改名动的是父目录，不必先 `chmod`。

**W3-2【AI 的决策】旧包名（`agents-server`，现名 `@ai-zen/agents-host`）改准**：文档与注释里残留的一律改成 `@ai-zen/agents-host`
（或按上下文直接去掉）。
- 为什么：宿主早改名（R77），残留旧名会让下一棒以为存在另一个包，或者去 npm 找一个不存在的坐标。
- 验收：全仓文档里不再有旧的宿主包名（本波实测见 §5.1：活文档 0 处，只剩历史记录与两处源码注释）。

**W3-3【需求】`architecture.md` 随契约补齐更新。**
（W1 里明确「不动它」就是为了等契约定稿一起改；结构与实现相关，一次改对。）
- 内容：方法表 **65 → 63**（新增三条、删五条）；A13「每方法一条」的条数；A12 补 `around`；
  §6 接线补 `config.saveMcp` / `config.deleteMcp` / `agent.restoreFactory`；§3 对象图补 `AgentView` 的
  `messages` / `function`、`DiscoveryEntryView` 的传输字段 + `extra`、`DiscoveryLayerView.scope`。
- 验收：`architecture.md` 的方法条数与 `METHOD_NAMES` 逐条对齐（capabilities ↔ `METHOD_NAMES` 已有用例钉住，
  文档这边人工核一遍）；§9 已知缺口按本轮改写；§11 变更记录加一行。

### 5.1 落地结果（2026-11-14）

**W3-1（`cli-old` 归档）**：目录已改名 `/home/ubuntu/projects/ai-zen/cli-old-archive` —— 只改父目录里的条目名，内部一个文件都没动、`.git` 没碰（`git -C cli-old-archive status --short` 只有 `README.md` 那一行）。`README.md` 在**首行上方**加了一段声明（「归档，不要改，不要当实现依据」+ 活的实现路径 + `git show pre-split-20261111:<path>` 的对照办法）；改前 `chmod u+w`、改完**权限复原成 `444`**。现在 `ls -ld` 仍是 `dr-xr-xr-x`，目录内文件全是 `444` / 目录 `555`。
- **没做**：PRD §1 的出处名同步（`PRD.md:3` / `:27` 仍写着 `cli-old`）—— 按本文件 §10 的分工，PRD 只有用户能改，所以留给用户（见 §8.3）。

**W3-2（旧包名）**：改了 4 个文件，全是 `cli/docs` 下的活文档 ——
- `cli/docs/zh/getting-started.md`、`cli/docs/en/getting-started.md`：「运行时依赖」那一行换成 `package.json` 的真面目（只剩 `ink` / `react` / `highlight.js` / `lowlight` / `string-width`，`@ai-zen/*` 三个是私有包、构建时内联），加一条「宿主不需要预先安装」（包名 `@ai-zen/agents-host`、住 `devDependencies` 当版本范围、`npx` 现下现起）；「纯 stdio 也跑在服务端」改成「跑在宿主上」，补阶段式下载屏与「会话落在宿主的 `<数据根>/ai-zen.db`」；「工作区跟着目录走」那一段改成「本机递 cwd / 远端不上送目录、只认上次进入的那个」；命令表补 `/ws` 与 `/shutdown` 两行。
- `cli/docs/zh/mcp.md`、`cli/docs/en/mcp.md`：五层链的归属从「服务端的 `agentPaths().mcpConfigs`」改成「宿主的 `DiscoveryService`（读文件走 SDK 的 `discoverMcpServers`）」，并说明 CLI 只按 `config.getDiscovery` 回的层序渲染。
- `cli/README.md` / `cli/README.zh.md` 复核：已无旧名（实测确认，未动）。
- `desktop/docs/**`、`agents/docs/**`：实测 **0 处**旧名（`grep -rln "agents-server" desktop/docs agents/docs` 为空），未改。
- **剩下的命中是有意不动的，分三类**：① `agents/.ai-zen/handoffs/**` 与 `cli/.ai-zen/handoffs/**` —— 历史记录，不假造过去；② `cli/.ai-zen/reviews/**` 两份 —— 写的是那一轮的事实，性质同交接记录；③ 两处源码 / 构建配置的注释（`cli/src/server-client.test.ts:8` 是在解释「那个常量早已消失」，`cli/rolldown.config.mjs:51` 的包名清单仍是旧名）—— 本波**不许动源码**，后者确实该改，留给下一波。所以「`grep` 只剩归档目录（或零）」这条验收**在文档层面成立**，全仓而言还有上面三类。

**W3-3（`architecture.md`）**：六处 —— §1 的 A12（补 `around` 的完整取法）与 A13（65 → 63）；§3 新增「视图与入参的几处形状」一张表（`AgentView.messages` / `function`、`DiscoveryEntryView` 的传输字段与 `extra`、`DiscoveryLayerView.scope`、`McpOauthView` 的掩码口径、`ModelInput.tokenThresholds` 可选，每条写「谁产生 → 客户端拿它做什么」）；§6 方法表改成 13 个域 63 条 + 「65 → 63 的账」一张表 + `credential.*` 「删的是契约面、能力仍在」一段；§6 桥接名单后的「其余 60 条」→ 59；§6 `message.list` 的取法表补 `around` 三行（含 40 条窗口、空页不报错、与 `after` 同给时谁优先、消费者只有桌面端）；§7 能力条数 63；§8 把 `@ai-zen/agents-client` 列成「共享连接层」并写清它这一轮定的三件事（npx 拉起 / 阶段回调 / 取消），明确「怎么画屏」不归它；§11 加一行变更记录。
- **方法数 63 是怎么核的**：用 `node` 直接数 `src/wire/methods.ts` 里 `METHOD_NAMES` 数组的元素 → 63；再交叉核对 `grep -c '^  "'` → 63、`src/handlers/capabilities.ts` 的能力条数 → 63；最后逐域点数（`7+5+13+1+2+3+8+8+8+3+1+2+2` = 63）。三个数一致才写进文档。
- **§9 已知缺口没改**：那两条（子 Agent 消息回看、客户端自造问题）这一轮既没消除也没新增，改了反而是错的。

---

## 6. W4 桌面端完整问答视图（优先级最低）

【人的决策】**做标准的完整问答视图**，不是只把死路堵上的最小方案。
【需求】PRD 里落点含 `S+C` / `C` 的条目，桌面端同样欠着（F-I9 已改成这个口径）。

要还的账，按「先救命、后补齐、最后体验」排：

1. ~~**会跑死对话的 3 条（W4 内部优先级最高）**~~ —— **已完成（2026-11-14）**：`QuestionView` 整份透传
   （`main/src/host/events.ts` 的 `onQuestion`），`chat.questions` / `chat.answerQuestion` 两个服务接上
   `question.list` / `question.answer`，`views/main/QuestionPanel.vue` 画候选并挡输入区，答完按
   `effects.newConversationId` 切会话。剩下的「交接 `handoff.start`」仍属第 3 档（界面还没有入口）。
2. **完整问答视图本身**：消息列表（源码着色、代码高亮、工具调用压一行、失效消息删除线）、输入区
   （多行 + 限高 + `@` + 图片粘贴 + 草稿）、作答面板（`question.*`）、通知栏（`notice.*`）、状态栏块、
   用量（`conversation.state.usage`）、错误说人话。
3. **22 项 PRD 明文要求但零入口**：搜索、撤回、置顶、思考强度、临时对话、记住上次会话、帮助、能力清单、
   切语言、模型 / 图片模型 / 助手 / MCP / 端点编辑、默认项 3/5、工具输出上限、`/` 与 `@` 菜单、
   用量与状态栏、通知栏。
4. **体验欠账**：首启引导屏没跑过真 GUI（本机无 electron 二进制，但有 `xvfb-run`）、
   「选服务 + 填 Key」不是向导只是跳设置页。

**验收（真 GUI 竖切，六步，一步都不能跳）**：在 `xvfb-run` 里跑真正的 Electron 应用，按下面顺序走一遍，
每步都写下看到的：

| # | 步骤 | 过了的样子 |
|---|---|---|
| 1 | **连上** | 首启能选本机 / 远程；本机那条能连上宿主，状态从 `connecting` 到 `ready`（带宿主自报的 `protocol` / `version`）；远程不可达时窗口照样能开，失败是窗口里的一件事 |
| 2 | **流式** | 正文增量逐字出现（不是一次性蹦出来），思考与工具调用各按自己的形状显示，一轮结束状态栏回空闲 |
| 3 | **作答交接问题** | 跑到交接线弹出 `question`（`question.list` 有调用点），选「新对话」后旧对话完整保留、新对话带着交接摘要开起来；`QuestionView` 不再被压成一条 notice |
| 4 | **撤回** | 界面上那个动作 → `conversation.revert`；被撤回那条从列表消失，输入区能改完重发 |
| 5 | **搜索命中并定位** | 搜一个词 → `search.messages` 命中 → 点命中 → `message.list({ around })` 把那条摆到眼前并高亮（`around` 唯一的消费者） |
| 6 | **置顶** | 置顶后该对话跳到 `conversation.list` 顶部，重启桌面端仍然在顶上 |

三条附加：
- `question.list` / `question.answer` 在 `desktop/packages/main` 里**指得出调用点**（现在是零调用，`events.ts` 把
  `QuestionView` 压成 notice）—— 这是 W4 内部最高优先级：不修它，对话跑到交接线就永久报废
  （之后每次 `conversation.send` 被 `question_pending` 拒）。
- 第 3 档那 22 项逐条打勾，打不了勾的写清为什么不做（不许默默留空）。
- `xvfb-run` 这条路**不是设想**：`desktop/TODO` 的历史里记过「本机没有图形环境（`DISPLAY` / `WAYLAND_DISPLAY` 都空）但 `/usr/bin/xvfb-run` 存在 —— 无头 X 这条路是通的」，并给了可直接跑的措辞（`git -C desktop show 1c6e777:TODO.md`，71 行；先决条件是 `pnpm add -D electron` —— 本机 `node_modules/electron` 目前不存在）。

**依赖**：无；排期在 W3 之后（W3 已完成）。

---

## 7. W5 兜底治理（第一遍已完成，2026-11-14）

【人的决策】「复杂兜底」全仓审计要做：`retry` / `fallback` / `catch` 密集文件的**逐文件**清理；等契约与
客户端定型后再做，否则边修边被清理。

**判据只有一条：必要性。** 不是「能删就删」——

| 兜的是什么 | 处置 |
|---|---|
| **不必要**：走到它的条件在这个产品里不可能发生（闭集类型的再校验、不信类型的 `?? 默认值`、同一件事判两遍、恒为空操作的清理） | **删**（连同为它写的用例；测不可达分支的用例本身就是污染） |
| **需要**：真实会发生的坏输入（手改坏的 `config.json` / `mcp.json`、库里坏 JSON 行、不可信客户端帧）与**外部会失败**的动作（网络、子进程、日志、通知） | **留**，并在注释里写清「谁会走到」 |

【AI 的决策】做法：扫出 `catch` / `retry` / `fallback` / `?? {}` / `|| default` 密集的文件，逐文件产出**三列清单**：

| 位置（文件:行） | 是什么兜底 | 处置 |
|---|---|---|
| `…` | 例：连不上就假装空列表 | **删**（没人会走到 / 走到了也只会掩盖真相） |
| `…` | 例：读配置文件失败回落默认 | **留** —— 谁在用：`cli/src/config-editor.ts:…`（理由：首次启动没有文件是正常状态） |

**验收**：清单覆盖审计范围内每一个兜底点；每条「留」的都指得出「谁会走到」与为什么它是必要的，
**指不出来就删**（§0 第 1 条、§9 第 4 条同一把尺子）；删完 `tsc` 0 错、用例全绿、真进程竖切不回归。
**依赖**：W1–W3（先让契约与客户端定型）。

**第一遍结果（2026-11-14）**：host 删 14 处、cli 删 3 处、desktop 删 3 处；留下并写清「谁会走到」的
各有几十处。另有 13 处被标成「想删但按必要性判据应当留」的（坏 JSON 行会让整页 500、`config.json`
能手改坏、策略表能手改坏、`@` 清单读不到时删了会变 `unhandledRejection`……）—— **结论是留**，并且
理由已写进代码注释；这不是「不敢删」，是「按必要性该留」。
第二遍只在有新证据表明某条其实**不必要**时才做。

---

## 7.5 宿主 i18n 里那些「有句子、没人发」的码（2026-11-14 清理时记下来的缺口线索）

宿主词典里 33 条文案没有任何生产码引用（`status.*` 六态、`usage.*`、`notice.*` 几条、
`message.*`、`question.confirm.*`、`model.*`、`handoff.*` 等）。按「不留没人读的句子」全部删掉了，
但删掉的不是需求 —— 其中**十九类是「宿主本该说、现在一个字都不发」**的提示。要补实现时从这里挑，
别重新发明一套话：

| 该说而没说的 | 原本留着的码 | 现状 |
|---|---|---|
| 删了对话 / 删了工作区之后确认一句 | `notice.conversationDeleted` / `notice.workspaceDeleted` | 两个方法都在契约里，删完宿主什么都不推 |
| 图片上传完 | `notice.assetsUploaded` | `asset.end` 已经回了素材，通知没发 |
| 这条连接换语言 | `notice.languageChanged` | `host.setLanguage` 只改连接状态 |
| 撞到 token 硬线（F-D8） | `notice.hardLimitHit` | 硬线拦住了这一轮，界面只看到「停了」 |
| 撤回一条消息之后 | `message.reverted` | `conversation.revert` 只回消息列表 |
| 工作区目录没了（D12） | `message.cwdMissing` | 目录事实在 `FolderFact` 里，没有一句提示 |
| 子 Agent 结束 | `message.subagentFinished` | 只在 `RunState.subagents` 里变状态 |
| 附件被丢下（张数超限） | `message.attachmentTooMany` / `attachment.tooLarge` | 只有 `notice.attachmentDropped` 一条 |
| 不可撤销动作的二次确认题 | `question.confirm.prompt/accept/decline` | 各端自己拼确认框（F-F9 的落点其实在客户端） |
| 模型不可用 / 读不了图 | `model.unavailable` / `model.visionRequired` | 只有 `error.*` 那几条错误码 |
| 端点被删了还挂着引用 | `endpoint.missing` | 只在 `ReferenceList` 里列引用者 |
| 删工作区的代价 | `workspace.removalCost` | 桌面端拿到 `removalCost` 数字，CLI 没有删工作区的命令 |
| 交接被拒 / 这个工作区还没文档 | `handoff.declined` / `handoff.noDocuments` | 交接被拒走 `error.handoffDeclined` |
| 六态的人话 / 用量的读法 | `status.*` × 10、`usage.*` × 4 | 归客户端：CLI 有 `phase.*` 与状态栏格式化 |

## 7.6 W6 运行期可输入与重开回看（2026-11-15，已完成）

> 本轮改的是**行为**，不是契约形状：`conversation.send` 在跑中不再回 `busy`，改成排队；`RunState` 多一格
> `inboxPending`；`ConversationSummary` 多一格 `run`。需求侧已写进 PRD（**D14 改写** + F-C12–F-C15 / F-I14 / F-I15），
> 本节只写拆法与落点。

### 7.6.1 运行器：跑中入队的路径

```
conversation.send
  → assertSendable（D23 的问题闸门：排队不是绕道）
  → ensurePersisted（R56：草稿落成真行）
  → ChatRunner.enqueue  ── 拿到 → 回 { userMessageId, assistantMessageId: null, queued: true, attachments, acceptedAt }
  └─ 拿到 null（装配没完成 / 这一轮已收尾 / 刚按了停）→ 老路径 ChatRunner.run()（这时才可能 busy）
       → 那一轮 agent 的 pushInbox({ messageId, source: "user", priority: "high", content })
       → core 在轮末落成 Message.User（落地走 agent.append，所以同样广播 message 事件、宿主照它落库）
```

**四个取件点**（core `Agent.run()` / `send()`）：

| 优先级 | 取件点 | 语义 |
|---|---|---|
| `high` | 每圈内循环末尾（`onInnerLoopEnd` 之后、下一次 Assistant 占位之前） | 工具轮跑完的边界：工具结果已在 `messages` 里，插进来的 User 排在它之后，下一次请求天然看得见 |
| `low` | 内循环全部停下、两个 `reconcile*` 之后 | agent 停下之后插入 |
| — | `onInnerLoopsEnd` 之后、`onAfterSend` 之后各再判一次（不分优先级，按入队顺序） | **「只要回了 `queued` 就一定落地」的落点**：取件点若排在收尾钩子之前，那段窗口（跨度＝「最后一次取件 → `send()` 返回」）里回出去的 `queued` 就是假话（SDK 的 `AutoMigratePlugin` 就在这个钩子里问用户，窗口是无界的） |

三条不变量：① 只有**真的插进了条目**才续圈（防死循环）；② `abort()` 清空 inbox，`runAborted` 之后四个取件点都不再取（用户按停 ＝ 排队的不发了）；③ `TurnSession.enqueue` 里「判能不能排」与「推」之间**不允许有 await**（否则会出现「判完还开着、推的时候已关上」，条目落进一个再也不会被取走的 inbox，而宿主已经回了 `queued`）。装配期间来的那几句在 `waitEnqueueable` 里等，上界 `QUEUE_READY_TIMEOUT_MS` = 10s，到点回老口径。

### 7.6.2 为什么排队消息的**首次写入**必须在落地那一刻

`seq` 是 `MAX(seq)+1`、按插入顺序给，而客户端读回来就按它排 —— 它是转录顺序的**唯一**依据。助手消息是边流边写的（`scheduleStreamWrite` 到节流点就写一片）。所以排队的用户消息若等到 `persistFinal` 才首次写，它拿到的 `seq` 会比「它引出的那一轮回答」更大：重开这段对话读到的转录成了「助手说完 → 助手又说 → 用户冒最后一句」，最后那句永远没有回答。落地那一刻就写（`persistLandedQueued`，走同一条 `writeChain`，紧跟着 `linkQueuedAssets` 记素材关系行，`createdAt` 取落地时刻），`persistFinal` 只做终态覆盖（`ON CONFLICT (id) DO UPDATE` 不碰 `seq` / `createdAt`，仍是一行）。

### 7.6.3 落地方式

| 条 | 落点（包 + 文件） | 证据 |
|---|---|---|
| F-C12 跑中发送 | `packages/host/src/handlers/conversationHandlers.ts`（`sendTurn` 的分流与 `queued` 回包）、`packages/host/src/runtime/ChatRunner.ts`（`ChatRunner.enqueue` / `TurnSession.enqueue` / `waitEnqueueable`）、`packages/host/src/wire/methods.ts`（`ConversationSendResult.queued`） | `ChatRunner.inbox.test.ts`（真 core Agent 跑进真 ChatRunner：「工具正跑着时 enqueue → 工具轮后落地 → 第二轮请求里带着它，且第一轮没被 abort」）；`conversationHandlers.test.ts`：「跑的时侯第二句不再被拒：它排进那一轮的 inbox，回包说 queued」 |
| F-C13 插入点与收尾取件 | `packages/core/src/Agent.ts`（`runLoops()` 的两个插入点、`run()` 与 `send()` 末尾的兜底取件）、`packages/core/src/Inbox.ts`（落成 `Message.User`、来源注释） | `packages/core/src/Agent.inbox.test.ts`（19 条：高 / 低优先级、来源注释、中止、空 inbox 与改动前一致、顺序、id 被尊重）；`ChatRunner.inbox.test.ts` 的两条收尾边界用例：「收尾边界（`onInnerLoopsEnd` 里）入队：回了排队，那条就一定在这一轮里落地」/「…（`onAfterSend` 里）入队」 |
| F-C14 落地即写库 | `packages/host/src/runtime/ChatRunner.ts` 的 `persistLandedQueued` / `linkQueuedAssets` | `ChatRunner.inbox.test.ts` 的「排队落地那一刻就写库：库里它的 `seq` 排在它引出的那条回答之前」；`ChatRunner.test.ts` 的「排队那条在落地那一刻就写库：写入顺序与最终 `seq` 都排在它引出的回答之前」（假 agent 版）；`conversationHandlers.test.ts` 的「库里的顺序（`seq`）：排队那句排在它引出的回答之前…」 |
| F-C15 会话列表带运行状态 | `packages/host/src/wire/methods.ts`（`ConversationSummary.run`）、`packages/host/src/services/ConversationService.ts`（`ConversationRuntimePort.runState`，可选）、`packages/host/src/runtime/RunRegistry.ts`（`summary`） | `RunRegistry.test.ts` 的「summary 只问一段：在跑给开始时刻，没在跑给 null」；`ConversationService.test.ts` 的 `run` 一组；`host.integration.test.ts` 的「重启后 `run` 为 `null`」 |
| F-I14 `inboxPending` | `packages/host/src/wire/states.ts`、`packages/host/src/runtime/ChatRunner.ts`（`buildRunState` 现读 `agent.inbox.length`）、`packages/host/src/handlers/conversationHandlers.ts`（空闲恒 0） | `conversationHandlers.test.ts` 的「run.state 的 inboxPending：入队后 > 0、落地后归 0、空闲时为 0」与「abort 丢弃排队条目：回包的 run 里 inboxPending 为 0，那一句也不落库」 |
| F-I15 重开后子代理页签 | `packages/host/src/services/MessageService.ts`（`subAgents`）、`packages/host/src/storage/MessageRepository.ts`（`listDelegated`）、`packages/host/src/handlers/conversationHandlers.ts`（`idleRunState` 收 `subagents` 入参） | `MessageService.test.ts` 的 `subAgents` 一组（「名字 / 用量 / 条数 / 开始时刻都从库里来…」「子 Agent 自己吐过 error 行时，父工具结果说什么都盖不过它」「从没委派过就是空数组」）；`MessageRepository.test.ts` 的「listDelegated 只给子 Agent 那一半」；`conversationHandlers.test.ts` 的「跑过子 Agent 的对话重开时，subagents 从库里捞回来」「子 Agent 自己出过错的那次委派，空闲时推成 error」「abort 回包里的空闲现场也带着子 Agent」 |

**反向验证记录（提交说明里都有）**：去掉低 / 高优先插入点各红一批；去掉 `onInnerLoopsEnd` 之后的兜底取件会红「回了 `queued` 却没落地」；把「落地即写库」改回收尾写会红库序三条；把 `idleRunState` 的 `subagents` 改回 `[]` 红三条；把 `toSummary` 的 `run` 改回 `null` 红一条。

### 7.6.4 客户端侧（同一轮，已落地）

| 仓 | 做了什么 |
|---|---|
| `cli` | `session.send` 认 `queued` 回包（不 `waitForTurn`、按回包 id 乐观回显、提示「已排队」）；**会话归进程所有**（`src/sessions-registry.ts`：`/new` `/load` `/sessions` 只换「这一屏看哪一段」，旧那段留在后台跑，`dispose()` 只在进程收摊时统一调）；新增 `/sessions`（别名 `/ps`，本进程挂着的 ∪ 宿主上在跑的）；状态栏收敛成旧版三块（身份 / 用量 / 快捷键），`cwd` / `context` / `tools` / `subagents` 四块撤掉；阶段行搬到输入框之上的分割线之上、恒 1 行；运行中输入框可用 |
| `desktop` | 夹具跟上新契约；`chat.send` 认 `queued`（不 `beginTurn`、乐观回显 + 一句中文提示） |

**这两仓的文档同步归各自的仓**：`cli/docs/{zh,en}/**` 与两个 README 在这一轮一起改（命令表补 `/sessions`、状态栏口径、运行中可输入），宿主这一侧只改 PRD / PLAN / architecture。

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
| **旧的四个问题** | Q1 已定：删 wire 面、留服务层、`host.upgrade` 保留；Q2 已定：PRD 的 TUI 专属条目不动，归 W2 复验；Q4 已定：兜底审计要做，放 W5 | §8.3（Q3 仍在；Q1/Q2/Q4 已定） |

### 8.2 已定（2026-11-14 增补，8 条；W1/W2 收尾那一段的裁定）

| 主题 | 已定的内容 | 落在哪 |
|---|---|---|
| **契约 · 密钥掩码（A 案）** | OAuth 客户端密钥**只给掩码**：`clientSecret` → `clientSecretMasked` + `clientSecretSet`，与端点的 `apiKeyMasked` / `apiKeySet` 同一套口径；回写时省略 = 保留磁盘原值（把掩码当密钥存回去是另一类错） | W1-4 / W1-6；`McpOauthView`；`architecture.md` §3 |
| **契约 · 定位** | `message.list` 补 `around`（以某条为中心取一窗）—— **成本低就补**，不另开方法、不另做一套搜索接口 | W1-8；`AROUND_WINDOW` = 40；`architecture.md` A12 |
| **契约 · 减法** | `credential.*` 的 **wire 面删掉、能力留下**：凭证归宿主自己管（`CredentialService` + `agents-host token *`），客户端只有「连接管理 + 记住密码」 | W1-10；PRD L13 |
| **发布** | 先发 **alpha**（`@ai-zen/agents-host@0.1.0-alpha.1`，上游 `core@4.6.0-alpha.0` / `sdk@1.2.0-alpha.0` 同批），不发正式版 | W2 收尾（§4.4） |
| **命令名** | `/back` 为主名（`/revert` 退成别名）：用户说的是「回到那条消息之前」，命令名不必迁就契约方法名 | W2-6 |
| **搜索归属** | `/search` 从 CLI 删掉：**搜索归桌面端**（一个搜索框触发消息列表搜索，宿主给 `search.messages`，怎么搜由客户端定） | W2-6；PRD F-C6 |
| **`/ws` 的形状与启动策略** | 一条命令三个动作：**列 / 选 / 建**；启动时自动进入 —— 本机用「当前目录」这条糖，远端用「上次进入的那个」，都没有才进选择环节（远端**绝不**上送客户端路径） | W2-4；`cli/src/workspace.ts` |
| **配置坏了怎么办** | **恢复出厂**：`config.json` / `host.json` / `mcp.json` 读不成配置时用出厂配置顶上 **并写回磁盘**，坏的那份先留 `<文件名>.broken`，再落一条 warning 通知（说清是哪个文件）；不往上抛、也不在两边各折一次。**不包括**：项目侧与 `~/.agents` 各层（在用户仓库里，仍是看得见的 `broken`）、库里的 JSON 列（用户数据）。用户原话：「不要搞该死的复杂的兜底，坏的直接恢复出厂设置就行了」＋「你MCP配置恢复了，事后记一笔通知不就行了」 | PRD D32；SDK `ConfigManager` / 宿主 `readHostSettings()` |

### 8.3 仍待你裁定

| 编号 | 问题 | 现状事实（供你判断） | 我的建议 |
|---|---|---|---|
| Q3 | desktop 的类型检查要不要前置 `agents/packages/host/dist` 的构建 | 现状靠已存在的 dist，构建顺序没写进脚本 | 前置（一次显式依赖，胜过一条隐式约定） |
| Q4 | ~~PRD §1 里的出处名 `cli-old` 谁改~~ | **已清**：`PRD.md:3` 与 `:27` 现在都写 `cli-old-archive`（`:286` 的变更记录里保留当时的名字，那是历史） | — |
| Q5 | `.ai-zen/handoffs/**` 与 `.ai-zen/reviews/**` 里的旧包名要不要一起改 | 你明确说了不动 handoffs（「不假造过去」）；reviews 是同一性质的历史记录，我按同一把尺子处理了，所以 W3-2 的「文档层面清完」在这两处留有命中 | 不改（历史记录保留当时的名字）；如果要改，需要你改口径 |
| Q6 | ~~`cli/rolldown.config.mjs:51` 的注释仍写着旧包名~~ | **已清**：那份配置现在只说 `@ai-zen/agents-client` / `agents-sdk` / `agents-host` 该被内联，没有旧包名 | — |

---

## 9. 每波的验收标准（各波共用，不许减项）

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
| `agents/packages/host/docs/PRD.md` | 需求唯一来源（89 条能力 + 锁定决策 L / D） |
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
| `desktop/TODO.md` | 首启真 GUI 验收 5 条、凭据向导 5 条 → §6 第 4 档 | `git -C desktop show 1c6e777:TODO.md`（71 行；该文件在 `a5fe379` 被删掉，HEAD 里已经没有） |

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
