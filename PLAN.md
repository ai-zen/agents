# 宿主实施方案（PLAN）—— 结构、时序、落点、波次

> 本文件是 `packages/host` **怎么搭 / 先做什么 / 落在哪个文件的哪几行**的唯一来源：结构 `A##`、对象图与生命周期、投递与事件通道、落点表、波次 `W#`、欠账、变更记录。
> 需求与决策见 `PRD.md`（`F-##` / `L##` / `D##` / `R##`）。**一个事实只写一处**：需求在 PRD，结构与生灭时序在本文件；互相指路只写一行「见 PRD D28」。
> **core（引擎）的需求与机制见 `CORE.md`**；本文件只管宿主，不重复 core 的任何一条事实。
> 本文件里的 `A##` 编号被代码注释引用（如 `MessageRepository.ts` 的「A12 的 `message.list` 口径」），**不能改号、不能改含义**。

---

## 1. 目录与分层

单根 + 薄 service + 一层仓储，按需扩展，不预摆空层。不用模块级单例、不用反射扫描；依赖从根显式注入，跨服务协作（删对话 → 结束它那个 agent）用显式钩子声明，不靠事件总线兜。

```
app.ts        单根：组装、启动、退出
cli.ts        命令行：serve / token / version
config.ts     路径与端口来源
index.ts      包出口（wire 类型 + createHost）
wire/         契约：methods（方法表）、frames（帧）、errors（业务码）、events（事件）、states（状态形状）
net/          WsHub、auth、discovery、UploadReceiver
handlers/     方法实现（一域一文件）+ index（HandlerTable 与桥接名单）
services/     薄服务 + Logger（日志文件与轮转）
runtime/      ScopeRegistry、AgentRegistry、RunRegistry、ChatRunner、TransientRunner
storage/      Database、dbWorker、Repository、migrations
i18n/         文案（en 基准 / zh）
```

---

## 2. 结构决定（A1–A15）

| # | 定论 |
|---|---|
| A1 | 一个宿主进程装所有对话；对话之间不做进程隔离 |
| A2 | 一个监听器、一条 WebSocket，RPC / 推送 / 二进制上传都走它 |
| A3 | 契约归宿主自己（不独立成包、不叫「约定」），客户端照着用 |
| A4 | JSON-RPC 2.0 为底，产品形状长在 `params` / `result`；标准里对我们有负担的部分（批量请求、强制错误码空间、通知必须无 id）不用 |
| A5 | 所有连接都要凭证；本地无感靠「创建时凭证已自动填好」，不靠回环豁免 |
| A6 | 启动方式决定监听范围：本地实例只监听回环；对外实例由创建者起、自己配凭证并分发 |
| A7 | `node:sqlite` + worker 线程 + WAL；全文检索用 FTS5 `trigram` |
| A8 | 分层照桌面端：单根 + 薄 service + 一层仓储，按需扩展，不预摆空层 |
| A9 | **agent 常驻**：一段对话一个，活到显式退役 —— 它的 `messages` 就是这段对话的内存真相（装配一次，之后不读库、不重复 push）。**Scope 没有空闲回收**（见 PRD D28） |
| A10 | 「agent 该不该活着」的判据**只有一处**：`AgentRegistry` 的 `acquire` / `complete` / `discard` / `invalidate` / `disposeAll`，外加观察用的 `onLifecycle`；别处只报事件。没有任何空闲计时器 |
| A11 | 上传走同一条 WS 上的**二进制帧**（三段式），不用 base64 字符串 |
| A12 | `message.list` 有**两种按 id 的取法**：① `after=<id>`——该 id **存在**就返回它**最新的内容**及之后全部；**不存在**就返回全部（断线补拉与删除后重拉共用这一条）。② `around=<id>`——该 id 在本次可见集里就**以它为中心取一窗**（40 条，前后尽量均分，命中那条一定在里面）且 `anchor` 报成它；**不在**可见集里（已撤回 / 换过库 / 是 `hidden` 而这次没要）回**空页 + `anchor: null`**，**不报错**。两者同时给时 `around` 优先；`toolCallId` 决定读哪一段，两个定位参数都只在那一堆里生效 |
| A13 | ~~能力清单的粒度是「契约里每个方法一条」~~ **已废**（2026-11-14）：`host.capabilities`、`hello.capabilities` 与 `CapabilityView` 都删了，两端一个消费者都没有 |
| A14 | **平级会话只做三件事**：建一段会话、往任意会话投一条、问一段会话的状态。进程内记录只放**可读名**；**血缘是持久身份**（会话行上，给历史展示用），**投递不按血缘校验**；**状态不存**，问的时候现读 agent 那一格。**没有「跑完把结果投回去」这种东西** —— 会话间通信只有投递（PRD 4.6）。「谁在发」用 `WeakMap<agent, conversationId>` 记（只用来填来源标记），**不给 core 的 `Agent` 加字段** |
| A15 | **投递只有一个入口**（宿主 `ChatRunner.deliver`，core 侧是 `agent.push`）：塞进队列就完了，**回执只有「收下 / 被拒」**，不带状态、不带结果。**唤醒**（活着的 agent 被推起来）与**复活**（agent 不在、按库里历史重装）是两个词，不混用；**禁止等**（唯一例外是没有第二个触发方的一次性对话，PRD 4.3） |

---

## 3. 对象图

```
HostApp（根：组装、启动、退出）
├─ 基础设施
│  ├─ ConfigManager        (SDK) ← 配置唯一入口（basePath = 数据根）
│  ├─ Database             SQLite worker（all / get / run / tx / close）
│  ├─ *Repository          只做 SQL，不含业务（一表一文件）
│  ├─ i18n                 render / normalizeLanguage（en 基准、zh；未知语言回落 en）
│  └─ Logger               日志落 `logs/host.log`（按大小轮转）、warn / error 同时上通知
├─ 服务（一服务一文件，薄，共 16 个）
│  ├─ WorkspaceService、ConversationService、MessageService、AgentService
│  ├─ ModelService、ConfigService、AssetService、SearchService、CredentialService
│  ├─ CompletionService、DiscoveryService、HandoffService、NoticeService、QuestionService、AutoNaming
│  └─ PeerSessionService      平级会话：建一段会话、往任意会话投一条、问一段的状态（A14；不记状态、不回投）
├─ 运行时（有状态，比 service 更长寿）
│  ├─ ScopeRegistry            workspaceId → Scope：显式 create / get / refreshWorkspace / dispose / disposeAll / workspaceIds，无空闲计时
│  ├─ AgentRegistry            conversationId → 活着的 agent（agent 唯一的来源；常驻、跨轮复用；存活判据只在这里）
│  ├─ ChatRunner               会话 ⇄ agent 的桥：订事件照着写库、投递、中断、现读状态
│  └─ TransientRunner          一次性对话（不落库、不推流式事件，`runOnce` 跑到头）
├─ 接入
│  ├─ WsHub                连接集合、鉴权、语言、JSON-RPC 分发、推送缓冲
│  ├─ UploadReceiver       同一条 WS 上的二进制分帧落盘
│  ├─ auth / discovery     凭证校验、发现文件与本地凭证交付
│  └─ handlers/            方法实现（一域一文件）→ HandlerTable
```

**视图与入参的几处形状**（每条写「谁产生 → 客户端拿它做什么」）：

| 形状 | 谁产生 | 客户端拿它做什么 |
|---|---|---|
| `AgentView.messages` / `.function` | `AgentService.toView` 原样转出 SDK 的 `AgentDefinition["messages"]` / `["function"]`；读不出来时都是 `null`，非子 Agent 的 `function` 恒 `null` | 先看得到提示词与子 Agent 定义，才有可编辑的对象（PRD F-F5）；`agent.update` 收到的 `messages` 原样交回等于没改 |
| `DiscoveryEntryView` 的传输字段 + `extra` | `DiscoveryService.discover`：MCP 条目把「这条服务器怎么起的」整份摊开；`extra` 收留本版不认识的键 | 编辑屏不必凭 `id` 重建就能改；回写时 `extra` 逐字带回（PRD F-F6）。非 MCP 三类这几格恒为 `null` / 空对象 |
| `DiscoveryLayerView.scope` | 同上：MCP 5 层里只有 2 层非空 | 直接认「哪一层可写」，不再按 `editable` + `depth` 反推 |
| `McpOauthView` 的掩码 | `DiscoveryService` + `services/secretMask.ts` 的 `maskSecret` | 与 `EndpointView` 的 `apiKeyMasked` / `apiKeySet` 同一套；回写省略 = 保留磁盘原值 |
| `ModelInput.tokenThresholds` 可选 | `ModelService`：`create` 省略套出厂默认、`update` 省略不动 | 建模型不必自己抄两个数 |
| `ConversationSummary.state` / `.inboxPending` / `.agent` | `ConversationService.toSummary` + 端口 `state` / `describeAgent`；状态是**查询那一刻现读**的四格，不落库、不是字段 | 侧栏说得出「这段现在忙 / 闲 / 暂停 / 死、队里还压着几条」与助手可用性；状态栏八块由客户端现拼（PRD F-I6） |

---

## 4. 生命周期

**生灭都是显式的**：`Workspace ──1:1── Scope ──1:N── Agent` —— 到 agent 为止，没有第五个对象（「死」就是它不在）。

创建自上而下（`agents.acquire` 先向 `ScopeRegistry` 要 Scope，它是幂等 get-or-create，调用方不必背顺序）；回收自下而上（`scopes.dispose` 撞上还活着的 agent 就**拒绝**，抛 `ScopeBusyError` 带 `conversationIds`，不级联）。没有空闲计时、没有自动回收：活着就是有人显式持有它。

**存活策略只有一处（`AgentRegistry`）**：`acquire`（在且合用 → 复用；不在 → 装配；装配事实变了 → 丢掉重建）、`complete`（变闲那一刻看一眼：陈旧才退役）、`discard`（对话 / 项目被删：只丢引用）、`invalidate`（配置生效：空闲的当场退役、在跑的只打标记）、`disposeAll`（进程收尾）。每一步报一条 `onLifecycle`：`action` = `built` / `reused` / `rebuilt` / `retired`，`reason` 是**闭集**（`never-built` / `assembly-facts-unchanged` / `assembly-facts-changed` / `config-changed` / `stale-on-settle` / `conversation-deleted` / `shutdown`）——「这段对话为什么没有 agent」的唯一答案就在这条流里。`ChatRunner` 不再持有「一段现场」这种东西：它把监听订在 agent 上（订一次，活到 agent 退役），事件来一条处理一条。

**Scope 被销毁的两个原因（都是显式动作）**：① Workspace 被删（`dispose(workspaceId)`）；② 进程收尾（`disposeAll()`）。前者撞上还活着的 agent 会拒绝，调用方顺序是「先停会话 / 丢掉 agent，再销毁 Scope」；后者不拒绝。**配置改动不是销毁原因**：`refreshWorkspace(id)` 就地把配置重读一遍、各插件重新发现一轮（MCP 连接按新声明对账断开），实例还是同一个，正在干活的那个也不会被抽掉能力；刷完再对同一个 Workspace 调一次 `agents.invalidate`（PRD D34）。

**一段对话的诞生**（PRD R56 / F-D9）：`conversation.create` 只定身份并发一个 id，不写库；首次 `conversation.send` 时 `ConversationService.ensurePersisted` 才写行，**落行那一刻同时写这段对话的第一条消息**——一条 `role: user`、`hidden: true` 的 cwd 消息（正文由 `injectedContextOf` 拼）。它最先写，所以 `seq` 在真实用户消息之前；之后每轮都不再写、也不往用户消息里拼任何东西。cwd 取 `workspaces.cwd`，`workspaceId` 创建即定死。

**会话级模型与思考档位**（PRD L7 / R70–R72）：存在 `conversations.modelId` / `thinkingLevel` 上，改了就落库。装配 agent 时从这里取：`modelId` 直接给 SDK 的三级解析，`thinkingLevel` 按该模型引用的策略表展开成参数补丁、叠在助手定义的 `modelParams` 之上（同一模型才叠）。展开发生在 `ChatRunner.createSdkAgentFactory` 的 `conversationModelParams`，档位名本身不进请求；换模型时档位清空。服务层要的运行时接口因此只剩两件（`ConversationRuntimePort`）：**现在忙不忙**（现读 agent 那一格）与**删掉之后的中止**（`forget`）。

**进程退出**（PRD 1.7 / 4.12）：**只有三个原因** —— 用户显式关闭（命令 + 一次二次确认）、进程被外部杀掉、机器没了。**连接数不参与任何判断**：agent 常驻的意思就是「有没有客户端连着，跟它活不活无关」，所以既没有「最后一个客户端走了就收尾」，也没有「把手上的活干完再退」—— 不自动退出这件事把这两条一起取消了（`checkExit` 与其两个触发源作废）。

**显式关闭时的收尾顺序（`stop()`）**：摘发现文件 → 销毁 Scope → 断连接 → 清理上传 → 关库 → 关日志（先写最后一笔，再 flush 并关流，PRD F-J2）。同一次收尾还负责清掉升级自检的定时器。

---

## 5. 投递、变闲那一刻、事件通道

宿主与一段对话之间只有三个口：**投递**（往里塞）、**中断**（掐在途）、**观测**（读当下 + 收事件）。没有「开始一次运行」「结算一次运行」这种口 —— 那要先有边界，而边界不存在。

### 5.1 唯一的对外动作：投递

```
conversation.send / postMessage / 定时器 / 外部程序
 └─ ChatRunner.deliver(conversationId, { content, source, attachments? })
      ├─ 目标不存在              → 拒（not_found），错回给投递方那次调用
      ├─ 目标是死的（没有 agent）→ 拒（conversation_dead）；例外只有**创建者**：界面的
      │    发送按钮，以及「刚建出来那段会话的第一句」（create_session）—— 它们给 mayStart，
      │    于是先装配再投。别的来源一律叫不醒（PRD 1.2 / 4.2）
      └─ 活着                    → 入队（忙 / 闲 / 暂停一律收；暂停只收不取）
            ├─ agent 不在（首次装配）→ reconcile + resolveHistory 读库 → acquire → 历史装进去
            └─ agent 在             → 直接 push；它自己从闲变忙、自己取走
      回执：收下了（userMessageId + 每个附件最后怎么走的）／被拒。
```

**判据只有两条**：目标在不在、活不活。不判「有没有资格发给我」（投递不看关系，A14）；不判「它忙不忙」（忙不是拒绝的理由，队列本来就收）；不判「这条会不会被处理」（PRD 4.13 不承诺）。

**回执里没有状态、没有「叫醒了没有」、没有结果**：那三样都是对未来的断言，而未来只能靠观测。

**投递不等**。`await` 的边界就是「已入队」：读库、装配、push 都在这一条里做完，之后的事归 agent 自己。唯一允许等的是**一次性对话**（没有第二个触发方，PRD 4.3）—— 那里用 `runOnce` 跑到头。

**装配期间的投递**先收着，装好按到达顺序一次推给它 —— 不等待、没有超时、不丢。

**待办（队列）每一刻现读** `agent.inboxPending`，不存镜像：一份会与真队列分叉的副本没有存在的理由。

### 5.2 唯一的判断：变闲那一刻

agent 从忙落到闲的那一拍（core 的 `state:idle`）做一次**读当下事实**的判断 —— 整个宿主只有这一处「到点了要考虑点什么」：

1. 这段是不是派生会话？是 → 不问交接（它的自动交接开关在**创建时**写成「开」，自己压，PRD 4.5）。
2. 最后一次请求的 `prompt_tokens`（就在最后那条 assistant 消息上，不求这一批的和）有没有越过配置里的交接线？
3. 有没有已经挂着的题？
4. 三条都成立 → 问（`QuestionService.askHandoff`）。

四步全是**读**：没有「这次运行的结果」、没有产出清单、没有结局。答完之后的事归 `QuestionService`（一次性驱动者写文档、换记忆、旧记忆存成另一段会话）。

同一拍还有一件确定性的事：`AgentRegistry.complete`（配置改过才退役）。**不催退出** —— 宿主不因为没人连着而收尾（§4）。

**没有任何「跑完把结果投给谁」的动作**：会话间通信只有投递（PRD 4.6）。派生会话变闲时什么都不发。

### 5.3 交接：只在空闲时发起，靠「不落库」隔离

- **判据一条**：`handoff.start` 只在 `idle` 时跑；忙 / 暂停 / 没有 agent 一律拒（`busy`，`detail.reason = "not_idle"`）。不做「先 abort 再按住」，也不做「等变闲」「放行一手」。
- **没有 `suspend` / `resume` 编排**：交接期间它在干活（写文档），别人的话照收排队；记忆随后整个被替换，那些话留不下任何东西。待办积压由客户端 `/clear`（`conversation.clearInbox`）显式清。
- **隔离靠「交接态」**（`beginHandoff` / `endHandoff`）：这段在写文档期间产生的消息**不进库**（否则「关于交接的那场对话」会进转录、进历史、进条数），但 `message.added` / `message.delta` / `message.changed` **照常推** —— 用户得看得见它在写。
- **「写完了没有」看工具结果**：写文档那次工具调用的 `toolFinished` + 一次落盘校验（`MIN_HANDOFF_BYTES`）；两次都不成立 → 单向降级到独立交接，再不行就是失败通知。不看状态、不等 idle。
- **提交与回滚都推 `memory_replaced`**，客户端据此 `message.list` 全量整段替换，把那批只在内存里的写作痕迹清掉。断线重连的客户端天然看不到它们（库里没有）。

### 5.4 事件通道：三条粒度

宿主不统计、不推断，只把到达的事实按粒度送出去（落库走同一批事件）：

| 粒度 | 事件 | 载荷 | 谁在用 |
|---|---|---|---|
| 追加一条 | `message.added` | 完整消息对象（id / role / status / content / source / tool_calls…） | 客户端建槽；宿主写行 |
| 流式一片 | `message.delta` | core 的 `AgentNS.Delta` 原样 + `messageId` + 消息内 `seq` | 客户端跑同一个 `applyChunk` 增量 |
| 一圈收口 | `message.changed` | 完整消息对象（此刻的 status / tool_calls / finish_reason / usage 都在上面） | 客户端整条替换；宿主覆盖写行 |
| 事后改写 | `message.changed` / `message.removed` | 同上 ／ 被删的那条（中止、出错、`drop`、`omit`） | 同上 |
| 状态 | `state` | `{ conversationId, state }`，取值 `busy` / `idle` / `paused` / `dead`（**变了才发**） | 客户端自己那四格 |
| 出错 | `error` | core 的 `AgentError` 完整对象（`code` / `message` / `detail`）+ 它挂在哪条消息上 | 日志、排查、要技术细节的地方；**消息行里另存一份「回显用」的失败事实**（码 + 文案键 + 参数），活得比进程长（PRD 4.15） |

**不为字段变化单独发事件**：一条 delta 流 + 一圈收口一条整对象就够了。「status 从 writing 变 completed」不单独播 —— 收口那条整对象里带着它。**消息上的字段一律整条带**：`hidden` / `usage` / `tool_calls` / `omit` / 回显用的失败事实都不挑 —— `hidden` 只是客户端不显示，请求里照发。

**预填消息同样走 `message.added`**：core 每一圈开头追加的那条 `status: pending` 的 assistant 消息、工具结果、落地的用户消息、注入的 cwd / 交接摘要，都从 `append()` 那一个口广播。客户端先有槽，delta 才挂得上。

**宿主不做的事**（写在这里是为了不再长回来）：不算用量（每条消息自带 `usage`，客户端自己合计）、不算速率、不维护「请求中 / 思考中 / 输出中」这类阶段（客户端按事件到达自己推）、不报「这一段用了多少」（「这一段」不可定义）。

**落库 = 同一个镜子的另一份**：`message.added` / `message.changed` 到了就写那一行（边流边写只是节流，不是「提前写」），`message.removed` 到了就删。**没有「最后统一写一遍」**：那等于假设有一个终局。

## 6. 契约面

- **方法**：`<域>.<动作>`，共 **63** 条、13 个域（`src/wire/methods.ts` 的 `METHOD_NAMES`）。分域点数：`host` 6、`workspace` 5、`conversation` 14、`message` 1、`question` 2、`notice` 3、`config` 8、`agent` 8、`model` 8、`asset` 3、`completion` 1、`handoff` 2、`search` 2。
- **点数沿革**：65 → 63（W3：+`agent.restoreFactory`、+`config.saveMcp` / `config.deleteMcp`，−`host.usage`、−`credential.list/create/revoke`、−`config.patchMcps`）→ 62（删 `host.capabilities`）→ **63**（W6-E：+`conversation.clearInbox`，清空待办归客户端）。
- **`credential.*` 删的是契约面、不是能力**：`CredentialService`、`CredentialRepository`、`<数据根>/run/token`、`agents-host token create|list|revoke` 一字未动，`Credential*` 形状只留给那三个子命令。别因为 `grep credential.* wire/methods.ts` 找不到方法名就以为能力没了（PRD L13）。
- **桥接名单 4 条**（不在 handler 表里）：`host.hello`、`host.setLanguage`、`asset.begin`、`asset.end` 由 `WsHub` 自己处理，其余 **59** 条进注入的 `HandlerTable`。理由：凭证与语言是**连接状态**；上传要按 `connectionId` 分帧落盘、断线按连接清理。分发顺序是 `hello` → 未握手拒绝 → 已知方法名校验 → 连接级方法 → 上传方法 → handler 表；表里没有的名字回 `unsupported`（`detail.reason = handler_not_registered`）。`handlers/index.test.ts` 钉住「每个方法要么在表里、要么在桥接名单里，且两边不重叠」。
- **事件** 9 个：`message.added` / `message.delta` / `message.changed` / `message.removed` / `state` / `error` / `conversation.changed` / `notice` / `question`。前六个是客户端重建 `messages` 与那四格的全部原料（三条粒度见 §5.4），**宿主不在这之上再加聚合**：没有 `run.state`，没有 `usage`。
- **业务码** 13 个（`src/wire/errors.ts` 的 `BizCode`），数字码只做粗分类。
- **`message.list` 的取法**见 A12；`around` 的消费者只有桌面端（搜索命中定位），CLI 一阶段不消费。
- **`hello`**：`{ token, language?, clientInfo }`。凭证不放 URL 查询串（会进日志与进程表）；未握手的连接只放行 `hello`。成功时回协商出的 `language`、`hostVersion`、`protocolVersion`、`startedAt`、附件上限 `limits`（能力清单已删，不再回）。

---

## 7. 存储

`node:sqlite` 跑在 worker 线程里，主线程只发消息。`Database` 对外五个方法：`all` / `get` / `run` / `tx` / `close`；worker 侧开 `PRAGMA journal_mode=WAL` 与 `PRAGMA foreign_keys=ON`。

**`tx` 是声明式批次，不是「在事务里跑一段 JS」**：回调里的 `all` / `get` / `run` 只**登记**语句（拿到带下标的凭据），回调返回后整批一次性送进 worker：`BEGIN IMMEDIATE` → 按登记顺序逐条执行 → `COMMIT`，任一条失败整批 `ROLLBACK`，结果按凭据对回调用方。边界是**读到的值回不到 JS 里去决定下一条写什么**（要那样得让 worker 等主线程）；需要按读到的值分支的场合，把条件写进 SQL（PRD R19 / R31）。

**表骨架**（`storage/migrations.ts`，眼下到 v2）：`workspaces`（`cwd` 不可变且 `UNIQUE`，**没有** `updatedAt`）、`conversations`（`agentId` / `modelId` NOT NULL、`nameIsAuto`、`thinkingLevel` 可空、`compactedAt` / `compactionMode` 可空）、`messages`（`seq`、`status`、`omit`、`content`、`searchText`、`parentToolCallId`）、`assets`（`sha256` 全局 UNIQUE + 宽高，**不记归属**）、`conversation_assets`（关系行，`assetId` 为 `ON DELETE RESTRICT`）、`asset_vendor_files`（厂商 `file_id` 缓存）、`notices`（`code` + `params` + `durationMs`）、`questions`、`credentials`、`meta` + FTS5 虚表 `messages_fts`（`tokenize='trigram'`，三触发器同步）。

**素材分三层**：`assets` 是**唯一真相**（一份字节 + 摘要 + 尺寸，`sha256` 全库唯一）；`conversation_assets` 是**谁引用了它**（归属、「几张会话引用了它」、还能不能删字节都问这张）；`asset_vendor_files` 是**缓存**（这个端点上有就直接用、换端点内联 base64、都没有才上传一次；失败就报失败，不重试 / 不判失效 / 不过期清理）。撤回 / 删对话 / 删项目由外键级联删关系行，没有谁去减计数；素材行与磁盘文件在**消息清理完之后**按引用数判：为 0 才删行再删文件（`AssetService.sweepUnreferenced`）。

**`message.list` 的读法：内存优先，死了才读库。** 这段有 agent 就从它的 `messages` 现读投影（顺序就是数组顺序，不再排 `seq`；`after` / `around` / `includeHidden` 都在数组上算），没有 agent 才读数据库 —— 这是 `A12` 那套取法在两个来源上的同一个实现。**没有「交接态」这一档例外**：交接期间也读内存，于是「它正在写的那几条」照样看得见（客户端中途连上也能一次拉全，不需要靠丢弃增量来对齐）。提交或回滚之后推一条 `memory_replaced`，客户端整段重拉即可。

**子 Agent 那一栏同样是内存**：子 agent 的消息在它自己那个对象里，顺「父 agent 的登记 → 那一个子 agent → 它的 `messages`」取（`message.list { toolCallId }`）。**子 agent 不入库**，所以父一死、进程一重启，名册与那些消息一起没了 —— 见 `CORE.md` §17。整个列表读取因此**只有一个来源**：活着读内存，死了读库。

**读路径上什么都不许写**：不补、不删、不修 —— 修复只在装配那一刻（`reconcile`）做。

**消息条数的两个口径**（加减关系，不是各自一套）：`listByConversation` 数**主线**（`parentToolCallId IS NULL`，侧栏摘要 / `message.list` 都从它算）＝ `countByConversation` 数全部行减去子 Agent 那一半（删除代价用后者）。子 Agent 的话按 `listByParentToolCallId` 单独取（`message.list { toolCallId }`）。三者对 `hidden` 的口径一致：默认都不算，要就显式传 `includeHidden`。

**全文检索**：`messages_fts` 是挂在 `messages` 上的外部内容表，只索引 `searchText`。两条实测约束：`unicode61` 下整段中文是一个 token（用错就搜不到）；`trigram` 的查询词至少 3 个字符，少于 3 个时 `MessageRepository.search` 走 `LIKE` 子串。

**边流边写**：运行时以内存里的消息为真相，同一条消息行按节流 upsert，所以 `status` / `omit` 必须落盘。**崩溃恢复不归宿主**：装载时它只负责把库里的行读出来交给 agent，修不修、怎么修由 core 在进圈开头自己收拾（见 `CORE.md` §6）。**排队落地的用户消息是唯一例外**：落地那一刻就写第一笔（§5.4）。

**迁移**：`meta.schemaVersion` + 顺序迁移脚本，启动时逐级在事务里跑；不识别任何旧数据（PRD L1）。R14 / R18 这类结构裁定直接落在 v1 建表语句里（这套表结构还没随版本发出去）。**v2 是第一条真正的追补条目**：只用 `ALTER TABLE conversations ADD COLUMN` 加两列，v1 建表语句一个字不改 —— 已升过 v1 的库不会重跑旧条目，改旧条目会让两台机器的表结构悄悄分叉。

---

## 8. 接线：一条 WS 上的 JSON-RPC

**首帧 `hello`** 之后，语言挂在连接上、断开即忘；没带时用 `config.json` 的 `language`（PRD D8 / R58）。推送是 JSON-RPC 通知（无 id）：事件名放帧的 `method`，载荷直接放 `params`。

**「事件早于回包」的缓冲**（PRD R47）：`WsHub` 按请求参数里的 `conversationId` 先挂起该对话的推送，回包写完再按序放行 —— 代价是 `message.list`、`conversation.abort` 这类同对话请求也会短暂缓冲同对话事件（认这个口径：按对话挂起比按方法枚举更简单，也不漏分支）。

**多语言渲染点**：入库存「码 + 参数」（PRD §8），出网前按**这条连接的语言**重渲染 —— 事件走注入的 `localizeEvent`（`NoticeService.createEventLocalizer`，覆盖 `notice` 与 `question` 两类）；handler 的出参走 `context.connection.language`。

**上传**：三段式 —— `asset.begin`（JSON，返回 `uploadId` 或「已经有了」）→ 若干二进制帧 → `asset.end`（校验总长与摘要后落定成正式素材）。`begin` 带 `sha256` 时先问「库里是不是已经有这份字节」：命中就回 `{ deduped: true, uploadId: null, asset }`，不建临时文件、不分配 `uploadId`；去重是全局的（按摘要，不分对话）。单张 20MB 上限，超限在 `begin` 就拒；中途断开按 `begin` 记的临时文件清理。二进制帧格式见 PRD §4（`encodeChunkFrame` / `decodeChunkFrame` 是唯一一份实现，客户端复用）。

**取回**：`asset.get { assetId, variant? }` 回 base64；客户端按「段上有没有 `__asset_id`」决定要不要走这条路，不解析任何 url scheme。

**数据根**（`AI_ZEN_DIR`，缺省 `~/.ai-zen`，可被环境变量改）。`HostPaths`（`config.ts`）给出库、附件、运行期目录、发现文件、凭证文件、两份配置文件与日志目录；`config.json` 交给 SDK 的 `ConfigManager`，`host.json` 是宿主自己的设置（端口那一档）；`agents/ sub-agents/ skills/ tools/ mcp-oauth/` 与 `mcp.json`、`reasoning-presets.json` 由 `ConfigManager` 在其 `basePath`（= 数据根）下推导与释放：

```
<数据根>/
├── ai-zen.db              全机一个库
├── assets/                上传临时文件与正式素材
├── config.json            配置唯一真相（ConfigManager 以它为边界）
├── host.json              宿主自己的设置（端口那一档）
├── logs/                  host.log + 轮转出的 .1…
├── reasoning-presets.json 思考策略表（ConfigManager）
├── mcp.json               用户级 MCP 配置（ConfigManager）
├── agents/  sub-agents/  skills/  tools/  mcp-oauth/   由 ConfigManager 推导
└── run/
    ├── host.json          发现文件
    └── token              本地凭证交付文件
```

**单实例与发现文件**：`<数据根>/run/host.json` 是「这台机器上谁在服务」的唯一真相（pid / host / port / version / local / startedAt）。启动时 `detectRunningInstance` 读它：pid 活着就挂靠那个地址、不重复监听；pid 已死或文件坏了就清掉再起。客户端探活也读它。

**端口**（PRD D25 / R67）：优先级 启动参数 > `<数据根>/host.json` > 默认 8790；落点是 `config.ts` 的 `resolveListenTarget`。`--port 0` 只在启动参数那一档放行（「让系统分配」在配置文件里说不清）；显式给出但非法的端口报 `config_invalid`；端口被占用时 `WsHub.listen` 把错误抛给启动流程，进程失败退出 —— 自动改监听端口的路径没有实现。

**凭证交付**：凭证自身一份真相在库里；`<数据根>/run/token` 只是交付口（内容只有本地那串），对外实例不写它。文件权限尽力而为设成 `0600`（Windows 上 `mode` / `chmod` 不改 ACL），文档与文案都不把它当安全保证。

**升级**：`host.upgrade` 比磁盘版本与运行版本，确认新版本真的落盘才安排一次收尾，进程退出后由启动方式重新拉起；不自装包、不 re-exec。启动后还有一道低频自检（30s、`unref`）比一次磁盘版本（R66）；回退不算升级。

---

## 9. SDK 边界

| 归谁 | 内容 |
|---|---|
| `@ai-zen/agents-core` | `Agent`、流式 `applyChunk`、消息与工具调用结构（`Message` / `MessageContent` / `ToolCall` / `Delta` / `Usage`）、中止修复（`reconcileAbortedToolRounds` / `reconcileAbortedMessages`）。**它自己要保证什么见 `CORE.md`**，本表只划归属 |
| `@ai-zen/agents-sdk` | `Scope`（能力装配）、`allInOne` 五类插件（内置工具 / 用户工具 / Skill / MCP / 子 Agent）、`PeerSessionsScopePlugin`、`ConfigManager`、`createAgent` / `SdkAgent`、`HandoffService`、各插件的 `discover*`、出厂 Skill 与思考策略表、`fileToContentSection` |
| `@ai-zen/agents-client` | 「确保有一个能连的宿主」：`ensureHost`（有就上、没有就拉）、`spawnHostViaNpx`、`Client`（连接 / 调用 / 事件分派 / 补拉 / 重连）、`settings`、`resume`、`upload`。它不知道自己被谁用，也不画任何界面 |
| 宿主 | 进程与接线、凭证、Workspace 与对话的生命周期、Scope 的持有与回收、持久化、i18n 文案、通知与问题对象、上传 |

**原则**：**agent 循环不重写**，宿主只做「装配 + 持久化 + 接线」。

**SDK 的三条仍然成立的结论**（其余旧分层、旧管线、旧示例一律不搬）：

1. **SDK 是引擎层，不是应用层**：它持有能力管线（发现 → 过滤 → 实例化）、提供 `Scope` 编排容器与 Agent 组装；会话持久化、界面与交互、进程生命周期都**不在** SDK 里。SDK 面向模型与用户的文案是固定英文（engine 层不做 i18n），多语言归宿主（PRD D8）。
2. **能力装配三阶段**（`Scope` 编排、各插件落实现）：
   - 阶段 1 **发现**：`init()` / `refresh()` 遍历 `plugin.discover(scope)`，**发现结果插件自持**，不汇总到 `Scope`；
   - 阶段 2 **过滤**：`filter(definition)` 汇总各插件 `candidates()` 的四维候选名 → 应用 `exclude`（优先级高于权限）→ 四维权限过滤；
   - 阶段 3 **实例化**：`instantiate(filtered)` 遍历各插件产出工具实例，后注册覆盖先注册。
   三条硬性质：**候选 ≠ 实例**（`candidates()` 只报名称，是否注册由 `instantiate()` 定）；**可用性判断内聚在插件**（产出该工具的插件自己判 `isAvailable`）；`candidates` / `instantiate` 同步、`discover` / `dispose` 可异步。
3. **能力从端口注入，SDK 不依赖宿主**：插件只认端口接口，不认宿主的服务。范例是 `PeerSessionsScopePlugin` —— 构造时给 `PeerSessionPort`，**不给端口就什么都不产出**（`candidates()` 回空、`instantiate()` 回空数组），于是只有 `Scope` 的库使用者看到的能力面一个字都不变。会话是宿主的财产（id、落库、模型解析、投递、状态现读全在那边），端口是唯一的一处接线，分层因此不用破例。
   同理：`Scope` 实例创建后 `config / cwd / agentsDir` 不变，`refresh()` 只让插件重新发现能力，**不重建 Scope、也不重建插件实例**（PRD D34 的 SDK 侧依据）；内置工具以 `ToolEnv.cwd` 为相对路径基准，不依赖全局 `process.cwd()`，多个 Scope 才能并行服务不同目录。

---

## 10. 落点表

> 格式：`文件:行区间` + 一句话。行号取自本文件落笔时的 HEAD（`abea82a`），代码若大幅变动以符号名为准。

### 10.1 投递与事件

| 条 | 落点 | 一句话 |
|---|---|---|
| 投递入口 | `ChatRunner.deliver` | 判两件（目标在不在、活不活）→ 入队；回执只有收下 / 被拒 |
| 装配期缓冲 | `TurnSession.pending`（并进常驻桥） | agent 还没就位时先收着，装好按到达顺序一次推 —— 不等待、没有超时 |
| 取件点 | `packages/core/src/Agent.ts`（`runLoops()` 内循环末）+ `Inbox.ts` | `high` 先取、`!needContinue` 才问 `low`；落地成 `Message.User` 并加来源注释 |
| 落地即写库 | `ChatRunner.ts:1804-1821` | `persistLandedQueued`：先写行再 `linkQueuedAssets`，`createdAt` 取落地时刻 |
| 来源注释 | `ChatRunner.ts:625-633` | `withSourceNote` 是唯一入口，拼装归 core 的 `inboxEntryContent` |
| 待办回显 | `agent.inboxPending` → `wire/states.ts` 的 `InboxItem` | 现读，不存镜像；条数取证 |
| 状态四格 | `AgentRegistry.get(id)?.state` | 忙 / 闲 / 暂停；查不到 = 死。不落库、不是字段、不推算 |
| 变闲那一刻 | `ChatRunner.onAgentState`（`state:idle`）→ `app` 的那一个判断 | 全宿主唯一一处：派生会话？越软线？挂着题？→ 问 |
| 历史只有一份 | `ChatRunner.run()` 的二分 + `attach` | 有 agent 就从它内存里取，首次装配才读库 |

**旧形状已全部拆掉**（W2 落地）：`run` / `enqueue` 两条受理路合成 `deliver`、助手占位行没了、`DeliveryOutcome` / `settle()` / `TurnSettledFacts` / `RunState` / `run.state` / `usage` / `RunRegistry` 全都不存在。`ConversationBridge` 是这一段对话的常驻桥（订在 agent 上，`retired` / `killed` 才灭）。

### 10.2 平级会话

| 条 | 落点 | 一句话 |
|---|---|---|
| 建（F-C16） | `packages/host/src/services/PeerSessionService.ts:286-373` | 建会话 → `ensurePersisted` → 投第一条 → 立刻回 `{ sessionId, label }`（不等结果） |
| 认人 | `PeerSessionService.ts:256-258` | `bind(agent, conversationId)` 记一笔 `WeakMap`：只用来填来源名，不参与判断 |
| 模型解析失败的识别 | `PeerSessionService.ts:636-647`（调用点 `:328`） | 只看码不看文案，于是「拿不到模型」是结构化拒绝而不是抛错 |
| 问（F-C17） | `PeerSessionService.ts:381-392` | 现读 agent 那一格 + ~300 字摘要，**不给全量消息** |
| 发一句（F-C20） | `PeerSessionService.ts:538-551` | 一次投递；**不校验血缘**，回执只有收下 / 被拒 |
| 工具面 | `packages/sdk/src/scope/plugins/peers/peerSessionTools.ts`、`PeerSessionsScopePlugin.ts:22-45` | 形状与用例归 SDK；宿主实现端口，**SDK 不依赖 host**。发话的工具就叫 `postMessage`（`send_to_session` 已删） |
| 不问交接 | `app` 的变闲判断 | 看的是「派生会话」这一格（创建时写进会话行），**不看来源** |

**旧形状已全部拆掉**（W3）：`settleTurn`（回投）、`onTurnStart`（记录复位）、`resultDelivered`、`rejectionOf`（血缘拒绝）都不存在；记录里只有 `sessionId` / `parentConversationId` / `label` / `depth` / `startedAt`，状态一律现读。并发限额保留，判据是现读 `busy`。

### 10.3 Scope / Agent / 配置生效 / 退出

| 条 | 落点 | 一句话 |
|---|---|---|
| Scope 公开面 | `packages/host/src/runtime/ScopeRegistry.ts:174-192`（create / get / workspaceIds）、`:219-236`（refreshWorkspace）、`:246-267`（dispose / disposeAll） | 只有这六个方法；没有任何空闲计时 |
| Scope 拒绝级联 | `ScopeRegistry.ts:110-123` | `ScopeBusyError` 带 `conversationIds`，撞上活着的 agent 只拒绝 |
| agent 存活策略 | `packages/host/src/runtime/AgentRegistry.ts:243-350` | `acquire` / `complete` / `discard` / `invalidate` / `disposeAll` + 两个只读观测口 |
| 生命周期理由闭集 | `AgentRegistry.ts:109-117` | `AgentLifecycleReason` 的七个取值；`onLifecycle` 只是观察 |
| 配置就地刷新 | `app.ts:1335-1360`（`refreshScopesFor`）、`:1309-1320`（`createApplyPort`）、`packages/sdk/src/scope/Scope.ts` 的 `refresh` | 刷已存在的 Scope + `invalidate`，**不拆任何 Scope** |
| 关闭宿主 | `app.ts:862-905`（`doStop`） | 只有显式关闭这一条路（`host.shutdown` 命令 + 二次确认）；收尾把 Scope 与 MCP 一起拆。`checkExit` / 连接数回调那两个入口**作废** |
| 压缩归一（F-D11） | `storage/migrations.ts:206-223`、`ChatRunner.ts:3220-3232`、`app.ts:1110-1115`、`services/HandoffService.ts:460-467` | 派生会话自己压（`auto`）；用户会话在变闲那一刻问；只产文档不记 `manual` |

### 10.4 服务与存储

| 条 | 落点 | 一句话 |
|---|---|---|
| 会话草稿落库 | `packages/host/src/services/ConversationService.ts:409-430` | `ensurePersisted`：写行 + 那条 hidden 的 cwd 消息，并发去重 |
| 运行时端口 | `ConversationService.ts:93-109` | 忙不忙（现读 agent）/ `forget` |
| 侧栏摘要 | `ConversationService.ts:766`（`toSummary`） | 主线条数 + 四格状态读数 + 待办条数 + 助手可用性 |
| `message.list` 的 `around` | `packages/host/src/services/MessageService.ts:337`（`AROUND_WINDOW = 40`）、`:388`（`list`） | 命中不在可见集就回空页 + `anchor: null`，不报错 |
| 三个条数口径 | `MessageRepository.ts:238` / `:295` / `:408` | 主线 / 子 Agent 一半 / 全部行，三者加减 |
| 搜索下界 | `MessageRepository.ts:318` | `< 3 字符`退化 `LIKE`；`total` 是下界 |
| 素材落定与清理 | `services/AssetService.ts:242`（`finalizeUpload`）、`:309`（`linkMessageAssets`）、`:420`（`resolveHistory`）、`:669`（`sweepUnreferenced`） | 归一真相 / 记关系 / 按当时模型还原 / 归零才删 |
| 声明式批次 | `storage/Database.ts:162` | `tx` 只登记语句，整批在一条 worker 消息里执行 |
| 迁移 v2 | `storage/migrations.ts:206-223` | 只 `ADD COLUMN`，v1 建表语句不改 |

### 10.5 接线

| 条 | 落点 | 一句话 |
|---|---|---|
| 桥接名单 | `packages/host/src/handlers/index.ts:76` | 4 条连接级方法不进 handler 表 |
| 推送缓冲与语言 | `packages/host/src/net/WsHub.ts:146`（`localizeEvent`）、`:349-361`（推送前重渲染；连接数变化只用于观测，不参与任何收尾判断） | 按 `conversationId` 挂起，回包写完放行 |
| 二进制帧 | `packages/host/src/net/UploadReceiver.ts:483` / `:498`、`:329`（`abortConnection`） | 编码只有一份，断线按连接清理 |
| 路径与端口 | `packages/host/src/config.ts:21`（`HostPaths`）、`:146`（`resolveListenTarget`）、`:214`（`readHostSettings`） | 数据根只有一个来源；端口三档 |

---

## 11. 波次

| 波 | 目标 | 状态 |
|---|---|---|
| **W1 契约补齐** | 用户裁定的契约面 12 条落进 `wire`（`AgentView.messages/function`、`agent.restoreFactory`、`setThinking(null)`、MCP 传输字段与 `extra`、`saveMcp`/`deleteMcp`、`DiscoveryLayerView.scope`、阈值可选、`message.list(around)`、删 `host.usage` 与 `credential.*` 的 wire 面、保留 `upgrade`/`shutdown`、图片模型不补恢复出厂） | ✅ 完成 |
| **W2 CLI 收口** | `npx` 现下现起 + 下载屏 + `/ws` + `/shutdown` + 命令集增删；同批发 `agents-host@0.1.0-alpha.1` | ✅ 完成 |
| **W3 归档与文档** | `cli-old` 降级为只读归档、旧包名清干净、文档跟上新契约 | ✅ 完成 |
| **W4 桌面端完整问答视图** | 问答面板 → 完整视图 → 22 项零入口 → 体验欠账；真 GUI 竖切六步（连上 / 流式 / 作答交接问题 / 撤回 / 搜索命中并定位 / 置顶） | ⬜ 未开始（优先级最低） |
| **W5 兜底治理** | `retry` / `fallback` / `catch` 密集文件逐文件清；判据是**必要性**（不是「能删就删」）：不可能发生的条件删掉、真实会发生的坏输入与外部失败留着并写清「谁会走到」 | 第一遍完成；第二遍只在有新证据时做 |
| **W6 运行期可输入与重开回看** | 跑中发送进 inbox、`queued` 回包、排队数进运行状态、重开后子代理页签、会话列表带运行状态；客户端侧运行中输入与 `/sessions` | ✅ 完成 |
| **W7 平级会话阶段 1** | `create_session` / `read_session_status`、建完即回（其中「结果投回并唤醒发起者」已被 PRD 4.6 判死，见 §14） | ✅ 完成（回投那半已废） |
| **W8 agent 常驻与投递收口** | agent 常驻跨轮复用、Scope 去空闲回收、配置改成就地刷新、投递收敛成一个入口、平级会话进阶段 2 | ✅ 完成 |
| **W9 文档收敛** | 四份 docs + SDK 设计文档 + 四份计划草稿收敛成仓根 `PRD.md` + `PLAN.md`；`R1–R79` 补回 PRD；7 处代码注释与 8 处链接改指新文档 | ✅ 完成（本轮） |

**并行规则**：同波次里两个 agent 的目录不重叠才能同时派；跨目录要改别人的文件先报。

---

## 12. 欠账清单

| 欠账 | 现状 |
|---|---|
| 子 Agent 消息回看（PRD F-I7） | **不是欠账，是结论**：子 agent 的消息不入库（`CORE.md` §17），`message.list { toolCallId }` 走内存（`ChatRunner.messagesOf`）；库里那条 `parentToolCallId` 只服务旧行 |
| 客户端自造问题 | 契约只有 `question.list` / `question.answer`；问题由宿主内部产生（交接线 / 二次确认）。集成用例因此绕开契约直开库造一行 |
| 平级会话阶段 3 | 超时与 `abort`、`/sessions` 的「agent 建的」标记、`peer_sessions` 表与跨重启的孤儿 —— 都还没有。**「补投」不再是欠账**：回投这件事本身作废（PRD 4.6：通信只有投递） |
| **inbox 未消费部分的持久化与恢复**（待做） | **要实时，不攒批**：`messages` 逐条 upsert/delete；`inbox` 挂三条事件 —— `inboxAdded` 插行、`inboxTaken` 删行（core 已补，排在落地之后）、`inboxCleared` 清空。**读的一半已就绪**（`agent.inboxPending`，用于对账重读：事件丢了也不致命）。**写的那一半一件都没有**：宿主没落这两样，core 也还没有「原样放回」的口子（`restore`，不能走 `push` —— 它会重写 `createdAt`）。恢复：`messages` 读回即真相；inbox 行读回后放回队列，**按 `messageId` 去重**（已在 `messages` 里的扔掉）。机制与理由见 `CORE.md` §3「未消费的条目要能存下来再放回去」。 |
| 桌面端问答视图（W4） | `question.*` 在 `desktop/packages/main` 已接上（`chat.questions` / `chat.answerQuestion`），但整块视图、22 项零入口与真 GUI 竖切都未做 |
| **desktop 未跟改（另一个仓）** | `desktop/packages/{main,shared,render}` 都 `link:` 本地 agents 包，但 `shared` / `render` 还把 `@ai-zen/agents-core` 钉在 `^4.1.0` —— 与 `5.0.0-alpha.0` 对不上，会在他俩的树里落两份 core。它读的 `InboxItem.source` 也已是判别结构。本仓没装 desktop 的依赖（那边连 `tsc` 都没有），所以**行级影响未核实**；动它要装 electron 那一套，属于另一个 workspace。 |
| 6 条「有方法、没入口」的契约面 | `config.patch` / `getDiscovery` / `saveMcp` / `deleteMcp`、`agent.*`（6 条）、`model.*`（7 条）、`completion.files`、`notice.*`（3 条）、`conversation.state.statusBlocks`（已删）等在两端都没有完整消费面；删或留按 PRD §4 的判据逐条定 |
| 兜底治理第二遍 | 只做了契约面与一轮文件清扫；`retry` / `fallback` / `catch` 密集文件还有未过一遍的 |
| 「该说而没说」的提示 | 宿主词典里那批零产出文案已删，但它们对应的提示本身仍是需求缺口（PRD Q11）：删对话 / 删工作区之后确认一句、撞硬线、撤回之后、子 Agent 结束、附件超限…… |
| `desktop` 的构建前提 | 类型检查依赖 `agents/packages/host/dist` 已构建，构建顺序没写进脚本（PRD Q12） |
| 测试规模的口径 | 默认套件是一个文件一个库 + 一次 `tx` 清表；新增碰库的用例照这个形状写，否则单条用例要付 55ms 的建库钱 |

---

## 13. 验收与门禁

每条都跑，不许减项：

1. `npm run pretest`（`tsc --noEmit -p tsconfig.test.json`）零错误。
2. `./node_modules/.bin/vitest run` 全绿；**失败不许用 `.skip` 换绿**，要么修好要么删掉并说明。当前基线：**906 passed / 59 文件**。
3. 真进程竖切跑通（不是只有单测绿）：`npm run test:e2e` 的两条真子进程 + 真 WebSocket 用例。
4. **不必要性审查**：新增的每个可选入参、可空返回、防御分支，都要答得出「哪个客户端的哪一行会走到」；答不出来就删。
5. 文档同步：改了行为就改 `PRD.md` / `PLAN.md` 的对应条目，不许文档落后于代码。
6. 测试安放：一个事实只在一处断言（表结构归 `migrations.test.ts`、`tx` 边界归 `Database.test.ts`、契约语义归 `*Service.test.ts`、SQL 独有行为归 `*Repository.test.ts`、接线归 `WsHub.test.ts`、真进程归 e2e）。同一件事在两层都断言，删掉弱的那一份。
7. 删用例的判据是必要性：生产代码零调用者的方法连用例一起删（留着给假安全覆盖）；被测对象根本拿不到的依赖不要摆进夹具。
8. 不自己 commit（用户的规矩）；要提交时用中文 conventional commits，正文写「改前 / 改后 / 为什么」。

---

## 14. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-12 | 初稿：定 A1–A10；进程与接线、对象图、生命周期、存储、接线、事件形状、SDK 边界 |
| 2026-11-12 | 上传定为二进制帧（A11）；§9 待拍板只剩一条 |
| 2026-11-12 | `message.list` 取法定下（A12）：按 id 取、含自身最新内容、id 不存在则全量；§9 清空 |
| 2026-11-12 | 按实现复核（W5-B）：回调名改 `onAllRecycled`；补桥接名单与二进制帧格式；推送的事件名在 `method`；表骨架按实际列重写；`tx` 的声明式批次边界写清；方法表 63 个 / 事件 6 个 / 能力清单粒度（A13）落文；数据根目录树按 `ConfigManager` 实际推导；新增 §9 已知缺口，原 §9/§10 顺延 |
| 2026-11-12 | W6-B 运维与展示面：方法表 63 → 64（`host.reload` 进表，A13 的能力条数同步）；§6/§7 改正「`hello` 回完整清单」为**只回能力 id 列表**（R57）；§2 端口那一档补真实来源 `<数据根>/host.json` 与「显式非法端口报 `config_invalid`」（R67）、补升级自检（R66）、数据根目录树与 §5 补 `host.json` 与 `logs/`（F-J2）、§3 的日志口子由 `HubLogger` 改为 `Logger`、§4 补收尾顺序；§9 已知缺口按本轮实现改写（状态栏块、日志、端口三条出列，补助手名字与 `DefaultSelection.language` 两条） |
| 2026-11-12 | W6-C 补齐两条已知缺口：`DefaultSelection.language` 进契约（§9 那条出列）、状态栏助手块的名字与可用性由 `AgentService.describe` 现读（§9 那条出列）；§5 存储表下方补「消息条数的两个口径」（`listByConversation` 主线 / `countByConversation` 全部行，侧栏 vs 删除代价） |
| 2026-11-12 | W7-A：cwd 注入改成**会话创建时一条独立的 `hidden` 消息**（PRD F-D9 改口径），每轮不再往用户消息末尾拼注入段；§4 补「一段对话的诞生」与 `hidden` 的含义，§5 两个条数口径都改成不含 `hidden`，§6 `message.list` 加 `includeHidden?`，§7 `conversation.changed.messageCount` 注明不含 `hidden` |
| 2026-11-12 | W7-C：模型与思考档位改成**会话级、持久化**（PRD L7 / F-B4 / F-B6）：§5 `conversations` 加 `thinkingLevel`（可空）且 `modelId` 变成可改；§4 补「一段对话的模型与档位存在会话行上」与装配口径（档位名 → 参数补丁在 `ChatRunner.createSdkAgentFactory` 展开）；§3 删掉 `ConversationStateRegistry`（进程内临时覆盖作废），服务层要的运行时接口只剩 `isRunning` / `forget` |
| 2026-11-13 | W10：资源表与厂商关联表。`assets` 补 `sha256`（`NOT NULL`）+ `width`/`height`（可空）+ `UNIQUE(conversationId, sha256)`（对话内去重）；新增可失效缓存表 `asset_vendor_files`（`UNIQUE(assetId, endpointId)`、索引 `lastUsedAt`、级联删）。消息里持久化的只有 `asset://<assetId>`，发送前由 `AssetService.resolveHistory` 按当前模型还原；厂商 `file_id` 由 `upload` 注入点查表/写表（命中零上传），失效时按「这段对话 + 这个端点」作废并由 `ChatRunner` 重试一次。新增方法 `asset.get`（65 个方法；走 JSON + base64 回包，不进桥接名单）；§5 补两张表的分工，§6 补去重与取回。 |
| 2026-11-13 | W12：素材层删简。`asset_vendor_files` 去掉 `lastUsedAt` 列与它的索引（不做过期清理），缓存只剩三条规则（命中复用 / 换端点内联 / 首传写回）；删掉 `AssetService.invalidateVendorFiles`、`AssetRepository.listVendorFiles` / `deleteVendorFiles` / `deleteVendorFile` / `touchVendorFile`，以及 `ChatRunner` 里「file 不存在/无效」的文本判据、`retryAfterVendorFileError` / `resetForRetry` / 整轮重备的那一套。§5 按新口径回改；`stripLocalExtensions` 换成 core 的 `formatContent`（W12 同时给 core 加了 `formatContent` / `formatContentSection`，`formatHistory` 走它们）。 |
| 2026-11-13 | W11：引用方式改成**内容段上的本地扩展字段 `__asset_id`**（不再往 `image_url.url` / `file.file_id` 里塞 `asset://`）。`assets` 去掉 `conversationId` / `messageId` 两列，`sha256` 改成全局 `UNIQUE`（去重从「对话内」改成「全局」）；新增关系表 `conversation_assets`（`UNIQUE(messageId, assetId)`、`assetId` 为 `ON DELETE RESTRICT`、索引 `assetId` / `conversationId`），消息落库那一刻扫 `content` 里的 `__asset_id` 写行，撤回 / 删对话由外键级联删行，删完之后 `COUNT(*)` 归零才删素材行与文件（`AssetService.sweepUnreferenced`）。「所有 `__` 开头的字段都是本地扩展、发送前一概剥离」落成 `wire/states.ts` 的两个纯函数 `stripLocalExtensions` / `localAssetIdOf`，`resolveHistory` 出的每一段都过白名单，且同一 `(素材, 端点)` 两轮算出来的段逐字节相同。客户端加 `localAssetIdOf` / `getSectionAsset`（按扩展字段取字节，不解析 scheme）。§5 补第三张表与「归零才删」的落点，§6 补全局去重与取回口径。 |
| 2026-11-13 | W14-A：素材尺寸（裁定 R76）。`assets.width` / `height` 不再恒空 —— `AssetService.finalizeUpload` 把临时文件改名成正式文件之后读一次文件头，由 `src/services/imageSize.ts` 的 `readImageSize`（纯函数，零依赖）从 PNG 的 IHDR 块 / JPEG 的 SOF 段解出宽高写进这一行；其它格式、截断文件、解不出来的字节都写 `NULL`，不重试、不告警。`AssetRef` 与 `asset.get` 回的就是这一行，所以客户端拿到的 `width` / `height` 是上传那一刻量出来的真值。§5 的 `assets` 行按此回改。 |
| 2026-11-14 | W3：契约面跟上新契约。方法表 **65 → 63**（13 个域、无 `credential` 域）：新增 `agent.restoreFactory`、`config.saveMcp` / `config.deleteMcp`（取代 `config.patchMcps` 的整层替换）；删 `host.usage` 与 `credential.list/create/revoke` —— **删的是契约面，能力仍在**（`CredentialService`、`CredentialRepository`、`<数据根>/run/token` 与 `agents-host token create\|list\|revoke` 一字未动，`Credential*` 形状只留给那三个子命令）；§6 桥接名单后「其余 60 条」改成 59。A12 补 `around` 的取法（40 条窗口 / 命中才给 `anchor` / 没命中回空页不报错 / 与 `after` 同给时 `around` 优先 / 消费者只有桌面端搜索定位），A13 的条数 65 → 63。§3 补「视图与入参的几处形状」（`AgentView.messages` / `function`、`DiscoveryEntryView` 的传输字段与 `extra`、`DiscoveryLayerView.scope`、`McpOauthView` 的掩码口径、`ModelInput.tokenThresholds` 可选），§7 能力清单条数同步。§8 把 `@ai-zen/agents-client` 列成「共享连接层」并写清它这一轮定的三件事（npx 拉起 `spawnHostViaNpx`、阶段回调四态、`AbortSignal` 取消），明确「怎么画屏」不归它。 |
| 2026-11-14 | 测试口径落文（§11，原「变更记录」顺延为 §12）：默认套件关隔离 + 一个文件一个库里的一条 `tx` 清表 + 事实归属表 + 删用例的三条判据。默认套件从 79.5s 降到 20.3s，用例 801 → 761。 |
| 2026-11-14 | 能力清单去掉 `title` / `description`：`/help` 改由 CLI 自己的命令表渲染（PRD F-E5 订正），那两个字段与 i18n 的 `capability.*` 252 条文案零消费者，连同 `localizeCapabilities`、`createCapabilities(language)` 的语言参数、`callInLanguage` 夹具一起删；A13 / §7 / hello 段同步 |
| 2026-11-14 | 契约面 63 → 62：删 `host.capabilities`（连同 `hello.capabilities`、`handlers/capabilities.ts`、`CapabilityView`、`methodDomain()` 的唯一生产消费者）。两端零消费者，见 §7 那段；F-E6 的落点改成客户端命令表。`host.reload` 的 `scope` 参数一并删（5 值枚举 + 校验 + 映射全是空转，没有调用方）。i18n 又清掉 33 条零产出文案（`status.*` / `usage.*` / `notice.*` / `question.confirm.*` 等），并加守卫「每个词条在生产码里都有人取」 |
| 2026-11-14 | 状态栏块名搬回客户端：`StatusBlock` 去掉 `label`（8 块 × 2 语言 = 16 条界面词汇），宿主只给 `id` + `facts` + 顺序（`STATUS_BLOCK_IDS`）；CLI 用本地词条 `status.block.<id>` 渲染。`statusBlocksOf` 不再收 `language`，`blockLabel()` 与 i18n 的 `label.*` 8 组键一起删。同一口径的第二个案例（第一个是能力清单的 `title`/`description`）：**界面文案归界面，宿主只给事实** |
| 2026-11-14 | 状态栏的**块整个搬回客户端**（同一把尺子的第三步，也是最后一步）：`statusBlocks` 从 `conversation.state` 删除，`StatusBlock` / `StatusBlockId` / `STATUS_BLOCK_IDS` / `statusBlocksOf` / `StatusBlockInput` 一并不在宿主持有。原因不是审美而是 bug：那份副本只在 `conversation.state` 被拉的那一刻成立，而拉状态只发生在「打开对话 / 换模型 / `host.reload`」——于是聊天过程中上下文百分比、模型名、本轮 tokens、正在跑的工具**全冻在打开对话那一刻**（`/model`、`/thinking` 之后状态栏也不变，`本轮` 永远是 0）。同一批事实存两份，其中一份必然过期。八块要的事实各自在契约里本来就有：助手（新增 `ConversationView.agent = { agentId, name, available }`，`available` 的判定仍由 `AgentService.describe` 给，`ConversationService` 通过 `describeAgent` 端口要结论、不重写一份）、模型 / 思考档 / 目录在视图，上下文与用量在 `ConversationState`，工具与子 Agent 在 `run`。CLI 用 `cli/src/status-blocks.ts` 的 `statusBlocksOf` 现拼，顺序归它自己 |
| 2026-11-15 | 运行器补「跑中入队」：§4 的一轮时序拆成两条受理路（跑中 → `ChatRunner.enqueue` → core `pushInbox`；否则 `RunRegistry.start`，`busy` 只剩兜底），补四个取件点（`high` / `low` / `onInnerLoopsEnd` 之后 / `onAfterSend` 之后）与「判能不能排与推之间不允许有 await」「只有真插进条目才续圈」两条不变量；补「排队消息的首次写入必须在落地那一刻」（`seq` 的因果，`persistLandedQueued`）。§5 的「边流边写」注明这条例外，读数表下方补三条读数（`listByConversation` / `listDelegated` / `countByConversation`）的加减关系。`ConversationRuntimePort` 从两件事变三件（多一个可选的 `runState`，`conversation.list` 的 `run` 用它） |
| 2026-11-15 | 取件点收成一个：core 的 inbox 取件只在 `runLoops()` 的内循环末（`high` 先取，`!needContinue` 时才问 `low`），段首的落地改由 `deliver()` 的 `flushInbox()` 负责（`flushInbox` 只有这一个调用方）；`abort()` 不再清空 inbox（要作废排队得显式 `clearInbox()`），取件判据从 `runAborted` 换成 `runStatus === "running"`。宿主侧的 `TurnSession.enqueueState` / `waitEnqueueable` / `QUEUE_READY_TIMEOUT_MS` 一并不在，装配期改用 `TurnSession.pending` 数组缓冲、`attach()` 那一刻冲进 inbox。`RunState.inboxPending` 换成 `RunState.inbox`（`InboxItem[]`：`messageId` / `source` / `createdAt` / `preview`，顺序即取件顺序，计数取 `inbox.length`），客户端据此在输入框上方回显排队区。一处有意接受的退化：收尾钩子（`onInnerLoopsEnd` / `onAfterSend`）期间投进来的条目不再被带走，只由 `ChatRunner.settle()` 的 `inbox-leftover` 告警出声 |
| 2026-11-15 | **平级会话阶段 1**（PRD D33 / F-C16–F-C19）：§3 对象图的服务从 15 个变 16 个（新增 `PeerSessionService`：建另一段会话 → 记进程内记录 → 跑完结果投回并发起者），§1 新增 **A14**（编排元数据不落库、投递复用 `ChatRunner.enqueue` / `run` 两条现成路径、「谁在调我」用 `WeakMap<agent, conversationId>` 记、不给 core 的 `Agent` 加字段），§8 的 SDK 边界补 `PeerSessionsScopePlugin`（能力从端口进来，不给端口就不产出）。§9 登记两条缺口：阶段 2/3 未做、重启后编排元数据消失（退化成普通会话）。另一处口径纠正：投递的 `source` 就是可读 label 原样（不再套「会话「…」」），来源注释仍由 core 的 `inboxEntryContent` 统一生成 —— 落库那份与发给模型那份一致（`withSourceNote` 在 `run()` 与 `TurnSession.enqueue` 两处各过一道，带 `storedContent` 的入队条目不再分叉） |
| 2026-11-15 | **压缩补成常驻 agent 能用的样子**（§4 / §5）：交接线插件真的装上并按**会话类型**归一 —— 派生会话（`PeerSessionService.isPeerSession`，仍是进程内记录）越线就自己压（`resolveMode` 回 `"self"`，不弹问题），用户会话回 `null` 把「要不要压」交还给宿主的提问路径，`askHandoffAfterSettle` 因此多一条派生会话守卫（「非 `user` 来源不问」只管「问」）。`AutoMigratePlugin` 多一个 `onMigrated` 回声（迁移**成功之后**才叫，报实际执行者），宿主用它写 `compactions…`；`HandoffService` 开新对话那一步写 `manual`。**迁移 v2**：`conversations` 加 `compactedAt` / `compactionMode`（都可空，v1 的建表语句不动），`ConversationSummary` / `ConversationState` 带上这两格（可选，省略 = 没压过）。观测值一处修正：自起段结算报的 `TurnSettledFacts.source` 改成叫醒它的那条 inbox 条目的 `source`（`AgentRegistry.onInbox` → `ChatRunner.noteInbox`），不再是固定的 `"inbox"` |
| 2026-11-15 | **按代码事实回改（agent 常驻这一轮）**：§1 **A9 改写**（agent 常驻、短对话一个实例跨轮复用，`messages` 是内存真相；Scope 没有空闲回收）、**A10 改写**（「agent 该不该活着」的判据只在 `AgentRegistry` 五个方法 + 观察用的 `onLifecycle`；没有空闲计时器）、**A14 改写**（回投挂在每一次段结算上，投递收敛成一个入口）、新增 **A15**（投递只有一个入口；「唤醒」与「复活」两个词）。§3 对象图三行跟上（`ScopeRegistry` 的公开面、`AgentRegistry` 常驻、`PeerSessionService` 多了「接着说话」与「每一段结算回投」）。§4 一轮时序改成 `acquire` / `complete`（不再有「每轮重新装配即弃」与 `AgentRegistry.dispose`）；§4 三个实例段补「存活策略只有一处」与 `onLifecycle` 的理由闭集（`ScopeBusyError` 带 `conversationIds`）；§4 收尾钩子那段不再说「那几条真丢」（agent 常驻，条目留在 inbox 等下一次外部驱动）；新增三段：自起的段（D36）、投递只有一个入口（D35）、平级会话阶段 2（D38）；压缩段补「只产文档不记 `manual`」；「没有空闲计时」与「进程退出」两段按 D28 / D37 重写（Scope 不再进退出判据）；配置改动那段补一句 `agents.invalidate`。§9 两条平级会话缺口改成阶段 3 口径 |
| 2026-11-15 | **文档收敛（本轮）**：宿主 docs 四份（PRD 332 / PLAN 620 / 架构 519 / 实施问答 267 行）与 SDK 设计文档（1401 行）合并成仓根 `PRD.md`（需求与决策）+ `PLAN.md`（结构 / 时序 / 落点 / 波次），总行数 ≤1200，`.ai-zen/plans/` 下的四份计划草稿一并删除；`R1–R79` 从上一次删除的 `.ai-zen/plan-server-rewrite.md`（`git show e66c1b3:`）抽回 PRD 的裁定表，`R77–R79` 从交接记录抽回，`R68` / `R69` 取自 `git show e9fe4a1:.ai-zen/plan-clients.md`；实施问答里仍成立的结论按同一口径并入 PRD（`QD` 这个词全仓零命中，不再使用）；本表两处结构损坏按内容修好（W3 与「测试口径落文」粘连成一行、「平级会话阶段 1」重复一份被截断后串进「压缩」那一行）；7 处代码注释与 16 处文档链接改指新文档 |
| 2026-11-16 | **代码跟上（W1–W5）**：`wire`（`RunState` / `UsageSnapshot` / `GenerationState` / `RunOutcome` / `SubAgentSnapshot` 全删，事件 9 个，`conversation.send` / `state` / `abort` 出参收敛，新增业务码 `conversation_dead`）；`runtime/ChatRunner.ts` 重写成「一段对话一个常驻桥」（`deliver` / `abort` / `state` / `forget` / `killScope` / `reconcile`），`TurnSession` 与 `RunRegistry` 删除；`handlers` / `services` / `app.ts` / `WsHub` 跟改（`onTurnSettled` → `onIdle` 读当下事实、`checkExit` 与连接数触发源删除、`PeerSessionService` 只剩建/投/问状态）；SDK 发话工具改名 `postMessage`、回执只剩「收下了」、状态收敛四格 + `gone`；客户端按事件重建 `messages` 镜像（`applyChunk` 与宿主同一个函数）+ 四格。投递的「叫起来」判据从 `allowRevive` 改名 `mayStart`（创建者两处：界面发送按钮、`create_session` 的第一句）。全仓 `tsc` 六个配置零错误；旧的垃圾用例按「测的东西不存在就删」处理，没为绿改生产代码 |
| 2026-11-16 | **按「没有轮」重写宿主形状**（用户判词）：删掉「一次运行」这套骨架 —— `run`/`enqueue` 两条受理路合成一个 `deliver`、`TurnSettledFacts`+`settle()` 换成「变闲那一刻读当下事实」、`RunRegistry` 与助手占位行作废、`RunState` / `run.state` / `usage` 事件不再存在（状态只有四格 + 待办，用量与细节阶段归客户端自己算）；**回投整个作废**（PRD 4.6：会话间通信只有投递）；§5 整节重写成「投递 / 变闲那一刻 / 事件通道三条粒度」；A14、A15、§3、§4、§6 事件面、§10.1–10.2 落点表跟着重写。代码尚未跟上，待拆清单在 §10.1 / §10.2 末尾。**进程退出判据作废**：连接数为 0 不再触发任何收尾 —— agent 常驻就是常驻，有没有客户端连着与它无关；`checkExit` 那一套（含两个触发源）删 |
| 2026-11-16 | 新增仓根 `CORE.md`：core（引擎）的需求与决策单独成文 —— 边界、五个动作（start / stop / abort / resume / kill）、双循环、一条队列 + `takeAll` / `asTakeAll`、三格状态、中断（signal + abortRx，寿命一圈）、两套收尾策略、`AgentError` 一个类三码、工具并行、subagent 属 core 概念、事件与钩子的命名口径（事件说发生了什么 / 钩子说缝在哪儿）、`messages` 唯一引用的时机规则。`PRD.md` 与 `PLAN.md` 各加一行指路，并把 §9 的 core 归属行改成「本表只划归属，需求见 CORE.md」 |
