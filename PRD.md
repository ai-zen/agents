# 宿主 PRD —— 需求与决策的唯一来源

> 本文件是 `packages/host` 的**需求与决策**唯一来源：能力项 `F-##`、锁定决策 `L##`、问答决策 `D##`、裁定 `R##`、自决与待核、契约口径、「没做」清单。
> 怎么搭、先做什么、落点在哪个文件的哪几行 —— 见 `PLAN.md`（结构 `A##`、波次 `W#`、落点表、欠账）。两份冲突以本文件为准。
> **core（引擎）不在本文件**：它的需求与机制见 `CORE.md`（边界、双循环、五个动作、三格状态、事件与钩子、队列改造）。本文件只管宿主。
> 需求来源：`cli-old-archive`（已归档、只读、冻结在 tag `pre-split-20261111`），只作形态参照，不作实现依据；仓库里的旧 `.md` 也不作依据。
> 性质：`L##` / `D##` 是**人的决策**，AI 不改写；`R##` 是逐轮裁定（编号被代码注释引用，**不能改号、不能改含义**）；标注「自决」的是 AI 的拆法，用户随时可否决。

---

## 1. 产品是什么

一台电脑上常驻一个后台服务（**宿主**），承载「一段段对话」：知道每段说到哪儿、存在哪里、属于哪个项目，也管着这个项目能用哪些技能、工具、MCP、模型。用户关窗口、换前端、换设备连回来，看到的是**同一段对话、同一份历史**。

它说人话（错误原因、提醒、状态说明）并**自己做多语言**；同时把事实以结构化形状给出，不让前端解析句子猜原因。**宿主给能力，客户端给交互**。

两个「CLI」不是一回事，本文件不混用：

| 名字 | 是什么 | 跑在哪一侧 |
|---|---|---|
| **host CLI** | `agents-host` 二进制本身（`serve` / `token create\|list\|revoke` / `version`）。开库直接用，不跑一轮对话 | 宿主侧（同一台机器的管理口） |
| **TUI CLI** | 终端里的交互界面（Ink 那套，需求来源 `cli-old-archive`） | 客户端侧（一条连接的另一端） |

本文件说「客户端」指 TUI CLI 与桌面端两者；说「宿主」指那个进程。

旧 `packages/host` 的实现与它注释里的 97 条决定**一律作废**：不作需求来源、不作约束、不作参考，任何「代码里已经这么写」的论证一律无效。

---

## 2. 锁定决策（L1–L14，不重开）

| # | 决策 |
|---|---|
| L1 | **远程是一等场景**；不做兼容、不留余地：旧前端不保、旧目录旧代码全删、旧数据不迁移不识别；宿主、契约、前端同一版发布 |
| L2 | **对话存 SQLite**；二进制素材落数据根下的 `assets/`，库里只存引用。数据只有一个落点＝**一个数据根**（库 + assets），不是单个文件 |
| L3 | **提醒：手动清 + 持久化**；创建时带**持续时间**——给秒数到点消失，不给则永久（只能手动清） |
| L4 | **对话寿命不跟连接走**：对话、Scope、agent 都不因空闲被回收（没有空闲计时器，也没有「谁在用」这本账）；一段对话一个 agent、常驻跨轮复用（D28）。退出判据只有一条：**最后一个客户端连接断开且没有在跑的轮次**（D37） |
| L5 | **重连由客户端主动拉**（拉状态 + 按消息 id 拉消息，含流式中那条的部分内容）；**在线时宿主推送**，两者并存 |
| L6 | **id 一律宿主分配**；助手消息的 id 在请求发出**之前**分配 |
| L7 | **项目与助手创建即定；模型与思考档位在会话级、可改、持久化**：属于哪个项目、用哪个助手创建时定死；这一段用哪个模型、哪一档思考存在会话行上，改了落库；要改「以后的对话」就去改助手定义 |
| L8 | **生成状态必须完整**：连上 / 等首字 / 在想 / 在输出 / 在拼工具调用 / 在等哪几个工具 |
| L9 | **MCP 是 5 层链**：`<ws>/.mcp.json` → `<ws>/.ai-zen/mcp.json` → `<ws>/.agents/mcp.json` → `<aiZenDir>/mcp.json` → `~/.agents/mcp.json` |
| L10 | **不做 `Origin` 白名单** |
| L11 | **凭证靠复制 + 手动输入**；**可以有多串**（创建时带备注，权限相同，可单独吊销） |
| L12 | **不做账号 / 登录 / 按人分权限**（设备不是人；凭证多串不算破此条） |
| L13 | **凭证只归宿主**：宿主自己管理凭据、决定哪些凭据能访问宿主；**客户端只有「连接管理 + 记住密码」**。故「创建 / 列出 / 吊销凭证」是宿主侧管理动作（`agents-host token *`），不是客户端能调的接口 |
| L14 | **本机模式靠 `npx` 现下现起宿主**：能用 CLI 的地方一定有 npm，本机宿主不必预装。CLI 在自己的 `devDependencies` 里声明宿主的 **semver range**，构建时注入产物，运行期按它拉「满足范围的最新版」 |

---

## 3. 问答决策（D1–D38）

| # | 决策 |
|---|---|
| D1 | **会话有独立名字字段**（id 永不变、宿主分配），用户可改名 |
| D2 | **自动命名**：第一轮结束后、用户未改过名字则自动起名；带独立开关；用「取名模型」配置项；**原名＝创建时间**，起不出名就保持原名 |
| D3 | **临时对话**：一次请求跑一轮、结果返回后内存清空；无 id、不可 attach、不入库、不进列表；**只借 Scope，与 Workspace 无关** |
| D4 | **升级**：宿主检测版本号，确认磁盘上的版本已更新就**立即重启**，不等在跑的轮次；宿主不自装包、不 re-exec |
| D5 | **图片**：宿主提供上传入口；上限 20MB/张、4 张/条；**同一张图全机只有一份**（`assets.sha256` 全局唯一，第二次上传在 `asset.begin` 就回既有引用）；消息里只记我们自己的引用——内容段上的本地扩展字段 `__asset_id`（`image_url.url` / `file.file_id` 留空，厂商 `file_id`、base64、绝对路径都不进库） |
| D6 | **图片模型保留**（SDK 能力），含默认图片模型 |
| D7 | **`@` 补全**：按需扫描（git `ls-files` 优先，非 git 用 glob 并排除 `node_modules/.git/dist`）；20000 条 / 5s 超时 / 15s 缓存；未就绪要说话 |
| D8 | **文案与多语言**：宿主产出文案并自己做多语言；**语言挂在连接上**（`hello` 带可选 `language`，断开即忘），缺省用配置的默认语言（英文） |
| D9 | **Workspace 是一等公民**：id 宿主分配、**cwd 不可变**；一个 Workspace 诞生一个 Scope；一个 Workspace 下多个对话**复用**该 Scope；搬家＝新 Workspace |
| D10 | **Workspace 只走显式添加**；普通对话不会因为落在某个目录里就自动生出项目；临时会话不进这条线 |
| D11 | **删 Workspace＝连带删它名下的对话**，删前明说代价；**目录本身宿主永不碰** |
| D12 | **cwd 不存在**：Workspace 与对话照常存在、照常可看；宿主只报「目录已不存在」这个事实，**是否只读由客户端判断** |
| D13 | **侧栏排序**：默认创建时间倒序，可**手动置顶**；活动 / 打开 / 改名都不改变顺序 |
| D14 | **一段对话同时只跑一轮**；跑中再发一句**不拒绝、不打断**——那一句排进正在跑的那一轮的 inbox（core 的 `Agent.inbox`），宿主立刻回执 `queued: true`，由 core 在轮末落成一条用户消息。取件点只有一处（内循环末，见 F-C13）；`high` 与 `low` 两档，`low` 目前没有生产者在用。落地只在「这一段还在跑」的范围里保证：收尾钩子期间投进来的条目这一段不再带走，只由结算告警出声，但**条目不会丢**（agent 常驻，留在 inbox 等下一次外部驱动）。排队条目**在落地那一刻就写库**。`busy` 只剩别的动作撞上正在跑的一轮（交接、撤回、答问题）与排队窗口没打开时的兜底。中止**不碰** inbox：要作废排队得显式清空 |
| D15 | **崩溃恢复**：边流边写，在途消息以 `Aborted` 落库；**装载后的修复归 core** —— 宿主只把库里的行读出来交给 agent，core 在进圈开头定型没写完的、按策略收拾残局（见 `CORE.md` §6）；存储层必须保留 `status` / `omit` |
| D16 | **搜索**：按名称、按聊天内容全文、按 Workspace 过滤（中文分词成本接受） |
| D17 | **删除对话＝硬删**，删前警告；图片按引用清理（引用关系随消息级联消失，**归零**才删素材行与磁盘文件） |
| D18 | **交接 / 迁移后开一段新对话**（同 Workspace、同助手），内含系统提示 + 交接文档摘要；旧对话完整保留可回看；交接回合本身产生的消息不进旧对话的库 |
| D19 | **交接文档写进项目**：`<cwd>/.ai-zen/handoffs/` |
| D20 | **换模型拒绝降级**：历史里有图且新模型不支持视觉 → 不允许换并说明原因；换模型后这一段会话的思考档位清回「跟随助手定义」（档位是模型的档位） |
| D21 | **配置只能走宿主 API** 读写（校验与生效点都在宿主） |
| D22 | **问题对象**：有状态、有生命周期、可持久化；多端看同一会话看到同一个问题；交接在**对话停下之后**触发 |
| D23 | **越过硬线两端都拒绝**（客户端拒绝、宿主也拒绝），问题对象继续挂着 |
| D24 | **撤回**：撤到任意用户消息之前，其后消息硬删，被撤回内容回填输入框；**消息分叉列为后续能力** |
| D25 | **端口**：启动参数 > 配置文件（`<数据根>/host.json`）> 默认 8790。**保留发现文件 `<数据根>/run/host.json`**（记 pid / 地址 / 端口 / 是否本地）：端口可能被占而退到系统分配的临时端口，客户端只能从这里读到真实地址；单实例判断也只认它 |
| D26 | **连接管理归客户端**：记住上次连接、首次 / 失败进连接屏、可启动本地服务或连远程（地址 + 密钥）、可更换 |
| D27 | **阈值配在哪＝不问**（属 SDK 的 `AppConfig` 事实：模型级 `tokenThresholds{handoff,guard}`） |
| D28 | **Agent 常驻；Scope 不空闲回收**：一段对话一个 agent、**跨轮复用**——它的 `messages` 是这段对话的**内存真相**（下一轮不从库里读 history，也不重复 push；库里的行是快照）。Scope 没有空闲回收、没有引用计数，公开面只有 `create` / `get` / `refreshWorkspace` / `dispose` / `disposeAll` / `workspaceIds`；`dispose` 撞上还活着的 agent 抛 `ScopeBusyError`（带 `conversationIds`，**不级联**）。**存活策略只有一处**：`AgentRegistry` 的 `acquire` / `complete` / `discard` / `invalidate` / `disposeAll`，外加观察用的 `onLifecycle`（`action` = `built` / `reused` / `rebuilt` / `retired`；`reason` 是闭集：`never-built` / `assembly-facts-unchanged` / `assembly-facts-changed` / `config-changed` / `stale-on-settle` / `conversation-deleted` / `shutdown`）。Scope 与 MCP 连接同生共死，拆的条件只有「有人显式 `dispose`」与「进程收尾」。两者释放都不得丢用户可见状态（模型与思考档位存在会话行上） |
| D29 | **关闭宿主是必要需求**：客户端要有显式的「关闭宿主」命令，一次二次确认，确认即关闭。但**客户端退出时不自动关宿主**——一台机器一个宿主，可能多个客户端共用 |
| D30 | **切换工作区是必要需求**：工作区是**实体入口**（列 / 选 / 建），不是隐式的「当前目录」。启动时自动进入：本机宿主用当前目录（这条糖），远端用「上次进入的那个」，都没有才进选择环节 |
| D31 | **下载进度屏是必要需求**：本机拉起宿主时要有阶段式进度（解析版本 → 下载 → 安装 → 启动宿主 → 连上），进度**不确定**（不解析下载器的输出）。失败与取消就地处理：真原因 + 重试 + 折回远程连接屏（Ctrl+C 杀掉下载子进程回连接屏、不退出程序）；一次性（stdio）模式直接报错退出 |
| D32 | **配置文件坏了就恢复出厂**：`config.json` / `host.json` / `mcp.json` 读不成配置（解析不了，或解析出来不是对象）时，用出厂配置顶上**并写回磁盘**，再落一条 warning 通知（说清是哪个文件坏了）——不往上抛、也不在两边各折一次。坏掉的那份改名留档为 `<文件名>.broken`（同名已在就带时间戳）。**不包括**：项目侧与 `~/.agents` 各层（在用户仓库里，恢复出厂等于改人家的 git 内容，仍是看得见的 `broken`、能修），以及库里的 JSON 列 |
| D33 | **平级会话（阶段 1）**：一段对话里的模型可以开**另一段会话**，**建完即回**；那边跑完由宿主把结果投回发起者并**唤醒**它。深度只有一层；编排元数据**不落库**（重启之后退化成普通会话）；投递失败记 `dropped` 并出声，不重试；子会话的用量记在它自己那一轮，**不进**父对话的 `subAgentUsage`。阶段 2 已做（见 D38）；阶段 3 的那几件（超时与 abort、`/sessions` 的「agent 建的」标记、重启孤儿与补投）**没做**，见 §9 |
| D34 | **配置生效＝就地刷新，不是拆重建**：`config` 改动 → `ConfigService.apply` → `refreshScopesFor`：对**已存在**的 Scope 调 `refresh()`（先重读 config、再让各插件 `discover()`，MCP 按定义对账断旧连接），然后把受影响的 agent 交给 `AgentRegistry.invalidate`（空闲的当场退役、在跑的只打标记，结算时退役）。出网字段叫 `refreshedWorkspaceIds`，语义是「已就地刷新」（旧名与「拆重建 / 等最后一次 release」那套一起作废，不要再按「回收」读这个字段） |
| D35 | **投递只有一个入口，且分「唤醒」与「复活」两个词**：core 侧 `deliver(input)` / `deliver(inputs)`（整批＝全部入队后**只唤醒一次**、队列一次落地成多条 User 消息；空数组什么都不做）；宿主侧 `ChatRunner.deliver(conversationId, { content, source }) → Promise<DeliveryOutcome>`，`DeliveryOutcome = { accepted: true, state: "running" \| "idle" \| "settling" }`——内部包三件：agent 不在 → `agents.acquire` **复活**（按库里历史重新装配）、在跑 → 交给那一段、正在结算 / 受理中 → 会话级 waitlist，结算后整批投。事件次序契约：一次唤醒对外是 `status(running)` **先**、本段第一条 `message` **后** |
| D36 | **自起的段**：被 `deliver` 叫醒跑起来的那一段**有完整 turn 上下文**——落库、推 `run.state`、可 `conversation.abort`、正常结算；它没有预分配 id（user 消息 id 来自投递条目，assistant id 首次见到时才分配） |
| D37 | **退出判据**：最后一个客户端连接断开 **且** 没有在跑的轮次 → 显式收尾（`doStop` → `disposeAll`，Scope 与 MCP 连接一起拆）然后退出。「手里还有 Scope」**不是**判据；也没有任何空闲计时器 |
| D38 | **平级会话（阶段 2）**：`send_to_session({ sessionId, content })` 让父↔子可以互发（血缘），平级之间 `not_allowed`、查不到 `gone`，返回 `{ accepted: true, state }`；**回投跟着每一次段结算**（不是跟着 `create_session` 那一次），一段一次；**段开始**那一拍把记录复位成 `running`，于是 `read_session_status` 不在跑着时答 `idle`、并发限额也数得到；每个父对话同时最多 **4** 个 running 的 peer，超了 `too_many_peers`。仍然**不落库**：重启之后对老会话答 `gone`（会话本身作为普通会话还在）。跨重启的稳定语义是阶段 3，**没做** |

---

## 4. 裁定（R1–R79）

> 每行只留结论。编号被代码注释引用（`R56` 被引用 41 次），**一个都不能丢**。已被后来的决策取代的，写「→ 已被 … 取代」并保留编号。
> 表尾编号为 `—` 的若干行，是原先散在实施问答里、仍成立且没有编号的结论，按同一口径并入（不另凑编号）。

| # | 结论 |
|---|---|
| R1 | 临时对话**不推流式事件**：`conversation.transient` 一次调用同步返回；事件载荷里的 `conversationId` 保持必填，不为临时对话破例 |
| R2 | 「取名模型」进 SDK 配置（`namingModel`），不进宿主的另一处存储；未配时回落 `defaultModel`，都拿不到就保持原名 |
| R3 | 契约保留 `defaultModel`：它是三级解析的**兜底层**，不是真相源；真相在助手定义上 |
| R4 | 通知三档语气是 `info` / `warning` / `error`；「已保存」这类一秒提示归 `info` + 短 duration，不加 success 档 |
| R5 | 默认助手的「默认」是**全局一份**；Workspace 是项目，不承载助手默认 |
| R6 | ~~能力清单独立方法 + `hello` 回 id 列表~~ → **已作废**：能力清单（`host.capabilities` / `hello.capabilities` / `CapabilityView`）2026-11-14 整体删除，两端零消费者 |
| R7 | 二次确认做成 `dryRun` 两步：先取代价（宿主算），客户端展示后真调 |
| R8 | `conversation.get`（元信息）与 `conversation.state`（现场快照）**不合并**：重连先拉状态 |
| R9 | 子 Agent 消息回看不加新方法，走 `message.list` 的 `toolCallId` |
| R10 | 撤回是硬删，契约不返回任何「曾有消息」的占位 |
| R11 | 批量请求（帧是数组）拒的码是 `unsupported`（`detail.reason = batch_not_supported`） |
| R12 | 非法端口**报 `config_invalid`**，不静默回落（最终口径见 R67） |
| R13 | `agents/ skills/ tools/ sub-agents/ mcp.json` 的路径归 SDK 的 `ConfigManager.basePath`；宿主 `HostPaths` 只加 `configFile`（`<dataRoot>/config.json`） |
| R14 | `workspaces.cwd` **唯一**：同一 cwd 登记两次会让两个 Scope 抢同一目录 |
| R15 | 通知 duration 契约用**秒**（用户语义），库里存毫秒；换算只在 wire 层 |
| R16 | `assets.messageId` 用 `SET NULL`——已由 D5 / F-H8 的表结构取代（归属移到 `conversation_assets` 关系表，删消息即级联删关系行） |
| R17 | `questions.conversationId` 可空 → **已被 R79 取代**（收紧为 `NOT NULL`） |
| R18 | `conversations.agentId` / `modelId` **都 NOT NULL**：身份创建时定死，解析不出就在创建时报错，不写半成品行 |
| R19 | `tx` 的回调里可以 `all` / `get` / `run`（同一 worker 消息内串行执行），但**读到的值回不到 JS 里决定下一条写什么**——要分支就把条件写进 SQL（R31） |
| R20 | Workspace 列表按 `createdAt DESC`（D13 只定对话侧栏） |
| R21 | 聊天消息内容**不许发明新数据类型**，一律原样用 `@ai-zen/agents-core` 的导出（`Message` / `MessageContent` / `ToolCall` / `MessageStatus` / `Delta` / `Usage`）。wire 只包一层薄外壳给「非消息事实」（哪个对话、六态、通知、问题） |
| R22 | `message.list` 里的消息原样 `AgentNS.Message[]`，不加时间戳外壳；顺序由服务端给 |
| R23 | 素材认 `MessageInput.assetIds`：它是「已上传待转段」的定位，进消息前由宿主按实发模型转成 `image_url` / `file` 段（F-H7） |
| R24 | 工具失败不单独承载字段：失败事实在那条 `role: tool` 消息的 `content` + `status`（`MessageStatus.Error`）上 |
| R25 | `message.delta` **不带**消息状态快照；状态只有 `run.state` 一处给 |
| R26 | 上下文状态里用 core 的 `usage: AgentNS.Usage`，界面取 `usage.prompt_tokens` 与两条阈值比 |
| R27 | `conversation.transient` 不单独给 `text`，内容从 `message.content` 取 |
| R28 | `SubAgentStatus` 的四个自造取值保留（core 只有消息状态，没有「子 Agent 这个对象」）；但不得与 `MessageStatus` 混用同名同义 |
| R29 | core 的字段是 `omit`，不是 `omitted`（以 `packages/core/src/AgentNS.ts` 为准） |
| R30 | storage 的行类型换成 core 的 `AgentNS.MessageContent` / `MessageContentSection`；`MessageService` 改成透传，不许逐段重建 |
| R31 | `tx` 只做声明式批次；需要分支就把条件写进 SQL |
| R32 | R14 / R18 这类结构裁定直接改进 v1 建表语句（这套表结构还没随版本发出去）；发出去之后只追加迁移 |
| R33 | 删除类方法**不进契约**「要清哪些素材文件」；app 层删完问 `AssetService` 要文件清单并清理 |
| R34 | `workspaces` **不加** `updatedAt` 列；`WorkspaceView.updatedAt` = 名下对话最近一次活动（没有就创建时间） |
| R35 | **加列** `conversations.nameIsAuto INTEGER NOT NULL DEFAULT 1`：用户改名置 0，自动命名置 1；不许靠「名字是否等于原名」猜 |
| R36 | `MessageRepository.search` 不扩展 offset / 计数：`total` 是下界，注释写清 |
| R37 | **加列** `messages.parentToolCallId TEXT`（可空）；子 Agent 消息的写入与回看仍是缺口（见 §9） |
| R38 | 「模型解析不出来」用专键 `error.modelUnresolved`（en/zh 各一条），不借用 `error.configInvalid` 塞英文短语 |
| R39 | 同一 cwd 再登记**不幂等**：报 `invalid_params` + `detail.reason = already_registered` + 已有 `workspaceId` |
| R40 | 撤回时该对话正在跑 → `busy` |
| R41 | `setThinking` 的「当前档」靠参数反推：助手定义那一侧参数即真相，不另记档位名。**会话级那一侧已被 R70–R72 取代**（会话行记档位名） |
| R42 | 已吊销的凭证再吊销 → `revoked: false`（这次有没有真改动库），不幂等返回 true |
| R43 | 删项目时由 app 层调 `ScopeRegistry.disposeWorkspace(id)` 回收 Scope |
| R44 | `assetIds → 内容段` 归 `AssetService`（注入 `ChatRunner` 的 `prepareAttachments`） |
| R45 | 在途 assistant 的落库以 D15 为准：库里记 `Aborted` + `outcome = "aborted"`，内存按 core 策略，装载时 `reconcile(keep)` 修回 |
| R46 | `run.state` 只在换态或工具列表变了时推；要实时字数由客户端累加 `message.delta` |
| R47 | 事件可能早于受理回包：接线层按请求参数里的 `conversationId` 缓冲，该对话的推送等回包写完再放行 |
| R48 | `conversation.changed.messageCount` 用内存数（它只是「去拉一下」的信号，不是计数真相） |
| R49 | 临时对话**不走落库路径**：同一条执行逻辑，不落库、不推流式事件、一次返回 |
| R50 | 未注入交接服务时不装交接插件，但装配处要推一条 `warning` 通知（不静默）；时点是**第一次装配 agent 时**，不是启动时 |
| R51 | ~~`ConversationRuntimePort` 承载临时模型 / 临时思考 / forget~~ → **已被 L7 改写取代**：模型与档位落会话行，临时覆盖概念作废；端口只剩「忙不忙 / 在跑什么时候开始 / forget」三件 |
| R52 | ~~`recycleAll` 对正被持有的 Scope 等释放后再销毁~~ → **已被 D28 取代**（没有 `recycleAll`，也没有空闲回收） |
| R53 | ~~`onIdle` 还是 `onAllRecycled`~~ → **已被 D28 取代**：两个回调都不存在了，Scope 不自己消失 |
| R54 | MCP 的 5 层链与 skills / tools / sub-agents 的各层目录由配置层按 cwd 算好传给 `ScopeRegistry` |
| R55 | 用量三口径（`turn` / `total` 含子 Agent / `subAgent`）、id 认领（core 追加的那两条认成宿主预分配的两个 id）、每轮先 `reconcile`、工具消息先落 `pending` —— 全部成立 |
| R56 | `conversation.create` **不落库**：只发 id + 定死身份，首次 `send` 才写行（没有用户消息就不写，否则一堆空会话）。没发消息就断线重连的会话自然消失 |
| R57 | ~~`hello` 只回能力 id 列表~~ → **已作废**：清单整体删除（R6），`hello` 也不再回这个字段 |
| R58 | SDK `AppConfig` 加 `language?: "en" \| "zh"`，可经 `config.setDefaults` 写；`hello` 缺省语言取它（再缺省 `en`） |
| R59 | 交接询问由**服务端自己触发**：一轮结算后回调 `onTurnSettled` → `askHandoffAfterSettle`；`AutoMigratePlugin` 按 D34 / F-D11 的口径答「是不是派生会话」，不再一律 `null` |
| R60 | ~~按 cwd 开对话 + 未登记就问~~ → **已被 R79 取代**（整条路线删除，D10 改写） |
| R61 | `question.list` 的 `conversationId` **可选**：不给就按 `state` 查全库（含 `conversationId` 为空的问题） |
| R62 | 撤回回填只给**纯文本 + `assetIds`**，图片靠 `assetIds` 复原（避免同一张图重复两遍） |
| R63 | 新增 `host.reload`，复用配置生效那条路、返回同一份报告。**`scope` 参数后来删掉了**（5 值枚举没有调用方），方法本身保留 |
| R64 | 日志落文件：`<数据根>/logs/host.log` + 按大小轮转；warn / error 同时上通知（永久） |
| R65 | ~~`statusBlocks` 按 8 块 ID 拼装~~ → **已作废**：`statusBlocks` 从契约整体删除，块由客户端现拼（F-I6） |
| R66 | 启动后低频自检（30s、`unref`）比对磁盘版本，变了就收尾退出、由启动方式重拉 |
| R67 | 配置文件的端口要有真实来源（`<数据根>/host.json`）；**显式给出但非法的端口报 `config_invalid`**，只有完全没给才回落默认；`0` 只认启动参数那一档 |
| R68 | `@ai-zen/agents-client` 按新契约重写（连接 / 调用 / 订阅 / 续传 / 重连） |
| R69 | cli 与 desktop 可以共享代码，但**禁止发包**：共享包一律 `private: true`，各端打包时自己内联；运行期零依赖 |
| R70 | 会话级模型与思考档位**持久化在会话行上**（`conversations.modelId` + `conversations.thinkingLevel`）；改全局去改 agent 定义（`agent.setModel` / `agent.setThinking`） |
| R71 | 模型与思考档位的持久化级别**必须对称**：两个都在会话级，不存在「一个进库一个只在内存」 |
| R72 | **换模型必须同步清掉思考档位**（档位名是旧模型策略表里的键） |
| R73 | 新会话在**用户点发送之前**不进列表（草稿留在客户端内存），发送后才落库；R56 因此不需要例外 |
| R74 | **保留 `AppConfig.defaultModel`**：它是三级解析的第三级兜底，不是第二个真相源；三级全空报 `error.modelUnresolved`，绝不静默挑一个 |
| R75 | 推送事件里凡是承载消息 / 内容的地方，一律用 core 的原始形状，不许在事件里发明简化形状（把 `content` 压成字符串就是这类错误） |
| R76 | `asset.get` 要能回 `width` / `height`：落定时自行解码 PNG / JPEG 头（零依赖），其它格式给 `null`，不做重试 / 告警矩阵 |
| R77 | 全链路改名 server → host：`packages/host`、bin `agents-host`、`run/host.json`、`logs/host.log`、`host.*` 方法名、`HostError` / `HostApp` / `HostPaths`。边界：MCP 的 `mcpServers` / `load_mcp` 的 `server` 参数、Node 的 `WebSocketServer` / `createServer`、SDK 的 `InternalServerError` 一律不动（同名不同物） |
| R78 | `conversation.state` 加 `includeMessages?: boolean`：没要时 `messages` 键**不出现**（不是空数组）；要时与 `message.list` 同一次读取。带锚点的增量补拉仍两跳 |
| R79 | 删掉「按 cwd 开对话」整条路线：`conversation.create` 只收 `workspaceId`；`QuestionKind` 去 `workspace_registration`；`questions.conversationId` 收紧为 `NOT NULL`；连带删 `locateWorkspace` / `askWorkspaceRegistration` 等一整串。判据是「没有活客户端 ⇒ 删」，不是「理论上有入口就留着」（同时作废 R17 / R60） |
| — | 宿主的 `bin` 名是 `agents-host`；无子命令与 `serve` 都前台起服务；`token` 三个动作直接开库、不启服务；`version` 只打印版本与协议版本；对外实例不生成 `run/token`，只提示用 `token create` 自建再分发（`token create` 的明文只打 stdout） |
| — | `--host` 与 `--local` / `--public` 的映射：回环地址 → 本地实例；非回环 → 对外实例；与 `--local` 同时写非回环地址算用法错（退出码 2） |
| — | 命令行没有连接级语言协商，说明文字与错误**固定中文**（D8 的语言挂在连接上，命令行没有连接） |
| — | 上传的二进制帧格式：`[4 字节大端头长度 N][N 字节 UTF-8 JSON {"uploadId"…}][片段字节]`；头长度上限 4096；坏帧 `invalid_params` + `detail.reason`（`frame_too_short` / `bad_header_length` / `truncated_header` / `header_not_json` / `header_without_upload_id`）。编码只有一份实现，客户端复用 |
| — | 事件的帧形状：事件名放 `method`、载荷直接放 `params`，不在 `params` 里再塞一份事件名 |
| — | `asset.begin` 的 `conversationId` **必填**：没有对话归属的上传直接拒（`invalid_params` + `detail.reason = conversation_required`），不收字节、不留无主文件 |
| — | `config.get` 的 `issues` 六类稳定小写码：`endpoint_no_key`（warning）、`model_endpoint_missing`（error）、`threshold_order`（warning）、`default_model_missing`（error）、`default_image_model_missing`（error）、`default_agent_missing`（warning） |
| — | `ConfigApplyReport.restartRequired` 恒为 `false`（改完配置靠就地刷新生效，F-E2） |
| — | 端点密钥三态：省略 = 保留；回传值恰好等于当前掩码 = 当作没改；空串 = 清掉（唯一能删密钥的写法）。MCP 的 `clientSecret` 同口径（只给掩码 + `clientSecretSet`） |
| — | 模型写入三道校验：端点必须存在、`handoff < guard`、`reasoningPreset` 必须在策略表里 |
| — | 删模型时默认指向只**改指到同端点的第一条剩余模型**；同端点没剩的就清空——跨端点改指等于把请求发去另一家服务商，那件事由人决定 |
| — | `agent.*` 的 `custom` 只由 `create` / `update` 置 true；`setModel` / `setThinking` 只动绑定与参数，不改 `custom` |
| — | `DiscoveryLayerView.editable` 的语义是「本契约的写方法能不能改这一层」：MCP 恰好 2 层为 true，skill / tool / subagent 全 false |
| — | 写 MCP 时目标文件存在但读不出来：先把坏文件改名留档，再写新的（修复动作不抹掉用户手写的内容） |
| — | `handoff.start` 的 `document` 必填；「用户取消」抛 `handoff_declined`，不假装成功 |
| — | 问题的 `blocking` 缺省为**挡**：问题就是为「停下来问」而造的 |
| — | 平级会话的几种拒绝都是**返回值**不是抛错：`depth_exceeded` / `model_unresolved` / `too_many_peers` / `not_allowed` / `gone`；投递丢了只记 `dropped` 并出声一次，不重试、不补投 |
| — | 单实例探活用 `process.kill(pid, 0)`，不额外连端口 |
| — | 自动命名判「第一轮结束」用「这段对话只有一条用户消息」+ 进程内 `Set` 防重；重启后若仍处在第一轮，会再起一次名 |
| — | 文件补全是手写递归遍历（跳过 `node_modules` / `.git` / `dist`，不跟符号链接，深度上限 32），第一次问立刻回 `scanning` 并在后台扫 |
| — | `.ai-zen/handoffs/**` 与 `.ai-zen/audits/**` 是历史存档，里面的旧包名 / 旧路径**保留**（不假造过去） |

---

## 5. 自决（AI 的拆法，用户随时可否决）

| # | 结论 |
|---|---|
| 1 | 忙即拒的 `HostError("busy")` 在 `detail` 里带 `{ conversationId, startedAt, aborted }`；文案键 `error.busy` 没有占位符，所以「在忙什么」只放结构化字段 |
| 2 | 存储行类型里 `content` 可为 `null`：只表示「这一行没有正文」，core 的 `MessageContent` 本身没有 `null`，不引入第三种形状 |
| 3 | `parentToolCallId` 在 upsert 的冲突分支用 `COALESCE`（流式反复写不会抹掉已记的归属）；代价是写进去之后改不回 `NULL`；读数方法带对话范围 |
| 4 | `attachments[].problem.message` 在产生现场按默认语言渲染，由 `conversation.send` 的 handler 按连接语言重渲染一次再出网 |
| 5 | 出参里的 `LocalizedText` 由 handler 按 `context.connection.language` 重渲染；识别靠形状（`code` + `messageKey` + `params` + `message`），认不出来的键原样留着 |
| 6 | 事件里的 `LocalizedText` 由注入的 `localizeEvent` 按连接语言重渲染，覆盖 `notice` 与 `question` 两类载荷，其余事件原样返回 |
| 7 | 四个配置域各一个 `createXHandlers(deps)`，与其它域同形；`HandlerDeps` 带 `config` / `agents` / `models` / `completion` 四项 |
| 8 | `createWorkspaceScopeFactory` 允许 `skillsPaths` / `toolsPaths` / `subAgentsPaths` 传「按 cwd 算」的函数（能力目录跟项目走，Scope 按 cwd 装配） |
| 9 | 「思考档位 → 请求参数」的注入点是同步的，所以 `reasoning-presets.json` 用启动时的快照（`send` / `setThinking` 时刷新一次）：进程内热改不即时生效 |
| 10 | 临时对话的 Scope 按 `transient:<cwd>` 这个键去借，接线层的 Scope 工厂要认得这个前缀（D3 的「只借 Scope」落地方式） |
| 11 | 交接成功后推两条 `conversation.changed`：新对话 `created`、旧对话 `settings_changed`（旧对话内容没变，只是「这段已经交接过」） |
| 12 | 新对话的第一条消息用 `role = system` + `hidden` 承载「交接文档路径 + 摘要」；`hidden` 的语义就是「这条不给人看」（仍参与模型上下文，`message.list` 默认不返回、不计数） |
| 13 | `host.upgrade` 的「重启」= 安排一次收尾、进程退出，由**启动方式**重新拉起；宿主不 `exec` 回自己 |
| 14 | `asset.get` 的 `thumb` 一档目前等同原图（不引入原生图像库），回包里 `variant` 说明实际给的是哪一档，客户端按 `width` / `height` 自己缩 |
| 15 | 首次拉起宿主时若一个阶段都没来（「有就上」），下载屏一个字节都不画，不为一次什么都没做的检查闪屏 |

---

## 6. 待核（要么定口径，要么接受现状）

| # | 问题 | 现状 |
|---|---|---|
| Q1 | 出厂托管的模型「删了活不过重启」（SDK 的 `syncManagedModels` 会按出厂清单加回来） | 要么给 SDK 加隐藏标记，要么删出厂模型时直接拒（提示「用恢复出厂 / 改成自定义」） |
| Q2 | `AgentInput.function` 只有「给」没有「撤」（撤回子 Agent 身份没有对应写法） | 要不要给一个显式的 `null` 清空 |
| Q3 | `agent.list` 的 `workspaceId` 只接参数、不影响算出的可用性 | 要么定清楚「在这个项目里能不能用」该算什么，要么从契约去掉这个参数 |
| Q4 | 删除助手的 `references` 只报「默认助手」与「别的助手点名它的 function」 | 「还有 N 段对话在用这个助手」要不要查库列出来 |
| Q5 | D3 的临时对话要带图时没有归属口径（`asset.begin` 必须带 `conversationId`） | 要么内存态临时素材，要么素材表允许空对话 |
| Q6 | 上限是 20MB/张，而 SDK 内联（base64）上限是 8MiB：端点没有 Files API 时存在「允许上传、但发不出去」的一档 | 现在结局是 `dropped` + 告警；要不要在上传时按当前模型提前拒 |
| Q7 | `error.questionPending` 的参数传的是「按缺省语言渲染好的句子」 | 按连接语言重渲染错误时那句话不会跟着变；要不要改成传 `questionId` |
| Q8 | 挂靠已有实例时，本进程仍建库、跑迁移、`bootstrap()` | 要不要让挂靠这条路连库都不开 |
| Q9 | 单实例探活只 `kill(pid, 0)`，pid 被复用时会挂靠到一个陌生进程 | 要不要探活之后再校验 `host.json` 里的地址真连得上 |
| Q10 | 客户端自造问题（调试 / 脚本）没有契约入口 | 要的话加 `question.ask`（见 §9） |
| Q11 | 宿主词典里「该说而没说」的那一批（删对话 / 删工作区后的确认、撞硬线、撤回后、子 Agent 结束、附件超限…） | 句子已随零产出清理删掉，但那些提示仍是需求缺口 |
| Q12 | `desktop` 的类型检查依赖 `agents/packages/host/dist` 已构建 | 要不要在构建脚本里显式前置依赖（现状靠一条隐式约定） |

---

## 7. 能力清单（F-##）

> 每条给「要什么 + 落点 + 边界」。落点代号：**S** = 宿主承接（远程拿不到这个事实，或必须是同一份真相）；**C** = 客户端自己做（本机能力，换设备本就该不同）；**S+C** = 宿主出事实、客户端出表现；**X** = 不要。

### 7.1 入口与启动

| 编号 | 要什么 | 落点 | 边界 / 依据 |
|---|---|---|---|
| F-A1 | 人用（交互界面）与脚本用（一次性输出、退出码说话）两条路分开 | S+C | 宿主判「这次调用算不算一段对话」；形态归客户端 |
| F-A2 | **临时对话**：一次请求跑一轮，零痕迹 | S | D3：无 id、不入库、不进列表、只借 Scope |
| F-A3 | 明确要求「开新会话、别续接」 | S | 续接是客户端的记忆（D26），开新会话是宿主动作 |
| F-A4 | shell 兜底钩子（命令不存在时转给 AI） | C | 改的是本机 shell 配置 |
| F-A5 | 查帮助与版本 | C | 宿主给事实（`host.version`），界面归客户端 |
| F-A6 | 接着上次聊 | C | 客户端记住上次打开的会话 id；**工作区也有上次记忆**（D30） |
| F-A7 | 首次使用先补密钥，而不是报错退出 | C | 宿主只需回答「这个端点配好了没」（`config.get` 的 `issues`） |
| F-A8 | 配错了要能当场修 | S+C | 宿主给结构化原因；修配置走 D21 |

### 7.2 一段对话的身份

| 编号 | 要什么 | 落点 | 边界 / 依据 |
|---|---|---|---|
| F-B1 | 模型解析是一条**三级链**：会话级（`conversations.modelId`）> 助手定义（`modelId`）> 全局兜底（`AppConfig.defaultModel`） | S | 三级全空**报错并说明**（`error.modelUnresolved`），绝不静默挑一个：那会变成「界面写着 A、请求落在 B」。兜底那一级是「助手没绑模型也能跑」，不是第二个真相源 |
| F-B2 | 助手＝提示词 + 模型 + 权限四维（tools/skills/mcps/subagents）+ 自定义标记；**定义要能读回来**：`messages`（提示词）与 `function`（子 Agent 定义，非子 Agent 为 `null`）都在助手视图里 | S | 只能写不能读就等于编辑不了助手定义（F-F5），所以「读得回」是需求，不是接口好看 |
| F-B3 | 有默认助手；为空时有回落 | S | R5：全局一份 |
| F-B4 | 换这一段会话的模型（存会话行、可改、重开还在）+ 改助手默认模型（影响以后的对话）是**两个动作** | S | L7；两个动作两个入口，不能混 |
| F-B5 | 换助手只改默认，不改造历史；不可用的助手也要列出并说明原因 | S | L7；「藏起来」会让人以为它没了 |
| F-B6 | 思考强度：用户说「多想一点」，模型要的是参数补丁；助手定义上那份参数也要能**清掉** | S | 档位表与展开逻辑沿用 SDK；会话行上存**档位名**，装配时按当前模型的策略表展开成参数。清掉定义上的思考参数**不等于**「设成某一档」；会话侧「回到跟随助手默认」是另一个动作 |
| F-B7 | 状态上能区分「跟随默认 / 手动设了某档 / 不可调」 | S+C | 「跟随默认」= 会话没设过档位；「不可调」= 这个模型的策略表里没有档位 |
| F-B8 | 换模型时历史有图而新模型不支持视觉 → 拒绝换 | S | D20 |

### 7.3 会话与历史

| 编号 | 要什么 | 落点 | 边界 / 依据 |
|---|---|---|---|
| F-C1 | 一段会话有稳定 id | S | L6；id 与时间无关 |
| F-C2 | 落盘时机：内循环结束写一次 + 流式中增量写 | S | D15 / R56：没有用户消息就不写。排队落地的用户消息是唯一例外：**落地那一刻就写**（F-C14） |
| F-C3 | 会话有可改的名字 | S | D1；改名不改变身份、不改变排序 |
| F-C4 | 自动命名 | S | D2：首轮后、未改名、开关、取名模型、原名＝创建时间 |
| F-C5 | 排序：创建时间倒序 + 手动置顶 | S | D13 |
| F-C6 | 找得到旧对话：**桌面端一个搜索框**，按对话名 + 聊天内容搜，可按 Workspace 过滤；命中要能**定位到那条消息** | S+C | D16。搜索是客户端的一个搜索框，宿主只给事实：按名搜、按内容搜、按消息 id 取一窗（`around`，见 PLAN A12）。**TUI CLI 一阶段不做搜索** |
| F-C7 | 开新会话；旧的有内容则先归档 | S | 先归档再换 id（顺序反了会覆盖旧会话） |
| F-C8 | 撤回：删到某条用户消息之前，内容回填输入框 | S+C | D24 / R62；硬删；分叉是后续能力 |
| F-C9 | 清屏只影响显示，不影响上下文 | C | 换个前端打开就该看到完整历史 |
| F-C10 | 删除对话＝硬删 + 警告 | S | D17；图片按引用清理 |
| F-C11 | 用本机编辑器写长消息 | C | — |
| F-C12 | **跑中发送**：正在跑一轮时再发一句不是拒绝、也不是打断——它进**正在跑的那一轮**排队，宿主立刻回执（`queued: true`、`assistantMessageId: null`） | S | D14。排队那条没有属于自己的助手消息（流还是这一轮原来那条），所以 `assistantMessageId` 是 `null`；排队不是绕过问题闸门的通道（`assertSendable` 在两条受理路之前） |
| F-C13 | 排队条目的取件点与落地：`high` 在工具轮跑完的边界落地；`low` 在同一处、这一组停下时才落 | S | D14。全 core 只有**一个**取件点；`low` 这一档留着给外部投递（宿主只投 `high`）；只有真的插进条目才续圈（防死循环）；`abort()` 不碰 inbox |
| F-C14 | 排队落地的用户消息**在落地那一刻就写库** | S | D14 的落地要读得出因果：`seq` 按插入顺序给，助手消息是边流边写的，等到收尾才首次写会让转录变成「助手说完 → 助手又说 → 用户冒最后一句」 |
| F-C15 | 会话列表要说得出「这段此刻在跑」 | S | `ConversationSummary.run` 在跑是 `{ status: "running", startedAt }`、没在跑是 `null`（一个布尔说不出「什么时候开始的」） |
| F-C16 | **一段对话里的模型能开另一段会话**（`create_session`：同 workspace、`agentId` 缺省继承父对话、模型走既有三级解析），**建完即回** | S | D33。深度只有一层；编排元数据只在宿主进程内、不建表（重启后退化成普通会话）；子会话用量记在它自己那一轮，**不进**父对话的 `subAgentUsage` |
| F-C17 | 模型能问一段平级会话的状态：`read_session_status` 只给状态 + 最近一条摘要（~300 字），**绝不给全量消息**；工具说明与回包都要求模型**别轮询** | S | D33。查不到记录（被删 / 重启前的）回 `gone` 而不是抛错；给摘要原文等于把子会话上下文搬进来，token 会炸 |
| F-C18 | **自动唤醒**：结果投回父对话——父对话在跑 → 作为 inbox 条目在它这一轮落地；父对话空闲 → agent 不在就先按库里历史**复活**，再把结果投出去叫醒它 | S | D33 / D35。唤醒那一轮的 `source` 不是 `"user"`，所以**不触发交接询问**；投不出去（父对话被删）→ 记 `dropped` 并报一次错，不静默、不重试（补投归阶段 3） |
| F-C19 | 非 `user` 来源的正文最前面一行是 `// 这条消息来自 <source> 自动推送（<时间>）`；**落库的那一份与发给模型的那一份一致** | S | 注释由 core 统一生成（宿主不自己拼）；`source === "user"` 原样返回；注释**只加一次**，`__asset_id` 段原封不动；平级会话投递的 `source` 就是可读 label 原样（`会话 1` / `补测试`），不再套一层壳 |
| F-C20 | **模型能继续跟一段已有的平级会话说一句**：`send_to_session({ sessionId, content })`，不等结果 | S | D38。只有**血缘**能发（我是它的父、或它是我的父）；平级之间 `not_allowed`、查不到 `gone`，都是返回值；成功回 `{ accepted: true, state, hint }`，结果仍由对方那一段结算后自己推回来 |
| F-C21 | **回投跟着每一次段结算；段开始复位；并发限额** | S | D38。派生会话的每一段结算都投一次（一段一次）；段开始那一拍把记录复位成 `running`，于是 `read_session_status` 不在跑着时答 `idle`；每个父对话同时最多 **4** 个 running 的 peer，超了 `too_many_peers` |

### 7.4 上下文阈值与任务交接

| 编号 | 要什么 | 落点 | 边界 / 依据 |
|---|---|---|---|
| F-D1 | 两条阈值：交接线、硬线 | S | 形状沿用 SDK（D27）；先提醒、后阻断 |
| F-D2 | 到交接线时**问用户**：自交接 / 独立摘要 / 不交接 | S+C | D22：问题对象；触发在对话停下之后；呈现归客户端 |
| F-D3 | 迁移＝开新对话，旧对话完整保留 | S | D18；不再有「物理剔除旧历史」这一说 |
| F-D4 | 只产交接文档、不换会话，可反复打磨同一份 | S | — |
| F-D5 | 交接 + 开新会话一步完成 | S | — |
| F-D6 | 交接文档写进项目 `<cwd>/.ai-zen/handoffs/` | S | D19；模板来自磁盘上的 `handoff` Skill |
| F-D7 | 降级要说明；用户取消＝回到交接前，不重试不报错 | S+C | 报成「失败」会让人以为坏了 |
| F-D8 | 子 Agent 也受同一道硬线约束（含孙级） | S | 只护主 Agent 等于没护 |
| F-D9 | 告诉模型「现在在哪个目录」 | S | 会话创建时写一条**独立的、不展示的** `user` 消息（`hidden`）；每轮不重复注入；cwd 来自 Workspace 而非进程 |
| F-D10 | 越过硬线：**两端都拒绝**，问题对象继续挂着 | S+C | D23 |
| F-D11 | **压缩按会话类型归一**：派生会话越线自动压（不弹问）；用户会话仍由宿主在停下来的那一轮**问** | S | 派生会话一律不问（哪怕用户亲自在子会话里说话那一轮）；会话行上用 `compactedAt` / `compactionMode`（`auto` / `manual`）留标记，可空 = 从来没压过；只产文档不换会话不算压缩；插件压的 `auto` 在迁移成功之后才记 |

### 7.5 命令暴露面

| 编号 | 要什么 | 落点 | 边界 / 依据 |
|---|---|---|---|
| F-E1 | 这些能力都要有对应入口：存档 / 加载 / 新建 / 撤回 / 清屏 / 配置 / 换模型 / 换助手 / 重载 / 升级 / **切换工作区** / **关闭宿主** / 指令 / 帮助 / 退出 | S+C | 命令名与别名是客户端的事；能力在宿主。**本版 TUI CLI 的命令集口径**：`/ws` 是工作区的实体入口；`/shutdown` 是显式关闭宿主；撤回主名 `/back`（`/revert` 为别名）；`/pin` 保留；**没有 `/search`** |
| F-E2 | 改完配置不用重启就生效（重连 MCP、重发现工具 / Skill），消息与上下文保留 | S | D34：**就地刷新**，实例还是同一个，正在跑的那一轮也不会被抽掉能力；已经拿着旧模型客户端的 agent 交给 `invalidate` 换掉。出网报 `refreshedWorkspaceIds`。要求重启等于惩罚用户改配置 |
| F-E3 | 升级有两条链：宿主自己升级（检测版本号、确认完成后立即重启）；**CLI 侧的升级 = 按自己声明的 semver range 拉一个满足范围的最新版宿主**（L14），且**下载过程要看得见** | S+C | D4 + L14；宿主不自装包；重启瞬刻在跑的轮次会断（已知代价） |
| F-E4 | 直达入口（改密钥、看 MCP、切语言） | S+C | `/lang` 是连接级（D8） |
| F-E5 | 帮助由**客户端自己的命令清单**渲染（命令是客户端概念：宿主只认方法名，不知道 `/back` `/pin` 是什么），未知指令指向帮助 | C | 文案归界面、事实归宿主。曾经的「帮助由能力清单渲染」已作废（A13 / R6） |
| F-E6 | 阻塞型操作执行期间要能显示「正在执行什么」 | C（属性与显示）、S（真在跑什么） | 「这个操作会阻塞」是**客户端命令表**上的一个字段，不是宿主的能力属性；正在跑什么是 `conversation.state` 的 `run.generation` 与六个 `run.state` 事件 |

### 7.6 配置

| 编号 | 要什么 | 落点 | 边界 / 依据 |
|---|---|---|---|
| F-F1 | 一处管完所有配置；改完即生效；没有全局「保存」键 | S+C | D21：读写都走宿主 API；没有「改了没保存」这种状态 |
| F-F2 | 端点：名称 / BaseURL / 密钥（掩码显示）/ 描述；被引用时禁删并列出引用者 | S | 「为什么不能删」和「我该先做什么」一起给 |
| F-F3 | 模型：名称 / 端点 / 模型名 / 思考策略 / 两条阈值 / 视觉 / 描述；出厂托管 vs 自定义；恢复出厂 | S | 编辑即转自定义（否则下轮被冲回去）；恢复出厂是整条替换；**两条阈值可以不给**，不给就由宿主套出厂默认 |
| F-F4 | 图片模型 + 默认图片模型（生成能力） | S | D6；**图片模型不做恢复出厂**（暂时没这个需求），所以也不补对称的方法 |
| F-F5 | 助手与子 Agent 定义编辑（提示词与子 Agent 定义都要读得回来，F-B2）；删除默认助手时连带清默认；**助手也能恢复出厂**（与模型同形，可先预演不落盘） | S | 任何指向关系删除前都要问「还有谁指它」；助手定义是文件，改完即生效（F-E2） |
| F-F6 | MCP 屏：两作用域可编辑；条目字段齐全（传输方式与它的参数）；**按 id 增删改**；`oauth` 与未知字段原样保留；**用户级那层坏了就恢复出厂** | S | 「文件不存在」与「文件坏了」必须分开（以前都当空配置，一保存就覆盖）；**哪个作用域可编辑由宿主点名**；不认识的键写回时原样带上 |
| F-F7 | 默认项：默认助手、**全局兜底模型**、默认迁移模型、默认图片模型、取名模型 | S | 删模型时默认指向要自动改指或清空 |
| F-F8 | 工具输出上限 | S | — |
| F-F9 | 不可撤销的动作要二次确认；一次改动合成一条通知 | S+C | 通知栏位有限，逐条推会互相覆盖 |

### 7.7 发现与合并

| 编号 | 要什么 | 落点 | 边界 / 依据 |
|---|---|---|---|
| F-G1 | MCP 5 层链，可编辑的只有 2 个作用域（`<ws>/.ai-zen/mcp.json`、`<aiZenDir>/mcp.json`） | S | L9 |
| F-G2 | Skill 4 层目录、工具与子 Agent 各 2 层，只发现真实存在的目录 | S | 离项目越近越优先；数据根下的名字是 `sub-agents`（跟 SDK 的 `CONFIG_SUB_DIRS` 走） |
| F-G3 | 助手定义一实体一文件（能进 git、能手改） | S | 对话是用户数据（进库），助手定义是配置（仍是文件） |

### 7.8 输入与附件

| 编号 | 要什么 | 落点 | 边界 / 依据 |
|---|---|---|---|
| F-H1 | 多行输入、限高、窗口跟随光标 | C | — |
| F-H2 | 像正经编辑器的键位（移光标、按词、kill ring、撤销、暂存草稿、粘贴、防误退出） | C | — |
| F-H3 | 输入历史＝这段对话里的用户消息（带图消息连图一起恢复） | C | 数据本来就来自宿主消息，不另维护一份 |
| F-H4 | `/` 菜单与 `@` 菜单 | C | — |
| F-H5 | `@` 文件补全的数据来源 | S | D7：远程前端看不到目录 |
| F-H6 | 粘贴：先问剪贴板图片，再退回文本；超限报错不截断；4 张/条 | C | 剪贴板是本机能力；远程靠 D5 的上传入口 |
| F-H7 | 图片变成消息内容：文本段在前、按实发模型选传输方式、失败要告警、全失败退回纯文本 | S | 绝不假成功。库里只有段上的 `__asset_id`；厂商产物是「这一次发送」的产物，换模型 / 端点 / 重启后再发时由宿主重新还原；发出去的那一份按 core 的字段白名单重建，`__` 开头的键一律不出网 |
| F-H8 | 附件体积与引用 | S | D5。`assets` 是**唯一真相**（`sha256` 全局唯一 + 宽高），不记归属；「谁引用了它」在 `conversation_assets`；厂商 `file_id` 另存缓存表 `asset_vendor_files`（这个端点上有就直接用、换端点内联 base64、都没有才上传一次；失败就报失败，不重试 / 不判失效 / 不做过期清理）。按 id 取回走 `asset.get`（缩略图本波等同原图） |

### 7.9 状态、通知与展示

| 编号 | 要什么 | 落点 | 边界 / 依据 |
|---|---|---|---|
| F-I1 | 消息渲染（源码着色、代码高亮、工具调用压一行、已失效消息加删除线） | C | 「这条是否还在上下文里」是宿主给的事实 |
| F-I2 | 单条助手消息内部顺序恒定（思考 → 工具调用 → 正文） | S | — |
| F-I3 | 生成六态：连上 / 等首字 / 在想 / 在输出 / 拼工具调用 / 等哪几个工具 | S+C | L8；并行工具只念还在跑的 |
| F-I4 | 生成中有活的信号 | C | — |
| F-I5 | token：本轮、累计（含子 Agent）、速率 | S | 累计漏了子 Agent，用户会发现账单比界面大。**只有一个口径**：这段对话的现场那份用量（`conversation.state.usage`）；不再有「按项目 / 整机聚合」的接口 |
| F-I6 | 状态栏内容要能按块排布 | S+C | 字段结构化，不能给一坨字符串。**块由客户端拼**（宿主只给事实）：宿主拼好的那份副本只在拉状态那一刻成立，聊天过程中上下文百分比 / 模型名 / 本轮 tokens / 在跑的工具会全冻在那一刻 |
| F-I7 | 子 Agent 的存在、状态、各自的消息可回看 | S+C | 失败必须显示失败；重开一段跑过的对话也要给得出来（F-I15） |
| F-I8 | 通知：独立通道、绝不进消息、三档语气、带持续时间 | S | L3 / R4 |
| F-I9 | 问题要能被多端看到、能被回答；**桌面端要做完整的问答视图**（不是只把死路堵上） | S+C | D22：问题对象；确认框这类交互归客户端。桌面端排期见 PLAN W4 |
| F-I10 | 布局：整帧高度稳定、输入框吸底、禁止二次折行 | C | — |
| F-I11 | 空会话的欢迎内容 | C | — |
| F-I12 | 提交后立刻回显 | C | 宿主要保证「受理了就不会静默丢」：排队的那些可按回包的 `userMessageId` 先画；但「这一轮一定把它发出去」不保证（D14 的收尾钩子窗口） |
| F-I13 | 打开一段对话时，状态栏那份事实与列出的消息来自**同一刻**，且只付一次往返 | S+C | 分两次取会在两次请求之间夹进新消息。宿主提供开关（`includeMessages`），只要状态的调用方不为消息付费 |
| F-I14 | 排队条目要看得见：这一轮里还有哪几句排队的用户输入没落地 | S+C | D14。`RunState.inbox` = 这一轮 agent 的 inbox 条目数组（`messageId` / `source` / `createdAt` / `preview`，顺序即取件顺序），计数取 `inbox.length`，不另给一个数字（数字会与数组分叉）；空闲时是空数组不是「未知」；只给一行摘要而不给原文（`run.state` 每次换态都推一次） |
| F-I15 | **重开一段跑过子 Agent 的对话，子代理页签不该是空的** | S | F-I7 的续：空闲现场也要给出历次委派的子 Agent 快照；推不出终态时按最弱的一档给（子 Agent 自己有 error 行 → `error`；父工具结果 → `done` / `error` / `aborted`）——契约里没有「悄悄消失」这一档；没有可信事实的 `finishedAt` / `problem` 宁可 `null`，不编 |

### 7.10 语言、日志、诊断

| 编号 | 要什么 | 落点 | 边界 / 依据 |
|---|---|---|---|
| F-J1 | 界面文案多语言 | S | D8：语言挂连接；缺省英文；入库存码 + 参数、读取时渲染 |
| F-J2 | 宿主日志落文件（轮转），warn / error 也上通知 | S | 界面被占用时，日志必须另有去处 |
| F-J3 | 按键诊断开关 | C | — |
| F-J4 | `AI_ZEN_DIR` 等环境变量 | S+C | 数据根必须可改（测试与多实例）；其余归客户端 |

### 7.11 退出与终端安全

| 编号 | 要什么 | 落点 | 边界 / 依据 |
|---|---|---|---|
| F-K1 | 防止误退出（`Ctrl+D` 双击等） | C | — |
| F-K2 | 退出要还终端（关鼠标上报、关 raw mode、恢复光标） | C | — |
| F-K3 | 管道下游关闭（EPIPE）按正常结束处理 | C | 下游不读了不是错误 |

---

## 8. 契约口径（形状层面不许变的东西）

- **消息与内容**：消息本体、内容段、工具调用、消息状态、流式增量、用量一律是 `@ai-zen/agents-core` 的导出形状（R21 / R75）。wire 只给「非消息事实」包薄外壳，不得重新定义上面那六样。
- **本地扩展只有一个**：内容段上的 `__asset_id`（D5 / R23）；发送前按当时模型还原成真段，`__` 开头的键不出网。
- **`hidden`**：参与模型上下文，`message.list` 默认不返回、侧栏条数与删除代价都不数它。
- **错误**：JSON-RPC `error` + `data.code`（13 个稳定业务码：`unauthorized` / `invalid_params` / `not_found` / `busy` / `payload_too_large` / `unsupported` / `internal` / `config_invalid` / `mcp_unavailable` / `model_unsupported` / `handoff_declined` / `question_pending` / `context_guard`）；数字码只做粗分类；`data.message` 是按连接语言渲染的人话；结构性事实放 `data.detail`，不让客户端解析句子。
- **事件**：6 个（`run.state` / `message.delta` / `conversation.changed` / `notice` / `question` / `usage`），无 id 的 JSON-RPC 通知；不重放、不需要 ack，断线即作废，重连按 D5 自己拉。
- **推送里存码不存句子**：通知、问题入库存 `code` + `params`，出网时按这条连接的语言渲染（D8）。
- **计数口径**：`total` 是下界（R36）；`messageCount` 是内存数（R48），只是「去拉一下」的信号。
- **拒绝用返回值不用抛错**：`depth_exceeded` / `model_unresolved` / `too_many_peers` / `not_allowed` / `gone`；`dropped` 出声一次，不重试、不补投。
- **方法名**：`<域>.<动作>`；方法总数与分域见 PLAN（62 条 / 13 域）—— 那份是唯一出处，这里不重复点数。

---

## 9. 没做的清单

| 不做 / 没做 | 理由 |
|---|---|
| 兼容旧版前端 / 双接口 / 为旧版保留字段 | L1：一套就是一套 |
| 迁移或识别旧数据 | L1：新库从空开始 |
| `Origin` 白名单 | L10 |
| 账号、登录、按人分权限；用凭证区分「人」 | L12 / L13：设备不是人，凭证多串只是为了能单独吊销 |
| 客户端管凭证（创建 / 列出 / 吊销） | L13：凭据归宿主；客户端只有「连接管理 + 记住密码」 |
| 图片模型恢复出厂 | 暂时没这个需求，所以也不补对称的方法 |
| TUI CLI 的搜索 | 一阶段不做；搜索是桌面端的一个搜索框（F-C6） |
| 自动重连多次、宿主补发事件 | L5：重连是客户端的事；在线才推 |
| 跨设备共享「语言偏好」 | D8：语言挂连接，断开即忘 |
| 消息分叉 | D24：列为后续能力 |
| 宿主替用户决定「要不要迁移」 | D22：问，且问的对象可持久化 |
| 平级会话的阶段 3（超时与 abort、`/sessions` 的「agent 建的」标记、`peer_sessions` 表与跨重启的孤儿处理 / 补投） | 阶段 1 做最小闭环，阶段 2 加了 `send_to_session` / 回投跟结算 / 段开始复位 / 并发限额（D38）；上面这几件**都还没做** |
| agent 每轮重新装配即弃 | D28：一段对话一个 agent，常驻、跨轮复用；它的 `messages` 就是这段对话的内存真相 |
| Scope 空闲回收 / 引用计数 / 计时器 | D28：拆只有一个原因——有人显式 `dispose`（项目被删）或进程收尾 |
| 配置改动拆重建 Scope | D34：就地 `refresh()` + 换掉受影响的 agent，实例还是同一个 |
| 能力清单（`host.capabilities`） | 两端零消费者，2026-11-14 整体删除（A13 / R6 / R57 作废） |
| 宿主侧拼好的状态栏块（`statusBlocks`） | 副本必然过期（同一批事实存两份），块改由客户端现拼（R65 作废） |
| 子 Agent 消息的回看写入（生产路径） | `parentToolCallId` 列与读数都在，但**没有写入方**：`message.list(toolCallId)` 取到的是那次委派的工具结果消息（见 PLAN 欠账） |
| 客户端自造问题（`question.ask`） | 契约只有 `question.list` / `question.answer`；问题由宿主内部产生（交接线 / 登记 / 二次确认）。集成用例因此绕开契约直开库造一行 |
| 平级会话编排元数据落库 | `PeerSessionService` 的 `records` 只是一个进程内 `Map`：重启之后子会话就是普通会话，`read_session_status` / `send_to_session` 对它回 `gone` |
