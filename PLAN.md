# 宿主实施方案（PLAN）—— 结构、时序、落点、波次

> 本文件是 `packages/host` **怎么搭 / 先做什么 / 落在哪个文件的哪几行**的唯一来源：结构 `A##`、对象图与生命周期、投递与事件通道、落点表、波次 `W#`、欠账。
> 需求与决策见 `PRD.md`（`F-##` / `L##` / `D##` / `R##`）。**一个事实只写一处**：需求在 PRD，结构与生灭时序在本文件；互相指路只写一行「见 PRD D28」。
> **core（引擎）的需求与机制见 `CORE.md`**；本文件只管宿主，不重复 core 的任何一条事实。
> 本文件里的 `A##` 编号被代码注释引用（如 `MessageRepository.ts` 的「A12 的 `message.list` 口径」），**不能改号、不能改含义**。

---

## 1. 目录与分层

单根 + 薄 service + 一层仓储，按需扩展，不预摆空层。不用模块级单例、不用反射扫描；依赖从根显式注入，跨服务协作（删会话 → 结束它那个 agent）用显式钩子声明，不靠事件总线兜。

```
app.ts        单根：组装、启动、退出
cli.ts        命令行：serve / token / version
config.ts     路径与端口来源
index.ts      包出口（wire 类型 + createHost）
wire/         契约：methods（方法表）、frames（帧）、errors（业务码）、events（事件）、states（状态形状）
net/          WsHub、auth、discovery、UploadReceiver
handlers/     方法实现（一域一文件）+ index（HandlerTable 与桥接名单）
services/     薄服务（写流不在本包：`packages/logger` 的 `FileLogger`，见 §3）
runtime/      ScopeRegistry、AgentRegistry、RunRegistry、ChatRunner、TransientRunner
storage/      Database、dbWorker、Repository、migrations
i18n/         文案（en 基准 / zh）
```

---

## 2. 结构决定（A1–A15）

| # | 定论 |
|---|---|
| A1 | 一个宿主进程装所有会话；会话之间不做进程隔离 |
| A2 | 一个监听器、一条 WebSocket，RPC / 推送 / 二进制上传都走它 |
| A3 | 契约归宿主自己（不独立成包、不叫「约定」），客户端照着用 |
| A4 | JSON-RPC 2.0 为底，产品形状长在 `params` / `result`；标准里对我们有负担的部分（批量请求、强制错误码空间、通知必须无 id）不用 |
| A5 | 所有连接都要凭证；本地无感靠「创建时凭证已自动填好」，不靠回环豁免 |
| A6 | 启动方式决定监听范围：本地实例只监听回环；对外实例由创建者起、自己配凭证并分发 |
| A7 | `node:sqlite` + worker 线程 + WAL；全文检索用 FTS5 `trigram` |
| A8 | 分层照桌面端：单根 + 薄 service + 一层仓储，按需扩展，不预摆空层 |
| A9 | **agent 常驻**：一段会话一个，活到显式退役 —— 它的 `messages` 就是这段会话的内存真相（装配一次，之后不读库、不重复 push）。**Scope 没有空闲回收**（见 PRD D28） |
| A10 | 「agent 该不该活着」的判据**只有一处**：`AgentRegistry` 的 `acquire` / `complete` / `kill` / `killAll` / `invalidate` / `invalidateSession` / `disposeAll`，外加观察用的 `observeLifecycle`；别处只报事件。没有任何空闲计时器 |
| A11 | 上传走同一条 WS 上的**二进制帧**（三段式），不用 base64 字符串 |
| A12 | `message.list` 有**两种按 id 的取法**：① `after=<id>`——该 id **存在**就返回它**最新的内容**及之后全部；**不存在**就返回全部（断线补拉与删除后重拉共用这一条）。② `around=<id>`——该 id 在本次可见集里就**以它为中心取一窗**（40 条，前后尽量均分，命中那条一定在里面）且 `anchor` 报成它；**不在**可见集里（已撤回 / 换过库 / 是 `hidden` 而这次没要）回**空页 + `anchor: null`**，**不报错**。两者同时给时 `around` 优先；`toolCallId` 决定读哪一段，两个定位参数都只在那一堆里生效 |
| A13 | ~~能力清单的粒度是「契约里每个方法一条」~~ **已废**（2026-11-14）：`host.capabilities`、`hello.capabilities` 与 `CapabilityView` 都删了，两端一个消费者都没有 |
| A14 | **平级会话只做三件事**：建一段会话、往任意会话投一条、问一段会话的状态。进程内记录只放**可读名**；**血缘是持久身份**（会话行上，给历史展示用），**投递不按血缘校验**；**状态不存**，问的时候现读 agent 那一格。**没有「跑完把结果投回去」这种东西** —— 会话间通信只有投递（PRD 4.6）。「谁在发」用 `WeakMap<agent, sessionId>` 记（只用来填来源标记），**不给 core 的 `Agent` 加字段** |
| A15 | **投递只有一个入口**（宿主 `ChatRunner.deliver`，core 侧是 `agent.push`）：塞进队列就完了，**回执只有「收下 / 被拒」**，不带状态、不带结果。**唤醒**（活着的 agent 被推起来）与**复活**（agent 不在、按库里历史重装）是两个词，不混用；**禁止等**（唯一例外是没有第二个触发方的一次性会话，PRD 4.3） |

---

## 3. 对象图

```
HostApp（根：组装、启动、退出）
├─ 基础设施
│  ├─ ConfigManager        (SDK) ← 配置唯一入口（basePath = 数据根）
│  ├─ Database             SQLite worker（all / get / run / tx / close）
│  ├─ *Repository          只做 SQL，不含业务（一表一文件）
│  ├─ i18n                 render / normalizeLanguage（en 基准、zh；未知语言回落 en）
│  └─ FileLogger           `@ai-zen/agents-logger` 的实例（`resolveLogger` 造），落 `logs/host/host.log`；warn / error 按来源转通知
├─ 服务（一服务一文件，薄，共 16 个）
│  ├─ WorkspaceService、SessionService、MessageService、AgentService
│  ├─ ModelService、ConfigService、AssetService、SearchService、CredentialService
│  ├─ CompletionService、DiscoveryService、HandoffDocumentService、NoticeService、QuestionService、AutoNaming
│  └─ PeerSessionService      平级会话：建一段会话、往任意会话投一条、问一段的状态（A14；不记状态、不回投）
├─ 运行时（有状态，比 service 更长寿）
│  ├─ ScopeRegistry            workspaceId → Scope：显式 create / get / refreshWorkspace / dispose / disposeAll / workspaceIds，无空闲计时
│  ├─ AgentRegistry            sessionId → 活着的 agent（agent 唯一的来源；常驻、跨轮复用；存活判据只在这里）
│  ├─ ChatRunner               会话 ⇄ agent 的桥：订事件照着写库、投递、中断、现读状态
│  └─ TransientRunner          一次性会话（不落库、不推流式事件，`runOnce` 跑到头）
├─ 接入
│  ├─ WsHub                连接集合、鉴权、语言、JSON-RPC 分发、推送缓冲
│  ├─ UploadReceiver       同一条 WS 上的二进制分帧落盘
│  ├─ auth / discovery     凭证校验、发现文件与本地凭证交付
│  └─ handlers/            方法实现（一域一文件）→ HandlerTable
```

**根的职责只有装配**：`this.x = await createX(...)`，一行一个。造对象的事写在各自的工厂里（`resolveLogger` / `resolveCliEnv` / `createNoticeSubsystem` 这类），跟它造的东西放同一处；根里不出现业务 `if`，也不出现「没有就给个默认」——那是工厂的事。

**门面不往下传**：`HostApp` 递进 `services` / `runtime` 的是**它要的那几件事**（`handoffService` 收的是 `{ sessions, workspaces, messages, sessionViews, agents, runner }`，不是 `HostApp`）。传根会让「这个对象依赖什么」从签名里消失，也会让依赖方向成环。

判据一句话：**打开一个文件，应该一眼答出「这东西是谁造的、它依赖什么、它活多久」**。三个根（`HostApp` / `CliApp` / `DesktopApp`）同一个形状——构造便宜、`start()` 按序造齐、`stop()` 逆序收尾；拿不准就照 `HostApp.start()`、`resolveCliEnv`、`resolveLogger` 抄，不另立条文。

**视图与入参的几处形状**（每条写「谁产生 → 客户端拿它做什么」）：

| 形状 | 谁产生 | 客户端拿它做什么 |
|---|---|---|
| `AgentView.messages` / `.function` | `AgentService.toView` 原样转出 SDK 的 `AgentDefinition["messages"]` / `["function"]`；读不出来时都是 `null`，非 subagent 的 `function` 恒 `null` | 先看得到提示词与 subagent 定义，才有可编辑的对象（PRD F-F5）；`agent.update` 收到的 `messages` 原样交回等于没改 |
| `DiscoveryEntryView` 的传输字段 + `extra` | `DiscoveryService.discover`：MCP 条目把「这条服务器怎么起的」整份摊开；`extra` 收留本版不认识的键 | 编辑屏不必凭 `id` 重建就能改；回写时 `extra` 逐字带回（PRD F-F6）。非 MCP 三类这几格恒为 `null` / 空对象 |
| `DiscoveryLayerView.scope` | 同上：MCP 5 层里只有 2 层非空 | 直接认「哪一层可写」，不再按 `editable` + `depth` 反推 |
| `McpOauthView` 的掩码 | `DiscoveryService` + `services/secretMask.ts` 的 `maskSecret` | 与 `EndpointView` 的 `apiKeyMasked` / `apiKeySet` 同一套；回写省略 = 保留磁盘原值 |
| `ModelInput.tokenThresholds` 可选 | `ModelService`：`create` 省略套出厂默认、`update` 省略不动 | 建模型不必自己抄两个数 |
| `SessionSummary.status` / `.inputPaused` / `.outputPaused` / `.alive` / `.inboxPending` / `.agent` / `.createdBy` | `SessionService.toSummary` + 端口 `presence` / `describeAgent`；**四件事各一格**，是**查询那一刻现读**的，不落库、不是字段 | 侧栏说得出「这段是闲还是忙、两道闸开着没有、它还活着吗、队里还压着几条」与助手可用性；状态栏八块由客户端现拼（PRD F-I6） |

---

## 4. 生命周期

**生灭都是显式的**：`Workspace ──1:1── Scope ──1:N── Agent` —— 到 agent 为止，没有第五个对象（「死」就是它不在）。

创建自上而下（`agents.acquire` 先向 `ScopeRegistry` 要 Scope，它是幂等 get-or-create，调用方不必背顺序）；回收自下而上（`scopes.dispose` 撞上还活着的 agent 就**拒绝**，抛 `ScopeBusyError` 带 `sessionIds`，不级联）。没有空闲计时、没有自动回收：活着就是有人显式持有它。

**存活策略只有一处（`AgentRegistry`）**：`acquire`（在且合用 → 复用；不在 → 装配；装配事实变了 → 丢掉重建）、`complete`（变闲那一刻看一眼：陈旧才退役）、`kill`（会话被删：只丢引用，之后这台实例不可复活）、`killAll`（项目被删：那个 Scope 下的 agent 一起丢）、`invalidate`（配置生效：空闲的当场退役、在跑的只打标记）、`invalidateSession`（换模型 / 换思考档位）、`disposeAll`（进程收尾）。每一步报一条 `onLifecycle`：`action` = `built` / `reused` / `rebuilt` / `retired`，`reason` 是**闭集**（`never-built` / `assembly-facts-unchanged` / `assembly-facts-changed` / `config-changed` / `stale-on-idle` / `session-deleted` / `shutdown`）——「这段会话为什么没有 agent」的唯一答案就在这条流里。`ChatRunner` 不再持有「一段现场」这种东西：它把监听订在 agent 上（订一次，活到 agent 退役），事件来一条处理一条。

**Scope 被销毁的两个原因（都是显式动作）**：① Workspace 被删（`dispose(workspaceId)`）；② 进程收尾（`disposeAll()`）。前者撞上还活着的 agent 会拒绝，调用方顺序是「先停会话 / 丢掉 agent，再销毁 Scope」；后者不拒绝。**配置改动不是销毁原因**：`refreshWorkspace(id)` 就地把配置重读一遍、各插件重新发现一轮（MCP 连接按新声明对账断开），实例还是同一个，正在干活的那个也不会被抽掉能力；刷完再对同一个 Workspace 调一次 `agents.invalidate`（PRD D34）。

**一段会话的诞生**（PRD R56 / F-D9）：`session.create` 只定身份并发一个 id，不写库；**第一次真正用到它**（`session.start` 或 `session.send`，谁先到谁写）时 `SessionService.ensurePersisted` 才写行，**落行那一刻同时写这段会话的第一条消息**——一条 `role: user`、`hidden: true`、`source` 为 `{ kind: "system", label: "cwd" }` 的 cwd 消息，**正文就是那个路径**（不是一句渲染过的话 —— 这条消息是隐藏的、用户看不见，模型要的就是路径）。只在创建时写这一次；交接换完的记忆里**没有**这条（目录随时问 `cwd` 工具）。它最先写，所以 `seq` 在真实用户消息之前；之后每轮都不再写、也不往用户消息里拼任何东西。cwd 取 `workspaces.cwd`，`workspaceId` 创建即定死。

**会话级模型与思考档位**（PRD L7 / R70–R72）：存在 `sessions.modelId` / `thinkingLevel` 上，改了就落库。装配 agent 时从这里取：`modelId` 直接给 SDK 的三级解析，`thinkingLevel` 按该模型引用的策略表展开成参数补丁、叠在助手定义的 `modelParams` 之上（同一模型才叠）。展开发生在 `ChatRunner.createSdkAgentFactory` 的 `sessionModelParams`，档位名本身不进请求；换模型时档位清空。**这两手只允许空闲时做**（判词）：非空闲一律拒（`busy` + `detail.reason = "working"`），一个字节都不写库；空闲时改完当场让那个 agent 退役（`AgentRegistry.invalidateSession`），下一句话按新事实重新装配 —— 没有「忙的时候打标记、变闲再兑现」那一套（那套只服务全局配置生效，PRD 4.11 改配置不杀任何会话）。服务层要的运行时接口因此只剩四件（`SessionRuntimePort`）：**四件事的现读**（`presence()`：忙闲 + 两道闸 + 死活，加上队里几条）、**删掉之后的现场丢弃**（`forget`）、**这一段手上有没有活**（`agentState`，没 agent 回 `null`）与**让这一段空闲的 agent 退役**（`invalidateAgent`）。

**进程退出**（PRD 1.7 / 4.12）：**只有三个原因** —— 用户显式关闭（命令 + 一次二次确认）、进程被外部杀掉、机器没了。**连接数不参与任何判断**：agent 常驻的意思就是「有没有客户端连着，跟它活不活无关」，所以既没有「最后一个客户端走了就收尾」，也没有「把手上的活干完再退」—— 不自动退出这件事把这两条一起取消了（`checkExit` 与其两个触发源作废）。

**显式关闭时的收尾顺序（`stop()`）**：摘发现文件 → 销毁 Scope → 断连接 → 清理上传 → 关库 → 关日志（先写最后一笔，再 flush 并关流，PRD F-J2）。同一次收尾还负责清掉升级自检的定时器。

---

## 5. 投递、变闲那一刻、事件通道

宿主与一段会话之间只有三个口：**投递**（往里塞）、**中断**（掐在途）、**观测**（读当下 + 收事件）。没有「开始一次运行」「结算一次运行」这种口 —— 那要先有边界，而边界不存在。

### 5.1 四个动作各管一件事（P0：接口正交，复合动作归客户端）

**宿主只给正交的动作，每个只做一件事**，不顺手替别人做。复合动作（「按发送」到底意味着什么）由客户端按当时的实际处境编排。

| 方法 | 只做 | 绝不碰 |
|---|---|---|
| `session.send` | 收进队列 | 不复活、不动闸、不判阶段 |
| `session.start` | 确保这段有 agent（装配 / 复用；活着就是幂等 no-op；草稿会先落库） | 不投递、不动闸 |
| `session.resume` | 开输出闸 | 不投递 |
| `session.pause` | 关输出闸 | 不掐在途 |
| `session.abort` | 掐在途的请求与工具 **+ 关输出闸** | 不清 inbox |

**`mayStart` 已作废。** PRD 1.2 的原话是「客户端点发送时先判这段是死是活，**死的就调接口复活、再投递**」—— 三件事、客户端编排。把它压成一个隐式参数塞进 `deliver`，等于让 `send` 同时干「投递 + 开闸 + 复活 + 判阶段」四件，而这四件各有自己的判据与失败语义（投递只管收下；开闸只管换一道开关；复活要装配，可能会失败；判阶段是读状态）。

于是投递本身只剩一件事：

```
session.send / post_message / 定时器 / 外部程序
 └─ ChatRunner.deliver(sessionId, { content, source })
      ├─ 目标不存在 → 拒（not_found），错回给投递方那次调用
      ├─ 目标是死的 → 拒（session_dead）；**叫不醒任何人，包括界面的发送按钮** ——
      │      那件事客户端先用 `session.start` 做完再来
      └─ 活着       → 入队（两道闸都不拦投递；输出闸关着就是只收不取）
      回执：收下了（userMessageId + 每个附件最后怎么走的）／被拒。
```

**「谁能复活」从此不在宿主这一层判。** PRD 1.2 明写「谁能给谁投、能复活谁，宿主不做任何限制」；「agent 不能复活会话」靠的是 **agent 手上没有那个工具**（§10.2、PRD 4.6），不是靠一个只有某个调用方会给的参数。**别把 `mayStart` 加回来** —— 加回来就把这条边界挪成「宿主按参数猜来源」，而参数是可以伪造的。

**客户端按发送时编排三步**（TUI 上只有「发送」与「继续 ⇄ 中断」两个位置，PRD 4.4）：

```
await session.start()    // 只在 !alive 时：复活（草稿会话它会先落库，见 §4）
await session.resume()   // 只在 outputPaused 时：开闸（"用户点发送就是继续"）
await session.send()     // 投递
```

**交接期间因此不需要任何特判**：那段必然活着（`start` 用不上）、`resume` 会被宿主拒（`handoff_in_progress`）、剩下的只有 `send` —— 「交接期间发送只投递」是正交的**推论**，不是一条分支。从前 `deliver` 里那句 `!handoffs.has()` 正是把复合动作塞进 `send` 才长出来的。

**判据只有两条**：目标在不在、活不活。不判「有没有资格发给我」（投递不看关系，A14）；不判「它忙不忙」（忙不是拒绝的理由，队列本来就收）；不判「这条会不会被处理」（PRD 4.13 不承诺）。

**回执里没有状态、没有「叫醒了没有」、没有结果**：那三样都是对未来的断言，而未来只能靠观测。

**投递不等**。`await` 的边界就是「已入队」：push 完就回，之后的事归 agent 自己。唯一允许等的是**一次性会话**（没有第二个触发方，PRD 4.3）—— 那里用 `runOnce` 跑到头。

**装配期间的投递**先收着，装好按到达顺序一次推给它 —— 不等待、没有超时、不丢。装配由 `session.start` 触发（或它引发的首次装配），缓冲归 `ChatRunner`。

**inbox（队列）每一刻现读** `agent.inboxPending`，不存镜像：一份会与真队列分叉的副本没有存在的理由。

### 5.2 唯一的判断：变闲那一刻

> **前置：先做完 §5.1 的 P0（接口正交）。** 那一单把「投递里内嵌的开闸与复活」拆出去，`deliver` 因此只剩入队一件事；本节的判断不受影响（它读的是会话行与消息上的事实），但 `deliver` 的两条拒因会跟着变少一条。

agent 从忙落到闲的那一拍（core 的 `state:idle`）做一次**读当下事实**的判断 —— 整个宿主只有这一处「到点了要考虑点什么」：

1. 这段是不是派生会话？是 → 不问交接（它的自动交接开关在**创建时**写成「开」，自己压，PRD 4.5）。
2. 最后一次请求的 `prompt_tokens`（就在最后那条 assistant 消息上，不求这一批的和）有没有越过配置里的交接线？
3. 有没有已经挂着的题？
4. 三条都成立 → 问（`QuestionService.askHandoff`）。

四步全是**读**：没有「这次运行的结果」、没有产出清单、没有结局。答完之后的事归 `QuestionService`：**先把题答完**，再判这段是不是闲下来了 —— 闲就当场交接（自交接＝往同一个 agent 投一条指令让它自己写；独立交接＝另起一个一次性 agent），不闲就在会话行上记一条待交接（`pendingHandoff`，带 mode），等下一次变闲再做。

同一拍还有一件确定性的事：`AgentRegistry.complete`（配置改过才退役）。**不催退出** —— 宿主不因为没人连着而收尾（§4）。

**没有任何「跑完把结果投给谁」的动作**：会话间通信只有投递（PRD 4.6）。派生会话变闲时什么都不发。

### 5.3 交接：只在空闲时发起，靠「不落库」隔离

- **判据收在一处**：「能不能立刻接手这一批」＝ 有 agent + 手上没活 + 输出闸开着 + 不在交接中；否则拒（`busy`），`detail.reason` 分别是 `no_agent` / `working` / `output_paused` / `handoff_in_progress`。不做「先 abort 再按住」，也不做「等变闲」「放行一手」。
- **交接期间只关输出闸，不关输入闸**：别人投进来的话**照收**、排在 inbox 里（积压由客户端 `/clear` 清），但这一任不取 —— 那一批**收口即关输出闸**（批头关，不能更早 —— 闸一关连队里的货都取不到，提前关就是死锁），记忆换完再开。**交接完成即开闸**（不记交接前有没有关过闸）；**中断回滚后保持输出闸关**。**交接期间 `deliver` 不拒** —— 没有任何「拒」这一说。
- **隔离靠「交接态」**（`beginHandoff` / `endHandoff`）：这段在写文档期间产生的消息**不进库**（否则「关于交接的那场会话」会进转录、进历史、进条数），但 `message.added` / `message.delta` / `message.changed` **照常推** —— 用户得看得见它在写。
- **「写完了没有」看工具结果**：写文档那次工具调用的 `toolFinished` + 一次落盘校验（`MIN_HANDOFF_BYTES`）；两次都不成立 → 单向降级到独立交接，再不行就是失败通知。不看状态、不等 idle。
- **提交与回滚都推 `memory_replaced`**，客户端据此 `message.list` 全量整段替换，把那批只在内存里的写作痕迹清掉。断线重连的客户端天然看不到它们（库里没有）。
- **提交点之后是「换记忆」**（PRD 4.5），分工是死的：**新记忆长什么样由 SDK 那一处算**（哪些旧消息留、哪些 `omit`、断点消息 `role: system` + `hidden` + 只带路径、文档不到 400 字节算没写出来 —— 外部使用者用 SDK 时是同一份），**宿主只负责把它落到库**：**一个 `tx`**（`SessionRepository.replaceMemory`）插一行 `已存档_<原名>` 会话（项目 / 助手 / 模型 / 思考档位**以及两条阈值、自动交接开关、血缘这四格**照抄，创建时刻是交接那一刻 —— **交接不产生新身份**，血缘跟着走）、把原会话的**全部消息行**改挂到它名下（`seq` / `createdAt` 原样不动，素材关系行跟着搬）、在原会话写回 SDK 算好的那条断点消息。随后内存里 `agent.messages` **原地**换成同一份（不重建 agent、不动队列与两个开关），再按顺序推 `memory_replaced`（原会话）与 `created`（存档那段）。失败或取消则整批不成，**一段存档会话都不留**。`[用户]`

### 5.4 事件通道：三条粒度

宿主不统计、不推断，只把到达的事实按粒度送出去（落库走同一批事件）：

| 粒度 | 事件 | 载荷 | 谁在用 |
|---|---|---|---|
| 追加一条 | `message.added` | 完整消息对象（id / role / status / content / source / tool_calls…） | 客户端建槽；宿主写行 |
| 流式一片 | `message.delta` | core 的 `AgentNS.Delta` 原样 + `messageId`（**没有 seq**：有序连接上「漏一片」这个处境不存在，断线即作废、靠 `resync` 整段对齐） | 客户端跑同一个 `applyChunk` 增量 |
| 一圈收口 | `message.changed` | 完整消息对象（此刻的 status / tool_calls / finish_reason / usage 都在上面） | 客户端整条替换；宿主覆盖写行 |
| 事后改写 | `message.changed` / `message.removed` | 同上 ／ 被删的那条（中止、出错、`drop`、`omit`） | 同上 |
| 状态 | `state` | `{ sessionId, status }`，`status` 只有 `working` / `idle`（**只读**，变了才发）；两道闸各有自己的事件（`output:paused` / `output:resumed`、`input:paused` / `input:resumed`）；**死活 = 有没有 agent 实例**，走 `session.changed` 的 `agent_started` / `agent_gone`（不挤进 `state`） | 客户端自己那四个字段 |
| 出错 | `error` | core 的 `AgentError` 完整对象（`code` / `message` / `detail`）+ 它挂在哪条消息上 | 日志、排查、要技术细节的地方；**消息行里另存一份「回显用」的失败事实**（码 + 文案键 + 参数），活得比进程长（PRD 4.15） |

- `session.changed` 的 `change` 取值里有 `handoff_started` 一格：交接**开始**那一刻推它（界面据此直说「正在交接」、输入框不给发、只留中断）；收口仍只有 `memory_replaced`。`[用户]`

**不为字段变化单独发事件**：一条 delta 流 + 一圈收口一条整对象就够了。「status 从 writing 变 completed」不单独播 —— 收口那条整对象里带着它。**消息上的字段一律整条带**：`hidden` / `usage` / `tool_calls` / `omit` / 回显用的失败事实都不挑 —— `hidden` 只是客户端不显示，请求里照发。

**预填消息同样走 `message.added`**：core 每一圈开头追加的那条 `status: pending` 的 assistant 消息、工具结果、落地的用户消息、注入的 cwd / 交接摘要，都从 `append()` 那一个口广播。客户端先有槽，delta 才挂得上。

**宿主不做的事**（写在这里是为了不再长回来）：不算速率、不维护「请求中 / 思考中 / 输出中」这类阶段（客户端按事件到达自己推）、不报「这一段用了多少」（「这一段」不可定义）。

**用量那一条改过了（2026-11-19，PRD 4.14 未定）**：不能再说「不算用量、客户端自己合计」——
单条 `usage` / `subAgentUsage` 宿主是**存**的（跟消息走 `data` 通道，`toRow` / `fromRow`），
而「客户端自己合计」只在它见过的那部分消息上成立：断线重连、按 `after` 增量拉取之后它手上不全，
也不知道历史上每条消息用的是哪个模型（模型可以换）。所以**累计与花销归谁算待拍**。
宿主现在不推任何「用量快照」或聚合事件 —— 这一条仍然成立，与「谁算合计」是两件事。

**落库 = 同一个镜子的另一份**：`message.added` / `message.changed` 到了就写那一行（边流边写只是节流，不是「提前写」），`message.removed` 到了就删。**没有「最后统一写一遍」**：那等于假设有一个终局。

### 5.5 换模型 / 换思考强度：只允许空闲时

**判词：「只允许空闲时候换模型换思考强度。」** 于是没有「忙的时候打标记、变闲再兑现」那一套 —— 非空闲就拒，空闲时改完当场换人。

- **判据只看「手上有没有活」**：`agent.state === "idle"` 才放行，有活就拒（`busy` / `working`）；没有 agent（死的）也放行 —— 没有 agent，就没有「手上那批活」可打岔。输出闸与交接态不是这一手的事（「能不能立刻接手交接」那四条拒因见 §5.3）。
- **拒就是拒**：`HostError("busy", { detail: { sessionId, reason: "working" } })`，**一个字节都不写库**（判据摆在参数校验与写行之前）。
- **允许时**：写会话行 → 立刻 `AgentRegistry.invalidateSession(sessionId)` → 回 `SessionView`。那个 agent 不能留着：模型客户端与思考参数都是装配那一刻读的，留着它就是「换了模型还在用旧的客户端」；下一句话按新事实重新装配。
- **两条阈值不是这一回事**：它们不进 agent 的出厂配置（宿主按会话行现读），所以改它们**不碰 agent、不重建** —— 与这两手正好相反。

## 6. 契约面

- **方法**：`<域>.<动作>`，共 **68** 条、13 个域（`src/wire/methods.ts` 的 `METHOD_NAMES`）。分域点数：`host` 6、`workspace` 5、`session` 19、`message` 1、`question` 2、`notice` 3、`config` 8、`agent` 8、`model` 8、`asset` 3、`completion` 1、`handoff` 2、`search` 2。
- **暂停与继续**：`session.pause` / `session.resume`，入参 `{ sessionId }`、出参 `{ paused: boolean }`。暂停**只翻输出闸、不掐在途**（手上这批跑完、从下一批起不取）；继续**只开闸、不投任何东西**（压着的 inbox 按原顺序接着跑）。没有 agent 时回 `{ paused: false }`（不是错误）；**交接期间两者都拒**（`busy` / `handoff_in_progress`）。`[用户]`
- **点数沿革**：65 → 63（W3：+`agent.restoreFactory`、+`config.saveMcp` / `config.deleteMcp`，−`host.usage`、−`credential.list/create/revoke`、−`config.patchMcps`）→ 62（删 `host.capabilities`）→ 63（W6-E：+`session.clearInbox`，清空 inbox 归客户端）→ 64（W11：+`session.setThresholds`，两条阈值的会话级覆盖有了写入口）→ **66**（W12：+`session.pause` / `session.resume`，暂停与继续各有自己的按钮）→ **67**（+`session.kill`，用户按杀死有了入口）→ **68**（P0：+`session.start` —— 复活从 `session.send` 的 `mayStart` 里析出来，见 §5.1）。
- **`credential.*` 删的是契约面、不是能力**：`CredentialService`、`CredentialRepository`、`<数据根>/run/token`、`agents-host token create|list|revoke` 一字未动，`Credential*` 形状只留给那三个子命令。别因为 `grep credential.* wire/methods.ts` 找不到方法名就以为能力没了（PRD L13）。
- **桥接名单 4 条**（不在 handler 表里）：`host.hello`、`host.setLanguage`、`asset.begin`、`asset.end` 由 `WsHub` 自己处理，其余 **63** 条进注入的 `HandlerTable`。理由：凭证与语言是**连接状态**；上传要按 `connectionId` 分帧落盘、断线按连接清理。分发顺序是 `hello` → 未握手拒绝 → 已知方法名校验 → 连接级方法 → 上传方法 → handler 表；表里没有的名字回 `unsupported`（`detail.reason = handler_not_registered`）。`handlers/index.test.ts` 钉住「每个方法要么在表里、要么在桥接名单里，且两边不重叠」。
- **事件** 13 个：`message.added` / `message.delta` / `message.changed` / `message.removed` / `state` / `output:paused` / `output:resumed` / `input:paused` / `input:resumed` / `error` / `session.changed` / `notice` / `question`。前四条拼出 `messages`，`state` 只说忙闲，四条闸事件各说一道闸（与 core 同名），死活走 `session.changed` 的 `agent_started` / `agent_gone`（见 §5.4），**宿主不在这之上再加聚合**：没有 `run.state`，没有 `usage` 快照／聚合事件（单条消息上的 `usage` 是另一回事，见 §5.4 那段）。
- **业务码** 14 个（`src/wire/errors.ts` 的 `BIZ_CODES`），数字码只做粗分类。
- **`message.list` 的取法**见 A12；`around` 的消费者只有桌面端（搜索命中定位），CLI 一阶段不消费。
- **`hello`**：`{ token, language?, clientInfo }`。凭证不放 URL 查询串（会进日志与进程表）；未握手的连接只放行 `hello`。成功时回协商出的 `language`、`hostVersion`、`protocolVersion`、`startedAt`、附件上限 `limits`（能力清单已删，不再回）。

---

## 7. 存储

`node:sqlite` 跑在 worker 线程里，主线程只发消息。`Database` 对外五个方法：`all` / `get` / `run` / `tx` / `close`；worker 侧开 `PRAGMA journal_mode=WAL` 与 `PRAGMA foreign_keys=ON`。

**`tx` 是声明式批次，不是「在事务里跑一段 JS」**：回调里的 `all` / `get` / `run` 只**登记**语句（拿到带下标的凭据），回调返回后整批一次性送进 worker：`BEGIN IMMEDIATE` → 按登记顺序逐条执行 → `COMMIT`，任一条失败整批 `ROLLBACK`，结果按凭据对回调用方。边界是**读到的值回不到 JS 里去决定下一条写什么**（要那样得让 worker 等主线程）；需要按读到的值分支的场合，把条件写进 SQL（PRD R19 / R31）。

**表骨架**（`storage/migrations.ts`，眼下**只有一条 `v1`**）：**表名、列名、索引名一律按 `session` 写**（`sessions` / `session_assets` / `sessionId` / `idx_sessions_*`）；**没有兼容改名的版本，也没有 v2–v6 的分版历史** —— 库里没有旧版本，结构改一次就改在那一条建表语句上。十张表：`workspaces`（`cwd` 不可变且 `UNIQUE`，**没有** `updatedAt`）、`sessions`（`agentId` / `modelId` NOT NULL、`nameIsAuto`、`thinkingLevel` 可空、`compactedAt` / `compactionMode` 可空、`pendingHandoff` 可空，四列见下）、`messages`（**六列 + 一个生成列**：`id` / `sessionId` / `seq` / `createdAt` / `payload` / `searchText`，加 `hidden GENERATED ALWAYS AS (json_extract(payload, '$.hidden') = 1) VIRTUAL`；`payload` 就是 core 的 `AgentNS.Message` 原样一份 JSON，见下；**没有** `parentToolCallId`：subagent 的话不入库，`CORE.md` §17）、`inbox`（见下）、`assets`（`sha256` 全局 UNIQUE + 宽高，**不记归属**）、`session_assets`（关系行，`assetId` 为 `ON DELETE RESTRICT`）、`asset_vendor_files`（厂商 `file_id` 缓存）、`notices`（`code` + `params` + `durationMs` + `origin`）、`credentials`、`meta` + FTS5 虚表 `messages_fts`（`tokenize='trigram'`，三触发器同步）；8 条索引。**没有 `questions` 表**：题不落库（`PRD.md` 4.10）。

**`inbox` 表**：`messageId`（主键，也是恢复时的去重键）/ `sessionId`（外键级联）/ `source` / `content` / `createdAt`（都按原样存）/ `seq`（`createdAt` 只到毫秒会撞，入队顺序单独记）；索引 `(sessionId, seq)`。

**会话行上那四列（PRD 1.4 的 11 格补齐）与分工**：`handoffThreshold` / `guardThreshold` / `autoHandoff` / `lineage`。

**那四列的分工与缺省**：

| 列 | 谁写 | 谁读 | NULL / 缺省的意思 |
|---|---|---|---|
| `handoffThreshold` | 创建时落 `null`；将来「会话设置」那道写入 | `app.ts` 的变闲那一拍（判断要不要问交接题） | `null` = 跟模型走（`models[].tokenThresholds.handoff`），常态 |
| `guardThreshold` | 同上 | `QuestionService.createSessionGuardProbe`（硬线那一跳） | `null` = 跟模型走（`tokenThresholds.guard`），常态 |
| `autoHandoff` | **创建那一刻写死**：用户建 = 0、平级会话 = 1 | `app.ts` 的变闲那一拍（开着就不问）、`createSdkAgentFactory` 的 `wantsAutoHandoff`（`AutoMigratePlugin` 的 `resolveMode` 那一侧） | `NOT NULL DEFAULT 0`：**0 = 撞线停下来问**、1 = 自己交班不问 |
| `lineage` | 创建平级会话时写（开它的那段会话的 id）；交接存档行照抄 | 开平级会话时的「只限一层」与并发限额（`SessionRepository.listByLineage`）；展示「由会话 X 创建」 | `null` = 用户建的 |

两条阈值的分工要看清：**模型上那份是出厂的数字，会话行这两列是覆盖层**。宿主的两处判定（变闲那一拍要不要问、越线探针）**现读会话行**，`null` 就退回模型那份 —— 这两处读的是库，所以改它不用重建 agent；而 agent 出厂时装的两个插件（`ContextGuardPlugin` / `AutoMigratePlugin`）拿的是装配那一刻**模型**那份数字 —— 会话行这两列**不进** agent 的出厂配置，这就是 PRD 1.4「能改且不用重建 agent」那条界线。

**`PeerSessionService` 的记录只剩可读名**：`label`（模型在 `create_session` 里起的那个名字，重启后退回会话行上的 `name`）。血缘、开关、深度、开启时刻都不再从它读 —— 血缘与开关是上面那两列，深度由血缘推（开它的那段自己带血缘就是第二层），开启时刻就是 `createdAt`。

**素材分三层**：`assets` 是**唯一真相**（一份字节 + 摘要 + 尺寸，`sha256` 全库唯一）；`session_assets` 是**谁引用了它**（归属、「几张会话引用了它」、还能不能删字节都问这张）；`asset_vendor_files` 是**缓存**（这个端点上有就直接用、换端点内联 base64、都没有才上传一次；失败就报失败，不重试 / 不判失效 / 不过期清理）。撤回 / 删会话 / 删项目由外键级联删关系行，没有谁去减计数；素材行与磁盘文件在**消息清理完之后**按引用数判：为 0 才删行再删文件（`AssetService.sweepUnreferenced`）。

**`message.list` 的读法：内存优先，死了才读库。** 这段有 agent 就从它的 `messages` 现读投影（顺序就是数组顺序，不再排 `seq`；`after` / `around` / `includeHidden` 都在数组上算），没有 agent 才读数据库 —— 这是 `A12` 那套取法在两个来源上的同一个实现。**没有「交接态」这一档例外**：交接期间也读内存，于是「它正在写的那几条」照样看得见（客户端中途连上也能一次拉全，不需要靠丢弃增量来对齐）。提交或回滚之后推一条 `memory_replaced`，客户端整段重拉即可。

**subagent 那一栏同样是内存**：subagent 的消息在它自己那个对象里，顺「它所属 agent 的名册 → 那一个 subagent → 它的 `messages`」取（`message.list { toolCallId }`）。**subagent 不入库**，所以派它的那个 agent 一死、进程一重启，名册与那些消息一起没了 —— 见 `CORE.md` §17。整个列表读取因此**只有一个来源**：活着读内存，死了读库。

**读路径上什么都不许写**：不补、不删、不修 —— 修复只在装配那一刻（`reconcile`）做。

**消息条数只有一个口径**：`listBySession`（取行）与 `countBySession`（只取数）数的是同一批行 —— subagent 的话不入库（`CORE.md` §17），`parentToolCallId` 那一列随之删掉，库不再有第二种取法。两处必须永远相等，`hidden` 默认都不算，要就显式传 `includeHidden`。

**全文检索**：`messages_fts` 是挂在 `messages` 上的外部内容表，只索引 `searchText`。两条实测约束：`unicode61` 下整段中文是一个 token（用错就搜不到）；`trigram` 的查询词至少 3 个字符，少于 3 个时 `MessageRepository.search` 走 `LIKE` 子串。

**消息只原样存一份，不拆列（2026-11-21）**：`messages.payload` 就是 core 的 `AgentNS.Message` 的本体 —— 写进去 `JSON.stringify`、读出来 `JSON.parse`，中间没有任何逐字段映射（没有 `role` / `status` / `omit` / `content` / `data` / `source` 那些列，`data` 里也没有「再摊开十个键」那回事）。**只留两格不在消息对象里的**：`searchText`（FTS 的索引产物，从正文文本段派生）与 `hidden`（SQLite 生成列，从 `payload` 里取，JS 不维护）。**没有单独的失败事实列**：那条消息自己带着 `error`（core 的 `AgentError`，与 `failed` 事件是同一个实例），跟着 `payload` 下去、跟着 `payload` 回来 —— 宿主曾经把它翻译成自己的 `ProblemFact` 再存一列，那一列从写进去那天起就没人读，而真正要被回显的 `message.error` 反而没落库。

**为什么曾经不是这样**：早先把一条消息拆成十二列 + `data` JSON，读回来时再逐个字段收窄，还养了三张枚举表给「认不出就 `Unknown`」的三条死分支站岗 —— 那三支只可能被「手改库」或「旧版本写的值」走到，两种处境这个项目都没有。拆开的代价是「一条消息两种形状」，以后 core 加一个字段就得回来改两处。

**边流边写**：运行时以内存里的消息为真相，同一条消息行按节流 upsert（整条 `payload` 覆盖，`seq` / `createdAt` 保留第一次写的值）。**崩溃恢复不归宿主**：装载时它只负责把库里的行读出来交给 agent，修不修、怎么修由 core 在进圈开头自己收拾（见 `CORE.md` §6）。**排队落地的用户消息是唯一例外**：落地那一刻就写第一笔（§5.4）。

**迁移**：`meta.schemaVersion` + 顺序迁移脚本，启动时逐级在事务里跑；不识别任何旧数据（PRD L1）。眼下只有一条 `v1`：库里没有旧版本，结构裁定（R14 / R18 这类）直接就写在那一条建表语句里。以后每改一次结构就**新增一条**（`ADD COLUMN` / 新建表），旧条目一个字不改 —— 这套表结构还没随版本发出去。

---

## 8. 接线：一条 WS 上的 JSON-RPC

**首帧 `hello`** 之后，语言挂在连接上、断开即忘；没带时用 `config.json` 的 `language`（PRD D8 / R58）。推送是 JSON-RPC 通知（无 id）：事件名放帧的 `method`，载荷直接放 `params`。

**「事件早于回包」的缓冲**（PRD R47）：`WsHub` 按请求参数里的 `sessionId` 先挂起该会话的推送，回包写完再按序放行 —— 代价是 `message.list`、`session.abort` 这类同会话请求也会短暂缓冲同会话事件（认这个口径：按会话挂起比按方法枚举更简单，也不漏分支）。

**多语言渲染点**：入库存「码 + 参数」（PRD §8），出网前按**这条连接的语言**重渲染 —— 事件走注入的 `localizeEvent`（`NoticeService.createEventLocalizer`，覆盖 `notice` 与 `question` 两类）；handler 的出参走 `context.connection.language`。

**上传**：三段式 —— `asset.begin`（JSON，返回 `uploadId` 或「已经有了」）→ 若干二进制帧 → `asset.end`（校验总长与摘要后落定成正式素材）。`begin` 带 `sha256` 时先问「库里是不是已经有这份字节」：命中就回 `{ deduped: true, uploadId: null, asset }`，不建临时文件、不分配 `uploadId`；去重是全局的（按摘要，不分会话）。单张 20MB 上限，超限在 `begin` 就拒；中途断开按 `begin` 记的临时文件清理。二进制帧格式见 PRD §4（`encodeChunkFrame` / `decodeChunkFrame` 是唯一一份实现，客户端复用）。

**取回**：`asset.get { assetId, variant? }` 回 base64；客户端按「段上有没有 `__asset_id`」决定要不要走这条路，不解析任何 url scheme。

**数据根**（`AI_ZEN_DIR`，缺省 `~/.ai-zen`，可被环境变量改）。`HostPaths`（`config.ts`）给出库、附件、运行期目录、发现文件、凭证文件、两份配置文件与日志目录；`config.json` 交给 SDK 的 `ConfigManager`，`host.json` 是宿主自己的设置（端口那一档）；`agents/ sub-agents/ skills/ tools/ mcp-oauth/` 与 `mcp.json`、`reasoning-presets.json` 由 `ConfigManager` 在其 `basePath`（= 数据根）下推导与释放：

```
<数据根>/
├── ai-zen.db              全机一个库
├── assets/                上传临时文件与正式素材
├── config.json            配置唯一真相（ConfigManager 以它为边界）
├── host.json              宿主自己的设置（端口那一档）
├── logs/                  一格一个进程：host/host.log（+ 轮转 .1…）、cli/{cli,launch,keys}.log
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

**升级**（需求见 PRD 3.8 / 4.12：**远端也要能升**，本机与远端同一条路）：宿主不自装包、不 re-exec（PRD 2.2 硬规矩），它只做「验目标版本 → 记 pin → 安排收尾」，拉起归启动方式。三段分工：

| 段 | 谁 | 干什么 |
|---|---|---|
| ① 挑版本 | 客户端（`npm view`） | 全部 dist-tag 里取 semver 最高的那个。纯网络查询，与宿主在哪台机器无关，所以留在客户端 |
| ② 验 + 记 + 请重拉 | 宿主 `HostApp.upgradeHost` | 两条判据（见下）验「这一版拿得到」→ 写 pin → 以 `reason: "upgrade"` 退出 |
| ③ 拉起 | **启动方式** | 读 pin，`npx -y @ai-zen/agents-host@<pin> serve` |

两条判据，各自答得出谁会走到：

1. `readDiskVersion() === target`：磁盘已经就地换过 —— 桌面端（`spawnHostEntry` 起的是应用安装目录里那份）、docker 换镜像、`npm i -g`。**这一条是现在的行为，保留**。
2. 否则问 registry（node 内置 `fetch`，不引依赖）：`@ai-zen/agents-host` 的 `versions` 里有这个号就算成立。走到这条的是 **npx 拉起的宿主** —— 它自己那份 `package.json` 在 npx 缓存里，一版一格（实测 `~/.npm/_npx/<hash>/` 里 alpha.3 / .5 / .6 / .7 各占一格），原地永不变化，判据 1 在它身上永远不成立。
3. 两条都不成立 → `not_available` + 原因，**不退出**。这是唯一能把「这一版压根不存在 / 现在查不到」挡在弄死远端服务之前的地方。

pin 与退出信号必须分开，理由各一条：

| 物 | 落点 | 为什么不能用另一个代替 |
|---|---|---|
| **pin** | `<数据根>/run/next-version.json`（持久记忆，客户端与启动方式都读） | 它答的是「这台部署下次该跑哪一版」，不是一次性动作。`run/` 是宿主与启动方式的交接处，`host.json` / `token` 已经在那儿 |
| **信号** | `ExitReason` 加 `"upgrade"`（眼下只有 `"requested"`），`defaultExit` 按它给专属退出码 | 只有 pin 的话，一次 `/shutdown` 之后 supervisor 会照着老 pin 把服务又拉起来，「关就是关」就不成立了 |

客户端那一半：`/upgrade` 删掉本机的 `npx` 预下（`npm.ts` 那半只留查询）与 `cli/host-version.json` 那一格，`connectHost` 改读 `run/next-version.json` —— 一个事实一处落点。远端敲 `/upgrade` 的顺序因此与本机一字不差：查 → 比 → 交宿主 → 宿主记 pin 并退出 → 连接屏等重连（远端要等启动方式把新版拉下来，屏上给「重试」，不自动轮询）。

**认这个代价**：① 远端升级失败（拉不下来 / 探测通过之后断网）→ 远端起不来，只能运维上那台机器；`fetch` 那条探测挡不住「探测之后网断了」。② 远端要有 npm —— npx 起的宿主本来就有。③ 远端 `/shutdown` 之后不会被拉起，保持「关就是关」。

启动后还有一道低频自检（30s、`unref`）比一次磁盘版本（R66）；回退不算升级。

**待拍**：③ 那条「读 pin 重拉」是我们给（新增 `agents-host up`：读 pin → `npx` 拉 → exec 它，自己不服务；远端 unit 一行 `ExecStart=… agents-host up`），还是只出文档、让运维在 unit 里拼。倾向前者 —— 远端要能升级，就意味着这条启动路径是产品的一部分，不该留在配置里。

---

## 9. SDK 边界

| 归谁 | 内容 |
|---|---|
| `@ai-zen/agents-core` | `Agent`、流式 `applyChunk`、消息与工具调用结构（`Message` / `MessageContent` / `ToolCall` / `Delta` / `Usage`）、中止修复（`reconcileAbortedToolRounds` / `reconcileAbortedMessages`）。**它自己要保证什么见 `CORE.md`**，本表只划归属 |
| `@ai-zen/agents-sdk` | `Scope`（能力装配）、`allInOne` 五类插件（内置工具 / 用户工具 / Skill / MCP / subagent）、`PeerSessionsScopePlugin`、`ConfigManager`、`createAgent` / `SdkAgent`、`HandoffService`、各插件的 `discover*`、出厂 Skill 与思考策略表、`fileToContentSection` |
| `@ai-zen/agents-client` | 「确保有一个能连的宿主」：`ensureHost`（有就上、没有就拉）、`spawnHostViaNpx`、`Client`（连接 / 调用 / 事件分派 / 补拉 / 重连）、`settings`、`resume`、`upload`。它不知道自己被谁用，也不画任何界面 |
| 宿主 | 进程与接线、凭证、Workspace 与会话的生命周期、Scope 的持有与回收、持久化、i18n 文案、通知与问题对象、上传 |

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
| 投递入口 | `ChatRunner.deliver` | **只做入队一件事**：判两件（目标在不在、活不活）→ 入队；回执只有收下 / 被拒（§5.1 的 P0） |
| 复活入口 | `ChatRunner.start`（`session.start`） | 确保这段有 agent：草稿先 `ensurePersisted` → `acquire`（复用或装配）；活着就是幂等 no-op。**投递不会叫醒任何人** |
| 装配期缓冲 | `ChatRunner` 的 `assemblingBuffers`（并进常驻桥 `SessionBridge`） | agent 还没就位时先收着，装好按到达顺序一次推 —— 不等待、没有超时 |
| 取件点 | `packages/core/src/Agent.ts`（`runLoops()` 内循环末）+ `Inbox.ts` | `high` 先取、`!needContinue` 才问 `low`；落地成 `Message.User` 并加来源注释 |
| 落地即写库 | `ChatRunner.ts:1804-1821` | `persistLandedQueued`：先写行再 `linkQueuedAssets`，`createdAt` 取落地时刻 |
| 来源注释 | core 的 `inboxEntryContent` | 落地那一刻统一生成；宿主没有第二个拼装点（也没有第二份内容） |
| inbox 回显 | `agent.inboxPending` → `wire/states.ts` 的 `InboxItem` | 现读，不存镜像；条数取证 |
| 四件事 | `AgentRegistry.get(id)?.state` + 两道闸 + 有没有那个对象 | 忙闲读 `state`、两个闸各现读一个开关、死活看对象在不在。不落库、不是字段、不推算 |
| 变闲那一刻 | `ChatRunner` 的 `onIdle`（订的是 core 的 `state:idle`）→ `app` 的那一个判断 | 全宿主唯一一处：先看会话行上有没有待交接，再看要不要问交接线、要不要起名字 |
| 历史只有一份 | `ChatRunner.run()` 的二分 + `attach` | 有 agent 就从它内存里取，首次装配才读库 |

**旧形状已全部拆掉**（W2 落地）：`run` / `enqueue` 两条受理路合成 `deliver`、助手占位行没了、`DeliveryOutcome` / `settle()` / `TurnSettledFacts` / `RunState` / `run.state` / `usage` / `RunRegistry` 全都不存在。`SessionBridge` 是这一段会话的常驻桥（订在 agent 上，`retired` / `killed` 才灭）。

### 10.2 平级会话

| 条 | 落点 | 一句话 |
|---|---|---|
| 建（F-C16） | `packages/host/src/services/PeerSessionService.ts:286-373` | 建会话 → `ensurePersisted` → 投第一条 → 立刻回 `{ sessionId, label }`（不等结果） |
| 认人 | `PeerSessionService.ts:256-258` | `bind(agent, sessionId)` 记一笔 `WeakMap`：只用来填来源名，不参与判断 |
| 模型解析失败的识别 | `PeerSessionService.ts:636-647`（调用点 `:328`） | 只看码不看文案，于是「拿不到模型」是结构化拒绝而不是抛错 |
| 问（F-C17） | `PeerSessionService.ts:381-392` | 现读 agent 那一格 + ~300 字摘要，**不给全量消息** |
| 发一句（F-C20） | `PeerSessionService.ts:538-551` | 一次投递；**不校验血缘**，回执只有收下 / 被拒 |
| 工具面 | `packages/sdk/src/scope/plugins/peers/peerSessionTools.ts`、`PeerSessionsScopePlugin.ts:22-45` | 形状与用例归 SDK；宿主实现端口，**SDK 不依赖 host**。发话的工具就叫 `post_message`（`send_to_session` 已删） |
| 不问交接 | `app` 的变闲判断 | 看的是**会话行上的 `autoHandoff`**（创建时写死），**不看来源** |

**旧形状已全部拆掉**（W3）：`settleTurn`、`onTurnStart`（记录复位）、`resultDelivered`、`rejectionOf`（血缘拒绝）都不存在；**W10 之后进程内只剩一个可读名**（`label`）—— 血缘（`lineage`）、自动交接开关（`autoHandoff`）、开启时刻（`createdAt`）是会话行上的列，状态一律现读。并发限额保留，判据是「按血缘列反查封出来的那批」里现读 `busy` 的个数。

### 10.3 Scope / Agent / 配置生效 / 退出

| 条 | 落点 | 一句话 |
|---|---|---|
| Scope 公开面 | `packages/host/src/runtime/ScopeRegistry.ts:174-192`（create / get / workspaceIds）、`:219-236`（refreshWorkspace）、`:246-267`（dispose / disposeAll） | 只有这六个方法；没有任何空闲计时 |
| Scope 拒绝级联 | `ScopeRegistry.ts:110-123` | `ScopeBusyError` 带 `sessionIds`，撞上活着的 agent 只拒绝 |
| agent 存活策略 | `packages/host/src/runtime/AgentRegistry.ts`（`acquire` / `complete` / `kill` / `killAll` / `invalidate` / `invalidateSession` / `disposeAll`） | 「该不该活着」只有这一处；两个只读观测口（`get` / `sessionIds`） |
| 生命周期理由闭集 | `AgentRegistry.ts:109-117` | `AgentLifecycleReason` 的七个取值；`onLifecycle` 只是观察 |
| 配置就地刷新 | `app.ts:1335-1360`（`refreshScopesFor`）、`:1309-1320`（`createApplyPort`）、`packages/sdk/src/scope/Scope.ts` 的 `refresh` | 刷已存在的 Scope + `invalidate`，**不拆任何 Scope** |
| 换模型 / 换思考档位的退役 | `AgentRegistry.ts`（`invalidateSession`）、`SessionService.ts`（`setModel` / `setThinking` 里的 `assertIdle` + `runtime.invalidateAgent`） | 只允许空闲时改；改完当场让这一段空闲的 agent 退役 |
| 关闭宿主 | `app.ts:862-905`（`doStop`） | 只有显式关闭这一条路（`host.shutdown` 命令 + 二次确认）；收尾把 Scope 与 MCP 一起拆。`checkExit` / 连接数回调那两个入口**作废** |
| 压缩归一（F-D11） | `storage/migrations.ts:206-223`、`ChatRunner.ts:3220-3232`、`app.ts:1110-1115`、`services/HandoffDocumentService.ts`（`settleAutoHandoff`） | 派生会话自己压（`auto`）；用户会话在变闲那一刻问；只产文档不记 `manual` |

### 10.4 服务与存储

| 条 | 落点 | 一句话 |
|---|---|---|
| 会话草稿落库 | `packages/host/src/services/SessionService.ts:409-430` | `ensurePersisted`：写行 + 那条 hidden 的 cwd 消息，并发去重 |
| 运行时端口 | `SessionService.ts`（`SessionRuntimePort`）、`app.ts`（`createSessionRuntime`） | 四件事 + 队里几条（`presence()` 现读）、`forget`、`agentState`、`invalidateAgent` |
| 侧栏摘要 | `SessionService.ts:766`（`toSummary`） | 主线条数 + 四件事 + inbox 条数 + 助手可用性 |
| `message.list` 的 `around` | `packages/host/src/services/MessageService.ts:337`（`AROUND_WINDOW = 40`）、`:388`（`list`） | 命中不在可见集就回空页 + `anchor: null`，不报错 |
| 两个条数口径 | `MessageRepository.countBySession` / `listBySession` | 只取数 / 取行，两处必须永远相等 |
| 搜索下界 | `MessageRepository.ts:318` | `< 3 字符`退化 `LIKE`；`total` 是下界 |
| 素材落定与清理 | `services/AssetService.ts:242`（`finalizeUpload`）、`:309`（`linkMessageAssets`）、`:420`（`resolveHistory`）、`:669`（`sweepUnreferenced`） | 归一真相 / 记关系 / 按当时模型还原 / 归零才删 |
| 声明式批次 | `storage/Database.ts:162` | `tx` 只登记语句，整批在一条 worker 消息里执行 |
| 换记忆（交接提交点） | `storage/SessionRepository.ts`（`replaceMemory`）、`services/HandoffDocumentService.ts`（`commitMemory`） | **新记忆长什么样由 SDK 的 `planMemory()` 算**（模板 + 断点，`PRD.md` 4.5）；宿主这一行只落库：一个 `tx` 插存档会话行 + 搬消息行（含素材关系行）+ 按 SDK 给的那份写回；内存原地换成同一份 |
| 迁移（眼下只有 v1） | `storage/migrations.ts` 的 `MIGRATIONS` | 一条建表语句就是全部现状（v1–v6 的分版历史已合并）；以后每次结构改动新增一条，旧条目不改 |

### 10.5 接线

| 条 | 落点 | 一句话 |
|---|---|---|
| 桥接名单 | `packages/host/src/handlers/index.ts:76` | 4 条连接级方法不进 handler 表 |
| 推送缓冲与语言 | `packages/host/src/net/WsHub.ts:146`（`localizeEvent`）、`:349-361`（推送前重渲染；连接数变化只用于观测，不参与任何收尾判断） | 按 `sessionId` 挂起，回包写完放行 |
| 二进制帧 | `packages/host/src/net/UploadReceiver.ts:483` / `:498`、`:329`（`abortConnection`） | 编码只有一份，断线按连接清理 |
| 路径与端口 | `packages/host/src/config.ts:21`（`HostPaths`）、`:146`（`resolveListenTarget`）、`:214`（`readHostSettings`） | 数据根只有一个来源；端口三档 |

---

## 11. 波次

| 波 | 目标 | 状态 |
|---|---|---|
| **P0 接口正交** | 四个动作各管一件事（§5.1）：`mayStart` 作废，复活析成 `session.start`，`deliver` 只剩入队；复合动作（复活 → 开闸 → 投递）由客户端编排。接口面加 `session.start`（67 → 68） | ✅ 完成（`3a6fc4b` 契约与运行时、`4f000a2` e2e） |
| **W1 契约补齐** | 用户裁定的契约面 12 条落进 `wire`（`AgentView.messages/function`、`agent.restoreFactory`、`setThinking(null)`、MCP 传输字段与 `extra`、`saveMcp`/`deleteMcp`、`DiscoveryLayerView.scope`、阈值可选、`message.list(around)`、删 `host.usage` 与 `credential.*` 的 wire 面、保留 `upgrade`/`shutdown`、图片模型不补恢复出厂） | ✅ 完成 |
| **W2 CLI 收口** | `npx` 现下现起 + 下载屏 + `/ws` + `/shutdown` + 命令集增删；同批发 `agents-host@0.1.0-alpha.1` | ✅ 完成 |
| **W3 归档与文档** | `cli-old` 降级为只读归档、旧包名清干净、文档跟上新契约 | ✅ 完成 |
| **W4 桌面端完整问答视图**（PRD 3.9） | `question.*` 在 `desktop/packages/main` 已接上（`chat.questions` / `chat.answerQuestion`）；还差整块视图：问答面板 → 完整视图 → 22 项零入口 → 体验欠账，以及真 GUI 竖切六步（连上 / 流式 / 作答交接问题 / 撤回 / 搜索命中并定位 / 置顶） | ⬜ 未开始（优先级最低） |
| **W6 运行期可输入与重开回看** | 跑中发送进 inbox、投递回执、inbox 条数进运行状态、重开后子代理页签、会话列表带运行状态；客户端侧运行中输入与 `/sessions` | ✅ 完成 |
| **W7 平级会话阶段 1** | `create_session` / `read_session_status`、建完即回（其中「结果投回并唤醒发起者」已被 PRD 4.6 判死，见 §14） | ✅ 完成（回投那半已废） |
| **W8 agent 常驻与投递收口** | agent 常驻跨轮复用、Scope 去空闲回收、配置改成就地刷新、投递收敛成一个入口、平级会话进阶段 2 | ✅ 完成 |
| **W9 文档收敛** | 四份 docs + SDK 设计文档 + 四份计划草稿收敛成仓根 `PRD.md` + `PLAN.md`；`R1–R79` 补回 PRD；7 处代码注释与 8 处链接改指新文档 | ✅ 完成（本轮） |
| **W10 平级会话阶段 2** | 编排元数据落到会话行（`lineage` / `autoHandoff` / `createdAt`），进程内只剩 `label` 一个可读名 | ✅ 完成 |
| **W11 素材引用去 base64** | 引用改成内容段上的本地扩展字段 `__asset_id`（不再往 `image_url.url` / `file.file_id` 里塞 `asset://`），素材全局去重、关系行随消息落库 | ✅ 完成 |
| **W12 本轮重写** | 题进内存（不落表）、判断收一处（四个拒因）、交接期间不收件、`session.pause`/`resume`、记忆形状只在 SDK 一处算（400 字节 / 断点 / cwd 只在创建时）、inbox 三事件恢复、`applyChunk` 只吃 `AgentNS.Delta`、删 `seq` | ✅ 完成 |
| **W13 远端升级**（PRD 3.8 / 4.12） | 宿主：`upgradeHost` 两条判据（磁盘就地换过 / registry 有这一版，后者用内置 `fetch`）+ 写 pin `<数据根>/run/next-version.json` + `ExitReason` 加 `upgrade` 与专属退出码；客户端：`/upgrade` 删本机 `npx` 预下与 `cli/host-version.json`，`connectHost` 改读 pin；启动方式：读 pin 重拉（我们自己给 `agents-host up`，还是只出文档 —— 待拍，见 §8 升级） | ⬜ 未开始 |
| **W14 注释治理** | 六个包逐包核实注释：假话按事实改、无法核实的删、规定性断言删、交叉叙述收成一处（判据见 §14） | ✅ 完成（`0511118`–`c9f7f22`：168 个文件，`core 153` / `sdk 742` / `host 890` / `client 141` / `logger 16` / `testing 7` + host e2e 9 全绿，diff 只有注释行） |
| **W15 冗余转换治理** | 扫「同一份数据两个形状 + 手写字段清单在搬运」：消息已改成 `payload` 原样（`190a4a5`）；其余逐处核过（判据见 §15） | ✅ 审核完成 —— **一处不改**：显式白名单 / 形状冻结 / 回写安全 / 配置缺省策略都有设计目的，清单留档 `.ai-zen/reports/20261121-冗余转换审计.md` |

**并行规则**：同波次里两个 agent 的目录不重叠才能同时派；跨目录要改别人的文件先报。

---

## 12. 欠账清单

| 欠账 | 现状 |
|---|---|
| subagent 消息回看（PRD F-I7） | **不是欠账，是结论**：subagent 的消息不入库（`CORE.md` §17），`message.list { toolCallId }` 走内存（`ChatRunner.messagesOf`）；`messages.parentToolCallId` 那一列一并删掉，库里不再有第二种取法 |
| 客户端自造问题 | 契约只有 `question.list` / `question.answer`；问题由宿主内部产生（交接线 / 二次确认）。集成用例因此绕开契约直开库造一行 |
| 平级会话阶段 3 | **✅ 已完成**（`2c7f788`）：`session.list` 给个派生的 `createdBy: "user" | "agent"`（从 `lineage` 派生、不落库），客户端不用自己解释 `lineage === null`。**没有「超时」这回事**（PRD 4.4：生死全手动、没有超时；这一格是旧计划的残留，已删）。`/sessions` 那条命令在 TUI，本仓没有 TUI 包。**「补投」不再是欠账**：会话间通信只有投递（PRD 4.6）。**「跨重启的孤儿」半条出列**（W10）：血缘与会话本身的身份落到了 `sessions.lineage` / `autoHandoff` 上，重启之后仍认得它与谁开的它；**没有** `peer_sessions` 那张表，也不再需要 |
| 「该说而没说」的提示 | 宿主词典里那批零产出文案已删，但它们对应的提示本身仍是需求缺口（PRD Q11）：删会话 / 删工作区之后确认一句、撞硬线、撤回之后、subagent 结束、附件超限…… |
| 测试规模的口径 | 默认套件是一个文件一个库 + 一次 `tx` 清表；新增碰库的用例照这个形状写，否则单条用例要付 55ms 的建库钱 |
| **日志治理**（一格一个进程 / 日志与通知「限定耦合」/ SDK 去全局 logger） | **✅ 已完成**（2026-11-20，`9181d9b`–`73a0c29` + cli 的 `35e5bbe`）。**改前**：两端都把 `warn` / `error` 顺手推上通知栏（`Logger.raiseNotice`、`cli/src/sdk-log.ts` 的 `deliver`），靠一个 `notifying` 重入标记才不打架；服务端进程里 SDK 那 23 处 `getLogger()` 没人接管 → 走 `console` → 落进客户端 spawn 的 `logs/host-launch.log`，而那个文件每次拉起都清空。**改后（已落地）**：**一个进程一格目录**（`logs/host/`、`logs/cli/`、将来的 `logs/desktop/`）；**日志仍然默认转通知，但环路靠来源字段断**（通知模块注入 `source: "notice"` 的 logger，带这个来源的记录不转发，`notifying` 布尔位删掉）；**日志转发来的通知不持久化**（`origin: "log"` + `persist: false`：不入库、不重放，客户端在用户发送那一刻清掉）；写流由独立包 `@ai-zen/agents-logger` 提供（`packages/logger`：零运行时依赖、一实例一文件一轮转、不读 env、不持单例、不写 stdout、**不带级别开关**——实测生产代码零传值）。落点：`logs/host/host.log`、`logs/cli/{cli,launch,keys}.log`。细节见 `.ai-zen/pending/20261120-logging-governance.md` |
| 定时器（PRD 4.4） | **需求已定、实现为零**：只做「往 inbox 投递」—— 能吵醒本来就活着的会话（闲不闲无所谓），不能造、不能复活。宿主里除 30s 那个 `unref` 版本自检以外没有第二个定时器；§5.1 那张投递来源表里的「定时器」还只是写法 |
| 明确不动（别再拿「本仓没人读」当理由） | core 的 `started` / `requestSent`（`Agent.ts:610` / `:1195`）、sdk 的 `onBeforeHandoff` / `onHandoff` / `handoffDir`（`HandoffService.ts:139` / `:119`）、client 的 `snapshot()` / `toMirrorEvent` / `mirror()`（`client.ts:403`、`mirror.ts:73` / `:241`）—— 形状没问题，本仓暂时不用不等于该删。「`@ai-zen/async-queue` 一个字不动」这句**已经过期**：队列按 `CORE.md` §13 加过 `takeAll` / `asTakeAll` / `clear`。另有一条没拍板的想法：给它加**插队**（某一条越过已排队的先被取走），2026-11-18 提的，只到「可以考虑」 |

---

## 13. 验收与门禁

每条都跑，不许减项：

1. `npm run pretest`（`tsc --noEmit -p tsconfig.test.json`）零错误。
2. `./node_modules/.bin/vitest run` 全绿；**失败不许用 `.skip` 换绿**，要么修好要么删掉并说明。当前基线（2026-11-20 实跑）：`packages/host` **890 passed / 55 文件**、`packages/logger` **16**（1 文件）、`packages/sdk` **742**（58 文件）。
3. 真进程竖切跑通（不是只有单测绿）：`npm run test:e2e` 的两条真子进程 + 真 WebSocket 用例。
4. **不必要性审查**：新增的每个可选入参、可空返回、防御分支，都要答得出「哪个客户端的哪一行会走到」；答不出来就删。
5. 文档同步：改了行为就改 `PRD.md` / `PLAN.md` 的对应条目，不许文档落后于代码。
6. 测试安放：一个事实只在一处断言（表结构归 `migrations.test.ts`、`tx` 边界归 `Database.test.ts`、契约语义归 `*Service.test.ts`、SQL 独有行为归 `*Repository.test.ts`、接线归 `WsHub.test.ts`、真进程归 e2e）。同一件事在两层都断言，删掉弱的那一份。
7. 删用例的判据是必要性：生产代码零调用者的方法连用例一起删（留着给假安全覆盖）；被测对象根本拿不到的依赖不要摆进夹具。
8. 按 `AGENTS.md` 第 7 条：**提交但不推送** —— 每完成一部分就提交（一个主题一个提交，中文 conventional commits，正文写「改前 / 改后 / 为什么」）；但不执行 `git push` / `rebase` / `commit --amend` / `push --force`，推不推只由用户说。
9. **措辞禁用词**（注释、命名、文案、提交信息一律不许出现）：`consumption`、`gate`、`hold/release`、`suspend/resume`、`once` / `busy` 当状态值、`queued`、`run.state`、`usage`（快照）、`settle`、`回投`、`conversation` / 「对话」/「兄弟会话」/「驱动者」/「待办」/ `mayStart`；也不许把「一次运行 / 一次回答」说成「轮 / 段 / 圈」（工具轮次 `ToolRound` 除外）。
10. **跨包改签名后重建 `dist`**，顺序 `core → sdk → testing → client → host`；`cli` 走 `link:` 消费这些 `dist`，不重建它手上就是老名字（表现为运行时炸掉或超时）。

---

## 14. 专项：注释治理（W14）

**一句话**：注释里不许有假话，不许把同一件事讲两遍，不许立规矩。

| # | 判据 | 处置 |
|---|---|---|
| 1 | 事实断言与代码 / 用例不符（路径、方法名、字段、行为、谁调谁、边界值） | 按事实改 |
| 2 | 断言无法核实 | 删 |
| 3 | 规定性断言（「永不…」「一律…」「只能…」「不支持…」） | 删 —— 规矩只能由真人写进 PRD / PLAN（`AGENTS.md`） |
| 4 | 同一件事在好几个文件各讲一遍（交叉叙述） | 留离实现最近的那一处，其余删掉或缩成一句指路 |
| 5 | 改前 / 改后、谁曾经怎么想、删了哪个旧设计 | 删（git 历史里有）；只有「读这段代码必须知道的那条约束」才留 |
| 6 | 解释「为什么这么写」的短句、不明显的取舍、外部协议与厂商的怪癖 | 留 |

**范围**：`packages/{core,sdk,host,client,testing,logger}/src` 下的 `.ts`（含用例里的注释）。一格一个执行者，包与目录不重叠。

**不许碰**：任何代码行（`git diff` 里出现非注释行改动就是越界）、测试断言、`docs/`、README、`AGENTS.md`、`PRINCIPLES.md`。注释与代码打架时**报上来**，不擅自改代码。

**验收**（每包都跑）：`tsc --noEmit -p tsconfig.test.json` 零错误、`vitest run` 全绿、`prettier --check` 通过。

---

## 15. 专项：冗余转换治理（W15）

**一句话**：能直接给原始数据就直给；每多一份字段清单，就多一份会过期的真相。

**病的样子**（`messages` 就是这么病的，`190a4a5` 治完）：同一份数据存在两个形状（库行 ↔ 内存对象、内部对象 ↔ 契约视图），中间靠一份手写字段清单来口搬运 —— 存进去拆一遍、读出来拼一遍，以后加一个字段要回来改两处。

| # | 判据 | 处置 |
|---|---|---|
| 1 | 一侧的字段在另一侧**没人读**，只是搬过去再搬回来 | 用原始数据直接过（JSON / 透传），不留逐个字段搬运 |
| 2 | 字段清单里的每一行答不出「不搬会怎样」（例：存了但从不查询、从不单独更新、从不单独展示） | 不搬 |
| 3 | 搬运途中「认不出就降级 / 缺了就补缺省」的分支 | 删（同一个病：为不可能的处境兜底） |
| 4 | 转换函数名把方向说反 / 两侧形状同名不同义 | 改名：说清「从什么到什么」 |

**合法的转换只有两种**（各自要能指到具体一行）：

| 种类 | 什么时候成立 | 例子 |
|---|---|---|
| **要查询** | 这一侧要在 SQL 里 `WHERE` / `ORDER BY` / 建索引 / 做外键 | `messages.seq` / `createdAt` / `searchText`、`sessions.pinned`、`sessionId` 外键 |
| **两边各有独立消费者** | 契约视图与内部对象**不是逐字段一一对应**：有裁剪、合并、渲染、或者附带两个形状里都不存在的派生命 | `SessionSummary`（四件事现读现拼）、`DiscoveryEntryView`（MCP 条目摊开给人看） |

**不属于本专项（别当借口动）**：

- 多语言那层（存 `code` + `params`、出网前按连接的语言重渲染）—— 那是**需求**（PRD D8），不是搬运。
- 引擎原样形状（`message.delta` 带 `AgentNS.Delta` 原样、`message.changed` 带完整消息对象）—— 已经是对的方向。

**范围**：`packages/{host,client,sdk}/src`。扫的顺序：先库行 ↔ 内部对象（`storage/*Repository` 的 `toXxx` / `fromXxx`），再内部对象 ↔ 契约视图（`services/*` 的 `toView`），最后 client 的镜像与缓存（`mirror.ts` / `reconnect.ts`）。

**审核结果（2026-11-21）：一处不改。** 四路扫完整仓，报了 40 多条候选，分诊后全部有设计目的 —— 显式白名单（上游加字段不会悄悄漏出去）、形状冻结（MCP 规范升级不动 `load_mcp` 吐给模型的那份）、回写安全（认不出的键原样带回，否则一次编辑就抹掉用户的字段）、配置缺省策略（不是数据搬运）。清单与逐条理由见 `.ai-zen/reports/20261121-冗余转换审计.md`。**下次谁想重开这一专项，先读那份报告，不要从头扫一遍。**

**审核阶段只出清单、不改代码**：一条候选要给出「两个形状在哪」「字段清单在哪一行」「哪几个字段答不出判据 2」。分诊后再改。

---

