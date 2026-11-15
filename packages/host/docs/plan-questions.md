# 实施过程中的问题（按波次实施者追加，PM 统一裁定）

- [src/wire/methods.ts] D3 的临时对话（`conversation.transient`）无 id、不落库，可 `run.state` / `message.delta` 事件的载荷里是必填 `conversationId`：临时对话的流式事件用什么标识来关联这一段流？
- [src/wire/methods.ts] D2 要的「取名模型」在 SDK `AppConfig` 里没有对应字段（只有 `autoTitle` 开关），我按 D2 在 `DefaultSelection.namingModel` 里加了它：这个字段是进 SDK 配置，还是宿主在数据根另存一处？
- [src/wire/methods.ts] PRD F-B1 说「配置层不另存默认模型」，但 SDK `AppConfig.defaultModel` 是三级解析的兜底层：`DefaultSelection.defaultModel` 该保留（照 SDK 事实）还是从契约里去掉（照 F-B1）？
- [src/wire/methods.ts] 「三档语气」具体是哪三档？我取 `info / warning / error`（要承接 F-J2 的 warn/error 上通知），但「已保存」这种一秒提示读起来更像 success。
- [src/wire/methods.ts] F-B5「换助手只改默认」里的「默认」是全局一份（SDK 的 `AppConfig.defaultAgent`）还是每个 Workspace 各一份？我目前只做了全局的 `config.setDefaults`。
- [src/wire/methods.ts] F-E5 的能力清单需要一个独立方法（我建了 `host.capabilities`），还是塞进 `host.hello` 的 result 就够？两处现在都能拿到清单。
- [src/wire/methods.ts] F-F9「不可撤销的动作要二次确认」我做成了删除类方法的 `dryRun: true`（先取代价、再真删）两步走，客户端能否接受这种形状（而不是一个 `confirm: true` 参数）？
- [src/wire/methods.ts] `conversation.get`（元信息）与 `conversation.state`（现场：六态、阈值、问题、用量）分成两个方法，是否需要合成一个以减少一次往返？
- [src/wire/methods.ts] F-I7 的子 Agent 消息回看，我加在 `message.list` 的 `toolCallId` 参数上；是否改为独立的 `message.listSubAgent`？
- [src/wire/states.ts] 撤回是硬删（D24），消息不再返回，所以契约里没有「这里曾经有过消息」的标记；客户端展示上需不需要这个事实（例如留一个删除占位）？
- [src/wire/frames.ts] 收到数组（批量请求）时我用 `unsupported` 拒；如果客户端希望按「参数不对」处理，可以换成 `invalid_params`，请定一个。
- [src/config.ts] `resolveListenTarget` 遇到手写错的端口（0 / 越界 / 非整数）我按「当作没给」回落到下一级；要不要改成直接报 `config_invalid` 让用户看见写错了？
- [src/config.ts] plan 的 `HostPaths` 只有数据根下五条路径，architecture §2 的目录图里还有 `agents/`、`skills/`、`tools/`、`subagents/`、`mcp.json`：这些路径由 `config.ts` 给出（`HostPaths` 加字段），还是由 SDK `ConfigManager` 自己推导？
- [src/wire/states.ts] 消息本体换成 core 的 `AgentNS.Message` 之后，消息的 `createdAt` / `updatedAt` 没有位置了（core 的 `Message` 没有时间字段）：接受「只按数组顺序、界面不显示每条时间」，还是要一个薄外壳 `{ message: AgentNS.Message; createdAt; updatedAt }`（多包一层）？
- [src/wire/states.ts] 用户输入里的「已上传却没变成内容段的素材」在 core 的内容段类型里没有对应（`image_url` 要 URL、`file` 要 `file_id` / `file_data`），我用了 `MessageInput { content: AgentNS.MessageContent; assetIds?: string[] }`，`assetIds` 只当定位、由宿主按实发模型转成内容段（F-H7）：这个外壳形状认不认？
- [src/wire/states.ts] 工具失败的文案键 `message.toolFailed` / `message.toolAborted` 原本挂在 `ToolCallSegment.problem` 上；工具调用改成 core 的 `ToolCall` + `role=tool` 消息之后没有这个字段了，我已把两条键删掉（失败的说明由工具消息自己的内容承载）。若 PM 要工具失败仍以 `ProblemFact` 出网，需要指定它挂在哪个字段上。
- [src/wire/events.ts] `message.delta` 的外壳去掉了 `segment` 与 `messageStatus`：属于哪一段由 `AgentNS.Delta` 自己带的字段（`content` / `reasoning_content` / `tool_calls`）表达，消息状态走 `run.state`。要不要在 delta 事件里继续带一份状态快照？
- [src/wire/states.ts] 上下文阈值状态里的输入用量从单个 `promptTokens` 数字改成了 core 的 `usage: AgentNS.Usage`（占用看 `usage.prompt_tokens`）：界面只要一个数的话，是否认可从 `usage.prompt_tokens` 取？
- [src/wire/methods.ts] `conversation.transient` 的出参从 `segments` / `text` / `usage` 三样改成 core 的一条 `AgentNS.Message`（内容、用量都在消息上，累计用 core 的 `sumUsage`）：一次性脚本要「拼好的正文」时从 `message.content` 取，还是要单独再给一个 `text` 字段（那是重复字段）？
- [src/wire/states.ts] 子 Agent 的运行状态目前仍自造 `running | done | error | aborted`（core 只有**消息**状态，没有子 Agent 生命周期）：保持现状，还是改成 `AgentNS.MessageStatus` 的取值？
- [src/wire/states.ts] R21 里写的 core 消息字段是 `omitted`，core 实际导出的是 `omit`（`AgentNS.Message.omit`）；我按 core 的 `omit` 写（旧计划文件里那处描述已随该文件删除，此条只需记着 core 的口径）。
- [src/storage/migrations.ts] R14 / R18 是改表结构，而 SQLite 不能就地给已有列加 NOT NULL（要整表重建，事务里重建父表会触发外键级联删除）。这套表结构还没随版本发出去（`~/.ai-zen` 下也还没有库），所以我把两条裁定直接落进 v1 的建表语句、没有追加 v2；如果 PM 认为 v1 已经算「发过一版」，需要改成 v2 迁移，并且要定「库里已有重复 cwd / NULL 身份的旧行」怎么处理（报错、去重、还是丢弃）。
- [src/storage/Database.ts] R19 我实现成声明式批次：`tx` 回调只能登记 `all/get/run`，结果按回调返回的凭据回传（读与写在同一条 worker 消息、同一个事务里串行）。因此「读到值再在 JS 里决定下一条写什么」仍然做不到（要那样得让 worker 等主线程，R19 明确不许）；需要分支的场合把条件写进 SQL。这个取舍认不认？
- [src/storage/types.ts] W1 的 `MessageContentSection` 是仓储自造的宽松形状（`{ type?: string; text?: string; [key: string]: unknown }`），与 R21「消息内容段一律用 core 的 `AgentNS.MessageContentSection`」冲突；`src/services/MessageService.ts` 里已经因此报类型不兼容（TS2677）。这不在 W2-S 的三件事范围内，我没有改，请定由谁把 storage 的行类型换成 core 的导出。
- [src/services/WorkspaceService.ts] `workspace.remove` / `conversation.delete` 的出参里没有「要清哪些素材文件」的位置，我让服务方法返回 wire 结果的超集（多一个 `assetPaths`）；要不要把 `assetPaths` 加进 `RemovalConsequences`，还是由 app 层去问 AssetService？
- [src/services/WorkspaceService.ts] `workspaces` 表没有 `updatedAt` 列，`WorkspaceView.updatedAt` 我拿「名下对话最近一次变化」充当、没有对话时等于创建时间；要真值得给表加列。
- [src/services/ConversationService.ts] `ConversationSummary.nameIsAuto` 在库里没有真值，我按「名字是否还等于创建时间那个原名」推：自动命名（D2 / W4-H）之后名字一变就会被读成「用户改过」。要不要给对话行加 `renamedByUser` / `nameIsAuto` 列？
- [src/services/SearchService.ts] `MessageRepository.search` 没有偏移与计数入口：`offset` 由我先取 `offset+limit` 再切片，`total` 在结果数不到取数上限时准确、否则只是下界。要给仓储加 `offset` 参数与一个计数查询吗？
- [src/services/MessageService.ts] F-I7 的 `message.list(toolCallId)` 在存储里没有对应线索：我按消息 `data.tool_call_id` 过滤，捞到的是「那次委派的工具结果消息」，子 Agent 自己那几条消息目前读不出来。子 Agent 消息靠什么关联到父工具调用（加一列 `parentToolCallId`？）
- [src/services/ConversationService.ts] `conversation.create` 的两条失败（助手没绑模型且配置无兜底模型 / 配置指向不存在的模型）现在借用 `error.configInvalid` 的 `{reason}` 塞英文短语；要加专键（如 `error.modelUnresolved`）吗？（i18n 归 W1-B / PM）
- [src/services/WorkspaceService.ts] 同一个 cwd 再登记一次我报 `invalid_params`（`detail.reason=already_registered`）而不是幂等返回已有项目：显式添加可能被多端同时点，要幂等吗？
- [src/services/ConversationService.ts] 撤回时若这段对话正在跑一轮，我报 `busy`（要删的正是流式还在写的那几条）。认不认这条前置？
- [src/services/ConversationService.ts] `conversation.setThinking` 的「当前档」按「助手定义上的 `modelParams` 恰好覆盖某一档补丁」反推（F-B6 写进去的是参数不是档位名）；多档补丁互为子集时取策略表里的第一个。要更严格的判定就得另有地方记「当前档」。
- [src/services/CredentialService.ts] 对已经吊销过的凭证再吊销一次，我回 `revoked: false`（与 `notice.dismiss` 的 `dismissed` 同口径：这次有没有真的改动库），而不是幂等 true。
- [src/services/MessageService.ts] storage 的 `MessageContentSection` 与 core 的不兼容（TS2677）我在服务层按 core 形状逐段重建绕过了，没有改 storage 的行类型；要统一得由 storage 换成 core 的导出（与 storage 实施者那条重复，按一条算）。
- [src/services/ConversationService.ts] 删对话 / 删项目我只通知运行时 `forget(conversationId)`；「Workspace 被删 → 回收它的 Scope」（architecture §4 三因之二）不在这个窄接口里，需要 app.ts 或运行时在项目删除后自己回收。
- [src/runtime/ChatRunner.ts] F-H7 的「`assetIds` → 内容段」这一步（按实发模型选 file 引用 / 内联 / 退化成文字）宿主还没有实现者：我留了 `prepareAttachments` 注入点，未注入时 `assetIds` 被忽略、`attachments` 回空数组。这一步归 AssetService（W2-C）还是 W4 的素材层？
- [src/runtime/ChatRunner.ts] core 在 `run()` 的 catch 里会把在途 assistant 无条件改成 `Error`（用户 abort 时也一样），而 D15 要求「在途消息以 `Aborted` 落库」：我按 D15 落 `Aborted`，用 `run.state.outcome = "aborted"` + `problem = null` 区分「用户停的」与「真出错」，装载时 `reconcile(keep)` 会把它修回 `Completed`。这个「库里记发生过什么、内存按 core 策略」的口径认不认？
- [src/runtime/ChatRunner.ts] `run.state` 只在「换态」或「还在跑的工具列表变了」时推（字符数不逐片刷，逐片的增量在 `message.delta` 里）；若客户端要实时字数，得在接线层累加 delta，或改成节流推快照。
- [src/runtime/ChatRunner.ts] 受理之后事件立即开始推，可能早于 `conversation.send` 的回包（客户端那时还没拿到 `assistantMessageId`）：由接线层缓冲到回包写完再放行推送，还是客户端按 `conversationId` 缓冲未知 messageId？（我倾向前者，归 W3-E）
- [src/runtime/ChatRunner.ts] `conversation.changed` 的 `messageCount` 我填的是「进这一轮时的历史条数 + 本轮产出条数」（内存里的数），不是库里的精确计数；要精确得由服务层查一次。
- [src/runtime/ChatRunner.ts] D3/R1 的临时对话不入库、不推流式事件，而 `ChatRunner` 的骨架就是「落库 + 推事件」：临时对话要不要一个不落库的变体（只借 Scope、跑完把消息一次返回），还是它根本不走 `ChatRunner`？
- [src/runtime/ChatRunner.ts] `createSdkAgentFactory` 的交接线插件要注入 `HandoffService`（用它的 `busy` 与交接回合钩子）；未注入时 `AutoMigratePlugin` 与交接工具守卫都不装 —— 没有交接服务就无从交接。这个降级要不要在装配处报一次 warn／通知？
- [src/runtime/ChatRunner.ts] 服务层的 `ConversationRuntimePort` 里有「临时换模型 / 临时思考档位 / forget」三样进程内状态，但它们只有装配 agent 时才用得上：我在 `SdkAgentFactoryOptions` 留了 `resolveModelId` / `resolveModelParams` 两个缝，`ChatRunner.forget()` 也已提供；这三样状态的**持有者**要不要放进 `runtime/`（现在只有服务层契约、没有实现者）？
- ~~[src/runtime/ScopeRegistry.ts] `recycleAll()`（配置变更重连 MCP，F-E2）我实现成「空闲的立刻销毁，正被持有的打标记、最后一次 `release` 时销毁」……~~ **已改口径（2026-11-15，以代码为准）**：配置变更不再拆任何 Scope，改成对已存在的 Scope 调 `refresh()` 就地重读配置 + 让各插件重新发现（MCP 连接按定义对账断旧的），实例还是同一个；agent 靠 `AgentRegistry.invalidate` 换掉（空闲的当场退役、在跑的结算时退役）。`ScopeRegistry` 现在的公开面只有 `create` / `get` / `refreshWorkspace` / `dispose` / `disposeAll` / `workspaceIds`（PRD D34）。
- ~~[src/runtime/ScopeRegistry.ts] plan §1 的回调名是 `onIdle(cb)`、任务描述是 `onAllRecycled(cb)`……~~ **无对象了（2026-11-15，以代码为准）**：空闲回收整个撤掉了，既没有 `onIdle` 也没有「全部回收完」这个回调 —— Scope 不再自己消失（PRD D28）。
- [src/runtime/ScopeRegistry.ts] `createWorkspaceScopeFactory` 只做 SDK 口径的装配（`allInOne` 五类插件 + `init()`）；MCP 的 5 层链（L9）与 skills / tools / sub-agents 的各层目录要由接线层按 cwd 算好传进来（这两件事归配置层 W4-G）。
- [src/runtime/RunRegistry.ts] （自决）忙即拒的 `HostError("busy")` 在 `detail` 里带 `{ conversationId, startedAt, aborted }`：文案键 `error.busy` 没有占位符，所以「在忙什么」这个事实只放结构化字段里，不改文案。
- [src/runtime/ChatRunner.ts] （自决）一轮的用量三个口径定为：`turn` = 本轮全部产出消息的 `sumUsage`（含本轮子 Agent）、`total` = 历史 + 本轮、`subAgent` = 全部消息里 `subAgentUsage` 之和；`rate` 按输出 token / 秒、两位小数。
- [src/runtime/ChatRunner.ts] （自决）assistant 占位与用户消息的 id 由宿主先分配并落库，core 在 `send()` 里自己追加的那两条在 `message` 事件里被认领成这两个 id；工具轮次里后续追加的消息各分配一个新 id（`id` 不参与 core 的任何判断）。
- [src/runtime/ChatRunner.ts] （自决）`reconcile(conversationId)` 既做「重启修复」也在每轮开始时调用（装载即修复）：只写回 `status` / `omit` 真的变了的行，所以常态下多出来的写库次数为 0。
- [src/runtime/ChatRunner.ts] （自决）工具结果消息一被追加就先落一行（`pending`），这样进程中间没了也能从库里看出「这个工具参与了、但没定型」；最终版仍在内循环结束时一次性写。
- [src/storage/types.ts] R35 / R37 落成必填字段（`Conversation.nameIsAuto`、`StoredMessage.parentToolCallId`）之后，`src/runtime/ChatRunner.test.ts`（`makeConversation` 与一个 `StoredMessage` 字面量）与 `src/runtime/TestSupport.ts`（`toStored`）三处假数据要各补一行字段，才能让 `npx tsc --noEmit -p tsconfig.test.json` 回到全绿；`src/runtime/**` 不在我的可改范围，请让运行时实施者补（`nameIsAuto: true` / `parentToolCallId: null`），或授权我改这三行。`tsconfig.json`（不含 `*.test.ts`）已经是零错误。
- [src/storage/types.ts] （自决）`StoredMessage.content` 的类型是 `AgentNS.MessageContent | null`：core 的 `MessageContent` 没有 `null`，这里的 `null` 只表示「这一行没有正文」（`content` 列存的是 JSON `null`），服务层照此不往消息上挂空 `content`。不引入第三种形状。
- [src/storage/MessageRepository.ts] （自决）`parentToolCallId` 在 upsert 的冲突分支里用 `COALESCE`：流式过程里同一条消息会被反复写，不带上这一列的那些写不会把已记下的归属抹掉。代价是写进去之后没法再改回 `NULL`。另：读数方法 `listByParentToolCallId(conversationId, parentToolCallId)` 带对话范围（工具调用 id 只在它所属的那段对话里有意义）。
- [src/net/UploadReceiver.ts] 上传的二进制帧在契约里只叫 `asset.chunk`，没有定义「帧里怎么标出是哪个上传」：我定成 `[4 字节大端头长度 N][N 字节 UTF-8 JSON {"uploadId": ...}][片段字节]`（`net/UploadReceiver.ts` 的 `encodeChunkFrame` / `decodeChunkFrame` 是唯一一份编码实现，客户端直接复用）。这个帧格式要写进 `architecture.md` §6 与客户端契约吗？
- [src/net/UploadReceiver.ts] `asset.begin` 的 `conversationId` 在契约里是可选，但 `assets` 表那一列是 `NOT NULL` 外键、按引用清理也按对话走：没有对话归属的上传无法登记，所以我让 `asset.begin` 直接拒（`invalid_params` + `detail.reason=conversation_required`），而不是收完再失败或留一个没人认领的文件。若要支持 D3 临时对话带图（`conversation.transient` 没有对话 id），需要为「无对话归属的素材」定一个归属口径（内存态临时素材 / 素材表允许空对话）。
- [src/services/AssetService.ts] F-H7 的三种结局里，「端点声明 Files API 但上传失败、SDK 降级为内联」与「模型读不了图、退化成文字」不是一回事：后者有文案键（`message.imageAsText`），前者 SDK 只给一句英文 `warning`，`AttachmentOutcome` 里没有「降级但送达」的键，现在 `problem` 为 null（客户端看不到这条告警）。要加一条键（例如 `attachment.inlinedAfterUploadFailed`）吗？
- [src/services/AssetService.ts] `attachments[].problem.message` 是按默认语言（英文）渲染的：素材转换发生在 `ChatRunner` 那一轮里，那一层拿不到「这是哪条连接」。`LocalizedText` 带了 `messageKey` + `params`，所以 `conversation.send` 的 handler（W3-F / W4）可以按连接语言重渲染一次再出网 —— 这个重渲染点定在接线层认不认？
- [src/services/AssetService.ts] 上传上限是 20MB/张（D5），而 SDK 内联（base64）上限是 8MiB：端点没有 Files API 时会有一档「允许上传、但发不出去」的图片（结局是 `dropped` + 告警）。要不要在上传时按「该对话当前模型能走哪条路」提前拒（F-H7「失败要告警」vs 用户体验）？
- [src/net/WsHub.ts] 架构 §6 写「推送的 `params` 里带事件名与数据」，而契约层 `wire/frames.ts` 的 `notification()` 把事件名放在 `method`、载荷直接放 `params`：接线层照契约实现（客户端按 `method` 分支即可），没有在 `params` 里再塞一份事件名。要统一成哪种形状（改文档还是改帧）？
- [src/net/WsHub.ts] `host.hello` 与 `host.setLanguage` 由接线层自己实现（语言是连接状态，业务层不该管），`asset.begin` / `asset.end` 在上传接收器注入时也由接线层接管；其余方法一律进注入的 handler 表。这三处「接线层代管」的口径要写进 architecture §6 吗？
- [src/net/WsHub.ts] R47 的缓冲按「请求参数里的 `conversationId`」挂起该对话的推送，回包写完按序放行：这意味着 `message.list`、`conversation.abort` 这类同对话的请求也会短暂缓冲同对话的事件。认这个口径，还是只对 `conversation.send` 这类「受理即返回」的方法缓冲？
- [src/app.ts] R13 说 `HostPaths` 加 `configFile`，但 `config.ts` 里没有这个字段：我在 `app.ts` 按 `<dataRoot>/config.json` 拼出来交给 SDK 的 `ConfigManager`。要让 `config.ts` 补这个字段（并把 R13 的落点写对）吗？
- [src/app.ts] 启动时调了一次 SDK 的 `ConfigManager.bootstrap()`（目录 + config.json + 默认助手 / 子 Agent + mcp.json + 出厂 skills + 思考策略表）：这属于「配置层」的财产，本轮由单根代做，W4-G 若有别的口径（例如只 `ensureDirs`、其余由 ConfigService 管）请指定。
- ~~[src/app.ts] 退出判据缺一个触发源：`WsHub` 只提供 `connectionInfos()`（拉），没有「连接数变化」的回调……~~ **已补（2026-11-15，以代码为准）**：`WsHub` 现在有 `onConnectionsChanged`，1s 巡检早已撤掉；退出判据只剩两条（连接数 0 且已经握过手、没有在跑的轮次），`ScopeRegistry` 也不再参与判据（PRD D37）。
- [src/app.ts] L4 的「没有活对话也没有连接后进程退出」在刚启动时会把「还没人来连」判成该退出：我加了「至少服务过一条连接（握手成功或连上过）之后才判退出」的口径。认不认？
- [src/app.ts] `conversation.state` 没有服务层实现者（`ConversationService` 只有 get/list/rename/…）：我在 `app.ts` 把「视图 + 这一轮的 `RunState` + 库里消息求和 + 模型阈值」拼成 `ConversationState`；其中 `questions` 与 `statusBlocks` 先空着（问题对象归 W4-H、状态栏块归 W4，PRD F-I6）。要不要把它收进 `ConversationService`（或新建一个 StateService）？
- ~~[src/app.ts] `host.usage` 的三个范围（对话 / 项目 / 整机）现在靠「遍历对话 + 逐个 `messageService.list` 求和」实现：要不要仓储补一个按项目 / 整机的用量聚合查询，免得按对话逐个拉全量消息？~~ **作废（2026-11-14）**：`host.usage` 已从契约面整体删除（裁定 W1-9；`METHOD_NAMES` 现为 63 条，里面没有它）。用量只剩 `conversation.state.usage` 一个口径（`UsageSnapshot` 的 `turn` / `total` / `subAgent` / `rate`），「项目 / 整机」聚合没有任何客户端需要 —— 这个问题因此没有对象了：既没有 `host.usage` 可优化，也不该为它给仓储加聚合查询。原文留在这里，当「为什么删」的记录。
- [src/app.ts] F-B6 的「思考档位 → 请求参数」发生在装配 agent 时，而 `SdkAgentFactoryOptions.resolveModelParams` 是同步注入点，所以 `reasoning-presets.json` 用启动时读到的快照（`conversation.send` / `setThinking` 时刷新一次）。档位表若要在进程内热改即生效，那个注入点需要一个异步形态。
- [src/app.ts] R50 的「未注入交接服务要推一条 warning 通知」现在只在装配处记了一条 warn 日志：通知层（W4-H）还没到，所以没有可推的通道；留的注入点是 `HostAppOptions.handoff`。
- [src/app.ts] 单根把 handler 表暴露成 `readonly handlers`（`Partial<MethodName → handler>`）：W4 那几个域要往同一张表里加方法、用例要直接调 handler 时都用它。这个「单根公开 handler 表」的口径认不认？
- [src/cli.ts] D25 的第二优先级「配置文件里的端口」在 CLI 里没有来源（SDK 的 `AppConfig` 没有 port 字段）：`--port` 之外只能由代码用 `configPort` 注入。要么定一个配置文件字段，要么 D25 的第二级改成「环境变量」。
- [src/cli.ts] `bin` 名是 `agents-host`，我让「无子命令」与 `serve` 都表示前台起服务；`token` 三个动作直接开库（不启服务），`version` 只打印版本与协议版本。对外实例（`--public`）不会生成 `run/token`，只提示用 `token create` 自己建再分发。这些命令形状认不认？
- [src/session.flow.test.ts] 冒烟里注入的是假 agent 工厂（不连模型），所以 `createSdkAgentFactory` 的真装配（硬线 / 交接线 / 工具刷新）仍只有 `ChatRunner.test.ts` 的用例覆盖。W5 要不要加一条「真 SDK 装配 + 指向本地假端点的模型」的用例？
- [src/services/DiscoveryService.ts] F-G2 只写了「Skill 4 层、工具与子 Agent 各 2 层」，没写具体是哪几个目录。我按 L9 的形状推的：Skill = `<ws>/.ai-zen/skills` → `<ws>/.agents/skills` → `<aiZenDir>/skills` → `~/.agents/skills`；工具 = `<ws>/.agents/tools` → `<aiZenDir>/tools`；子 Agent = `<ws>/.agents/sub-agents` → `<aiZenDir>/sub-agents`（数据根下的名字跟 SDK `CONFIG_SUB_DIRS` 走，是 `sub-agents` 不是 `subagents`）。这四条目录要 PM 确认（属于产品事实，不该由实施者拍）。
- [src/services/DiscoveryService.ts] MCP 的 2 个可编辑作用域我定成 `<ws>/.ai-zen/mcp.json`（workspace）与 `<aiZenDir>/mcp.json`（user）；`<ws>/.mcp.json` 与 `<ws>/.agents/mcp.json`、`~/.agents/mcp.json` 只读。认不认？
- [src/services/DiscoveryService.ts] `DiscoveryLayerView.editable` 我按「本契约的写方法能不能改这一层」算：MCP 有 2 层 true（与 F-G1 对齐），Skill / 工具 / 子 Agent 全部 false（契约里没有写它们的方法，`kind` 只有 MCP 有 `patch`）。若希望「用户自己那层」显示成可编辑（能手改文件），这个字段的语义要另定。
- [src/services/DiscoveryService.ts] 写 MCP 时如果目标文件存在但读不出来（`broken`），我先把坏文件改名留档成套 `<path>.broken-<ISO>.bak` 再写新的：这样 F-F6 的「能看见、能修」都成立，而修复动作不会直接抹掉用户手写的内容。要不要统一成「拒写 + 让用户先手工修」？
- ~~[src/services/DiscoveryService.ts] `config.patchMcps` 的 `entries` 我按**整层替换**实现（没给的就是被删的），每个 id 以磁盘原文为底只覆盖入参明确给了的字段，所以 `oauth` 与未知键留着；`disabled` 省略 = 不改（要重新启用得显式传 `false`）。这个语义认不认？~~ **作废（2026-11-14）**：`config.patchMcps` 已拆成按 id 的 `config.saveMcp` / `config.deleteMcp`（裁定 W1-5），「整层替换」这个概念不存在了，所以「整层替换的语义认不认」没有可答的对象。原语义里有两条**仍然成立**，只是搬到了新方法上（现在写在 `wire/methods.ts` 的注释里）：以磁盘原文为底、只覆盖入参明确给了的字段（`oauth` 与未知键留着）；`disabled` 省略 = 不改（要重新启用仍需显式传 `false`）。
- [src/services/DiscoveryService.ts] `discoverSubAgents` 只回定义、不回文件路径，而 `DiscoveryEntryView.source` 要路径、坏文件也要看得见，所以子 Agent 那一层我按「SDK 判什么算子 Agent + 自己 readdir 拿文件名」两段做。认不认这种「SDK 判定 + 自己定位」的组合？
- [src/services/ModelService.ts] F-F7 说「删模型时默认指向要自动改指或清空」，我定成「改指到同端点的第一条剩余模型；同端点没有剩的就清空」。换指到别的端点等于把请求发去另一家服务商，那件事该由人决定。
- [src/services/ModelService.ts] 删一个**出厂托管**的模型会从 `config.json` 里消失，但下次 `ConfigManager.bootstrap()` 的 `syncManagedModels` 会按出厂清单把它加回来（现有机制只保留 `custom: true` 的条目，没有「隐藏」标记）。所以「删出厂模型」实际上活不过一次重启。要么给 SDK 加一个隐藏标记，要么在删出厂模型时拒绝（提示「用恢复出厂 / 改成自定义」）。
- [src/services/ModelService.ts] 模型写入时我加了三道校验：端点必须存在、`handoff < guard`、`reasoningPreset` 必须在策略表里（否则档位表为空、思考强度不可调）。第三条会让「引用一个还没写的策略名」存不下来，认不认？
- [src/services/AgentService.ts] `agent.*` 的 `custom` 我只会被 `create` / `update` 置 true（用户通过 API 改过定义 = 用户自有，SDK 初始化不再用出厂提示词覆盖）；`setModel` / `setThinking` 只动模型绑定与参数，不改 `custom`。认不认这个分界？
- [src/services/AgentService.ts] `agent.update` 里 `modelId: ""` 表示「清掉绑定」（三级解析落到配置的兜底模型），`undefined` 表示不改；`function` 同理只有「给」没有「撤」（撤回子 Agent 身份没有对应契约字段）。要不要给 `AgentInput.function` 一个显式清空写法（`null`）？
- [src/services/AgentService.ts] `agent.list` 的 `workspaceId` 目前只接参数、不影响算出的可用性：助手可用性看的是全局配置（模型 / 端点 / 密钥），而「在这个项目里能不能用」还得先把「项目里有哪些 Skill / MCP」和助手权限对上，那属于另一件事。要么定清楚它该算什么，要么从契约里去掉这个参数。
- [src/services/AgentService.ts] 删除助手的 `references` 我只报了「默认助手」与「别的助手在 `permissions.subagents` 里点名它的 function」；已经有对话绑定这个助手的那些（L7：身份创建即定死）没算进去（要算得查库）。要不要把「还有 N 段对话在用这个助手」也列出来？
- [src/services/ConfigService.ts] `config.saveEndpoint` 的密钥口径：省略 = 保留；传回来的值恰好等于当前掩码 = 当作没改；空串 = 清掉。第三种是唯一能删除密钥的写法，需要客户端明确这么做。
- [src/services/ConfigService.ts] `config.get` 的 `issues` 我出了 6 类：端点没密钥（warning）、模型指向不存在的端点（error）、`handoff >= guard`（warning）、默认模型 / 迁移模型 / 取名模型指向不存在（error）、默认图片模型指向不存在（error）、默认助手不存在（warning）。`code` 用稳定小写下划线串（`endpoint_no_key` / `model_endpoint_missing` / `threshold_order` / `default_model_missing` / `default_image_model_missing` / `default_agent_missing`）。这是客户端要分支的稳定码，要 PM 过一遍。
- [src/services/ConfigService.ts] `ConfigApplyReport.restartRequired` 我恒为 `false`（F-E2：改完配置靠重连生效）。如果以后有「必须重启才生效」的配置项（例如监听端口），这个字段由那一处置 true。
- [src/services/ConfigService.ts] 「让改动生效」做成注入点 `ConfigApplyPort.apply(change) → { refreshedWorkspaceIds, noticeId }`：配置服务只描述「变了什么」，刷 Scope（`ScopeRegistry.refreshWorkspace`）与合成通知（F-F9）归组装层。未注入时回报 `refreshedWorkspaceIds: []`、`noticeId: null`。（2026-11-15 校正：字段名是 `refreshedWorkspaceIds`，语义是「已**就地刷新**」而不是「已回收」。）
- [src/services/CompletionService.ts] 不新增依赖的前提下，「glob」是手写的递归遍历（跳过 `node_modules` / `.git` / `dist`，不跟符号链接、深度上限 32）。要真 glob 语义（`**` 之类）得引依赖，或让 PM 指定用 `node:fs` 的 `glob`。
- [src/services/CompletionService.ts] 第一次问 `completion.files` 我**立刻回 `scanning` 并在后台扫**（`completion.scanning` 的文案正是「再多打几个字符它就出来了」），扫完之后的请求才回 `ready`。所以 UI 第一下必然看到「还在读」。认不认？另外我留了 `prefetch(workspaceId)`，组装层可以在项目打开时预热一次，让第一次按 `@` 就是 `ready`。
- [src/services/CompletionService.ts] 扫描超时（5s）时我把已经读到的那些照常给出去并标 `problem = completion.timedOut`（一条都没读到时才是 `unavailable`）。另外加了 `completion.noFolder`（目录已不存在）与 `completion.truncated`（到 20000 条上限）两条键。
- [src/handlers/*.ts] 四个域各一个 `createXHandlers(deps)`，与其它域的写法一致；`handlers/index.ts`（W3-F 的）还没拼这四个域，需要 PM 在串线时加进 `createHandlers`，并补 `HandlerDeps` 的 `config` / `agents` / `models` / `completion` 四项。`handlers/index.test.ts` 里「未实现的域」那几条断言也要跟着改。
- [src/handlers/configHandlers.ts] 出参里的 `LocalizedText` 由 handler 按 `context.connection.language` 重渲染一次（D8；服务层存码 + 参数、按默认语言渲染一份）。同一套 `localizeLocalizedTexts` 也用在 agent / model / completion 三个域上：按形状识别（`code` + `messageKey` + `params` + `message`），认不出来的键原样留着。

## W4-H（通知 / 问题对象 / 交接 / 自动命名 / 临时对话）追加

- [src/storage/migrations.ts] `notices` 表没有 `conversationId` 列，而契约里 `NoticeView.conversationId` 与 `notice.list` / `notice.clear` 的按对话过滤都要它：我暂把它塞进 `params` 的一个保留键（`$conversationId`，读出时摘掉再渲染，出网的 `text.params` 里看不到它）。要加列吗？（加了我就改回一列，改动只在这一个服务里）
- [src/wire/methods.ts] `handoff.start` 出参的 `document` 是必填，而「用户取消」既不是失败也没有文档：我抛 `HostError("handoff_declined")`（既有业务码 + `error.handoffDeclined` 文案「这次不交接」）。如果要「取消也回成功结果」，`document` 需要可空或加一个 `cancelled` 标记。
- [src/wire/methods.ts] `question.list` 的 `conversationId` 在契约里可空，但 `QuestionRepository` 只有 `listByConversation`：不传时我回 `invalid_params`（`detail.reason=required`）而不是空列表（空列表会被读成「没有待答问题」）。要支持「全库待答问题」得给仓储加一条查询。
- [src/wire/methods.ts] D23「越线两端都拒绝」的落点我定为两处：① 过了硬线却答「就在这段里继续」→ 拒 `context_guard`，问题继续 `pending`；② `QuestionService.assertSendable(conversationId)` 给 `conversation.send` 用（有挡着的问题 → `question_pending`）。发送路径由接线层调 `assertSendable` 吗？
- [src/wire/methods.ts] `error.questionPending` 带 `{question}` 参数，我填的是「那条问题提问按缺省语言渲染出的句子」——按连接语言重渲染错误时这个参数不会跟着变。要改成传 `questionId`（客户端自己取那句话）吗？
- [src/runtime/TransientRunner.ts] 临时对话的 Scope 按 `transient:<cwd>` 这个键去借（`cwdOfTransientScopeKey` 能取回目录）：接线层的 Scope 工厂要认得这个前缀。认这个口径，还是给临时对话单独一条 Scope 通道？（PRD D3 只写「只借 Scope，与 Workspace 无关」，我按「按 cwd 借、与 Workspace 无关」落）
- [src/runtime/TransientRunner.ts] `ConversationTransientResult.subagents` 我回空数组：临时对话不推事件、也不跟踪子 Agent 现场（一次返回、零痕迹）。若脚本要看到子 Agent 的花费，得在返回时补一份快照（那需要临时对话也订阅 agent 事件）。
- [src/runtime/TransientRunner.ts] `conversation.transient` 的 handler 我没有写：它属于 `conversation.*` 域，而 `handlers/conversationHandlers.ts` 在别的实施者手里。接线层加一行 `"conversation.transient": async (context) => await transientRunner.run(context.params, context.connection.language)` 即可。
- [src/services/HandoffService.ts] 自交接回合本身产生的消息（几 KB 指令 + 工具调用 + 回执）只留在内存、不写进旧对话的库：PRD D18 只说「旧对话完整保留」，没说把交接回合也记进对话。要记的话我在 `runHandoffRound` 里多写一次库即可。
- [src/services/HandoffService.ts] 新对话的第一条消息我用 `role=system` + `data.hidden=1` 承载「交接文档路径 + 摘要」。也可以用 `role=user` + `hidden`；F-D9 的 `hidden` 语义是「宿主注入」，两种都符合，请定一个。
- [src/services/HandoffService.ts] 交接成功后我推两条 `conversation.changed`：新对话 `created`、旧对话 `settings_changed`（旧对话的内容没变，只是「这段已经交接过」）。旧对话那条若不需要可以去掉。
- [src/services/HandoffService.ts] 交接后的新对话我固定「同 Workspace + 同助手 + 同模型」；而 `question.answer` 触发的交接固定用 `then: "new_conversation"`（D18）。若要让用户能选「只产文档」（F-D4），交接问题的候选值需要多一档。
- [src/services/AutoNaming.ts] 「第一轮结束之后」我按「这段对话里只有一条用户消息」判定；同一进程内另有一份 `Set` 防止同一轮连着调两次时重复起名（重启后若仍处在第一轮，会再起一次）。要更硬的判定，需要一列记「已经自动命名过」。
- [src/services/NoticeService.ts] 事件的按连接本地化（`WsHub` 的 `localizeEvent`）我提供 `createEventLocalizer()`，同时覆盖 `notice` 与 `question` 两类载荷（其余事件原样返回）；接线层注入它即可，不需要每个服务各接一份。
- [src/services/QuestionService.ts] 问题「挡不挡着对话」的缺省值是**挡**（两种 kind 都是）：问题就是为「停下来问」而造的，不挡就是白问。`blocking` 仍可由创建方显式给 `false`，但目前没任何创建方那么写。
- [src/app.ts] 单实例的「活着」用 `process.kill(pid, 0)` 探活（不额外连一次端口）：pid 被系统复用时会把一个陌生进程当成「已有实例」并去挂靠它的地址。要不要在探活之后再校验 `host.json` 里的 `host:port` 真的连得上？
- ~~[src/app.ts] 退出判据缺一个触发源：`WsHub` 只提供 `connectionInfos()`（拉），没有「连接数变化」的回调……~~ **已补（2026-11-15，以代码为准）**：`WsHub.onConnectionsChanged` 已在，「连过、但没建过 Scope 就断开」那种进程现在会正常收尾退出；判据不看 Scope（PRD D37）。
- [src/app.ts] 挂靠别人的实例时（单实例发现已有进程在跑），本进程仍然建库、跑迁移、`ConfigManager.bootstrap()`（这些都是 `HostApp.create` 里做的）。要不要让「挂靠」这条路连库都不开？
- [src/app.ts] `--port 0`（让系统分配）我在 `app.ts` 里单独放行：`config.resolveListenTarget` 把 0 当非法端口、会回落到 8790。R12 要不要把「0 表示让系统分配」写进合法端口？
- [src/handlers/index.ts] handler 表现在由 `createHandlers(deps)` 拼，W4 的域（config/agent/model/notice/question/handoff/completion）要进同一张表，就得改 `handlers/index.ts` 并在 `app.ts` 里造好它们要的服务 —— 这两处都在 W3-F 的文件范围里，需要指派由谁接、按什么顺序接（眼下它们自然落 `unsupported`）。
- [src/cli.ts] 命令行的说明文字与错误固定中文：命令行没有连接级语言协商（D8 的语言挂在连接上，断开即忘），要跟 `LANG` 或加 `--lang` 请定一条。
- [src/cli.ts] `--host` 与 `--local/--public` 的映射我按「回环地址 → 本地实例；非回环地址 → 对外实例；与 `--local` 同时写非回环地址算用法错（退出码 2）」。
- [src/cli.ts] `token create` 只把明文打到 stdout，不写 `<数据根>/run/token`（那是本地实例启动时维护的交付口）：认这个分工吗？
- [src/handlers/assetHandlers.ts] `asset.*` 在 handler 表里是空的：`asset.begin` / `asset.end` 由 `WsHub` 在注入 `UploadReceiver` 时接管（要按连接分帧落盘），再注册一份就成了两处实现。这一域只剩「附件结局按连接语言重渲染」的翻译工作。
- [src/handlers/conversationHandlers.ts] `conversation.state` 的 `questions` 与 `statusBlocks` 仍是空数组（问题对象归 W4-H、状态栏块归 W4）：这份拼装留在接线层，还是收进服务层（或单开一个 StateService）？
- [src/serve.process.test.ts] 进程冒烟不跑一轮对话（不连模型）：真 SDK 装配仍只有 `ChatRunner` 的用例覆盖。W5 要不要加一条「指向本地假端点的模型」的用例？
- [src/serve.process.test.ts] 这条用例自己跑一次 `tsc -p tsconfig.json` 才起进程（它要有 `dist/` 产物），因此比别的用例慢十来秒。要不要改成「验收先 build、用例只读 dist」？

## W4-X（总装）追加

- [src/handlers/capabilities.ts] 能力清单的粒度我按「契约里每个方法一条」做（63 条，与 `METHOD_NAMES` 一一对应），编号取 `wire/methods.ts` 每个方法的注释里的 PRD 能力号；同一条能力下有多个方法时（如 `config.saveEndpoint` / `config.deleteEndpoint` 都属于 F-F2）用 `<编号>#<动作>` 去重。`workspace.*` 的四条在 PRD §4 没有单列能力号（注释里写的是 D9 / D10 / D11），那几条的 id 用决定号。若 PM 要的是「按 PRD 能力行」而不是「按方法」，这份表要重排。
- [src/i18n/en.ts, src/i18n/zh.ts] 能力清单的标题与说明必须是 `LocalizedText`，也就必须落在 i18n 键上（`capability.<方法名>` 与 `capability.<方法名>.detail`）：我按「只做加法」两语言各加了 126 个键。i18n 不在 W4-X 的可改清单里，这一处请 W1-B 或 PM 过一遍语气与用词（键名与清单一一对应，用例会钉住「每个方法都有键」）。
- [src/app.ts] `host.upgrade` 的「重启」我实现成「磁盘版本已经比运行版本新（或请求的目标版本已落盘）→ 安排一次收尾，进程退出，由启动方式/宿主重新拉起」；宿主自己 `exec` 回自己没有做 —— 「谁负责重新拉起」是产品口径（本地客户端拉起 / systemd / 手动），不该由宿主假设。要宿主自己 re-exec 的话，下一轮在 `cli.ts` 里补。
- [src/storage/migrations.ts] `notices.conversationId` 按 R32 直接改进 v1（这套表结构还没随版本发出去），没有追加 v2。它是可空外键 + `ON DELETE CASCADE`：删对话时它名下的通知跟着走，全局通知（NULL）不受影响。
- [src/app.ts] 配置生效（`ConfigApplyPort`）的刷新粒度：只改某个项目的 MCP（`workspace` 作用域）→ 只刷那几个项目**已存在**的 Scope；其余改动（端点 / 模型 / 上限 / 用户级 MCP / 默认项）影响所有 Scope → 现存的全都刷（不存在的跳过，不为刷新去创建一个）。报告里的 `refreshedWorkspaceIds` 语义是「已就地刷新」（实例还是同一个，能力已重读），同时合成一条 `info` + 3 秒的通知（F-F9）。（2026-11-15 校正：不再有「拆 / 等最后一次 release」这回事，见 PRD D34。）
- [src/app.ts] 退出判据补上了第四个触发源 `WsHub.onConnectionsChanged`（W3-F 记的缺口），并且「服务过」的判定收紧成「有连接握过手」：只看「连上来过」会让端口扫描器留下的空连接把宿主送走。另一个后果是「最后一条连接断开且什么都不欠」时进程会自己退 —— 这正是 L4 的口径，但本机客户端要能接受「重连时宿主可能已被重新拉起」。
- [src/app.ts] R50 的那条警告改成「第一次装配 agent 时推一次」，不是启动时推：交接插件的有无是**装配能力**的事实，启动就推会让一次正常安装在通知栏里永久挂着一条警告（永久通知只能手动清，L3）。
- [src/host.integration.test.ts] 契约里没有「提一个问题」的方法（问题的产生方是交接线 / 不可撤销动作的二次确认，都在宿主内部）。集成用例因此在进程之间用同一个库写一行问题再读回来。客户端若要能自己造问题（调试、测试、脚本），需要在契约里加一条 `question.ask`。
- [src/runtime/ScopeRegistry.ts] 两处加法：`createWorkspaceScopeFactory` 的 `skillsPaths` / `toolsPaths` / `subAgentsPaths` 允许给「按 cwd 算」的函数（R54：能力目录跟项目走，而 Scope 是按 cwd 装配的）；`ScopeRegistry.workspaceIds()` 读当前持有的键（配置生效要回报「回收了哪些项目的 Scope」）。
- [src/handlers/conversationHandlers.ts] `conversation.send` 的三个钩子都接上了：发之前 `QuestionService.assertSendable`（D23）、受理后 `AssetService.linkToMessage`、结算后 `AutoNaming.afterTurn`（D2）。自动命名放在结算之后且不阻塞回包，它自己的返回值里说明「为什么没起名」。
- [src/handlers/conversationHandlers.ts] `conversation.transient` 只有在注入了 `TransientRunner` 时才注册；单根总会注入，所以运行期它一定在表里（用例 `handlers/index.test.ts` 钉住「除四条桥接外全表覆盖」）。
- [src/app.test.ts] `conversation.send` 的完整一轮（事件顺序 + 库里落消息）仍由 `session.flow.test.ts` 用假 agent 覆盖：那一层要真装配 Scope、真流式、真写库，放在真进程里跑不划算（也不该为了测试往 CLI 里塞假 agent）。
- [src/handlers/conversationHandlers.ts] `conversation.state` 的 `questions` 接上了（= `question.list(conversationId)`，含已回答的那些，客户端按状态决定要不要显示）；`statusBlocks` 仍是空数组 —— 六态 / 工具 / 子 Agent 的事实都在 `run` 与 `usage` 里，块怎么切是呈现层的决定，宿主不另造一份。
- [src/app.ts] 没有注入交接服务时，R50 的警告在**第一次装配 agent** 时推一条（`notice.logWarning`，永久）；它描述的是「自动交接线没装」，不是某一轮的错。

## W6-A（R56–R63 缺口补齐）追加

- [src/runtime/ChatRunner.ts] R56 之后，一段对话在首次发消息之前只活在内存里（草稿）。我让 `ChatRunner` 的「用户消息那条行」在 `message.list` 之外也多带一个事实：用户消息里追加过注入段时，落库时按既有约定写 `data.hidden = true`（core 的 `Message.hidden`）。选的不是 `data.injectedContext` 这类新键（R21：不新造字段），也不是给片段加 `hidden`（core 的内容段没有这个字段）。因此「宿主注入」这个事实挂在**整条用户消息**上，界面若照 `hidden` 直接隐藏整条就会把用户自己打的字也藏掉 —— 客户端按「这条里有宿主加的东西，可折叠」处理。
- [src/runtime/ChatRunner.ts] 注入段的文本用了 `i18n` 里既有的 `message.injectedContext`（「这段是宿主加进来的，不是你输入的：{summary}」）+ 新键 `message.injectedContext.cwd`（「当前目录是 {cwd}」）。新键是加法，en / zh 各一条。
- [src/services/MessageService.ts] （自决）R56 让「刚 `create` 完还没发消息」的对话在库里没有行，而客户端 `create` 之后会立刻 `message.list` / `conversation.state`：我在 `MessageService` 加了一个可选的 `drafts` 注入口（结构上是草稿注册表），对草稿返回空消息而不是 `not_found`。不注入时行为与以前一致。
- [src/services/ConversationService.ts] （自决）草稿期间用户可以改名 / 置顶（`conversation.rename` / `pin` 对草稿也生效，只改内存）。落库时 `conversations.create` 的缺省是「自动命名 + 未置顶」，所以 `ensurePersisted` 在插入之后补写一次 `renameByUser` / `setPinned`（只在草稿确实改过时才多这两条 SQL）。
- [src/services/HandoffService.ts] R56 的一个连带：交接开的新对话第一条消息是宿主写的摘要，写进去要有 `conversations` 行（外键）。所以交接在写摘要之前先调 `conversationViews.ensurePersisted(newConversationId)`（注入的形状 = `ConversationService`，端口类型多一个方法）。
- [src/runtime/TransientRunner.ts] 临时对话也注入「当前目录」（F-D9），段用同一份 `injectedContextOf` / `appendInjectedText`；它不落库，所以没有 `hidden` 这个落点可言。
- [src/services/ConfigService.ts] R63 的 `host.reload` 我在 `ConfigService` 里加了一个 `reload(scope?)`：它不写盘，只把「哪几类要重新装配」交给注入的 `ConfigApplyPort`（回收 Scope + 合成一条通知），出参与 `config.patch` 同一份形状（`config` + `applied`）。这个文件不在 W6-A 的「可改文件」清单里，但「生效报告」的形状计算在它内部（`apply()` 是私有的），放别处只能把那段映射抄一遍；改动只有「加一个方法 + 两个纯函数 + 三个 wire 类型 import」。
- [src/net/WsHub.ts] R57 要求 `hello` 只回能力 id 列表，而 `HostHelloResult.capabilities` 的拼装在接线层（`handleHello`）。改动只有一行（`(capabilities ?? []).map((c) => c.id)`），`WsHubOptions.capabilities` 的入参形状没动。这个文件在「不许改」清单里，属于「确实必须」的那一类。
- [src/app.ts, src/handlers/hostHandlers.ts] (`host.reload` 的落点) 我按 `host.upgrade` 的同一套写法：handler 只转发，结论由组装层给（`HandlerDeps.reload` → `ConfigService.reload`）。
- [docs/architecture.md] R57 / R63 改了两处契约事实（`hello` 的 `capabilities` 从 `CapabilityView[]` 变成 `string[]`；方法数 63 → 64，`host` 域 7 → 8 条），§6 与 §7 的表格、§2 里的数字都要跟着改。`architecture.md` 不在 W6-A 的可改清单里，所以这两处留给 PM 的文档波次。
- [src/handlers/capabilities.ts] 新增的 `host.reload` 在能力清单里取 `F-E1`（命令清单里的「重载」）；i18n 加了两条键 `capability.host.reload` / `.detail`。
- [src/app.test.ts] R59 的「到交接线才问」在 app 层用假 agent 演：同一段配置（交接线 1000），一轮 `prompt_tokens = 500` 不问、`1500` 问。`AutoMigratePlugin` 的 `resolveMode: () => null` 在 `ChatRunner.test.ts` 里用真装配（真 Scope + 磁盘上的助手定义）取出插件直接调 `onAfterSend`，断言交接服务一次都没被叫。

## W6-B（R64–R67 运维与展示面）追加

- [src/wire/states.ts] （自决）R65 要求「八块拼出来」且「拿不到就省略该块」，但 `StatusBlock` 的 `agent` 块事实是 `{ agentId, name, available }`：`conversation.state` 这一跳只看得见对话自己存的 `agentId`，助手名字与「能不能用」在 `AgentService`（另一层持有者），而 `handlers/index.ts`（`ConversationHandlerDeps` 的组装点）不在本轮可改文件里，注不进去。我把这两个字段改成 `string | null` / `boolean | null`（`states.ts` 的「`StatusBlock` 若要微调」那一项），拿不到时给 `null`，块本身照给。要么下轮让 `conversation.state` 也接上 `AgentService`（多一次定义文件读），要么就认 `null`。
- [src/services/ConfigService.ts] （自决）R58 要 `config.setDefaults` 能写 `language`，但 `wire/methods.ts` 的 `DefaultSelection`（`config.get` 的 `defaults` 也是它）不在可改文件里。我在 `ConfigService` 里用一个本地类型 `DefaultsInput = Partial<DefaultSelection> & { language?: Language | null }` 收下它：写盘与生效都通，`hello` 的缺省语言立刻跟着变；但**契约层面**客户端还看不到 `defaults.language`（`config.get` 不回它，类型上也不接受）。要让它在契约里正式成立，需要给 `DefaultSelection` 加一项 —— 那是 `wire/methods.ts` 的改动，请 PM 派。
- [src/config.ts] （自决）R67 的两个来源我按不同范围校验：启动参数认 `0`（系统分配，`--port 0` 的既有用法），配置文件里的 `port` 必须是真的 1..65535 —— 「每次启动换一个端口」这件事在配置文件里说不清，写 `0` 按 `config_invalid` 拒。另外 `<dataRoot>/host.json` **写坏了也是 `config_invalid`**（不是「当没有」）：改完没有任何反馈比报错更难查。
- [src/app.ts] （自决）R66 的自检定时器做成注入点 `HostAppOptions.startVersionTimer`（缺省 `setInterval(...).unref()`）。用假定时器（`vi.useFakeTimers`）验不通：`WsHub.close()` 要等真套接字关完，而它自己那个 200ms 兜底定时器被假掉之后就永远等不到，`stop()` 在假定时器下会挂住。所以用例注入一个手摇的定时器（`tick()` / 取消记账），既不必真等 30 秒，也能断言 `stop()` 把取消函数调了。
- [src/services/Logger.ts] （自决）warn / error 上通知的「防回环」用的是一个重入标记：**发通知期间**产生的 warn / error 只落文件、不再上通知。代价是同一 tick 里连发的多条 warn / error 只有第一条会上通知栏（第二条起被挡）。我认为这比「通知写库失败 → 记一条日志 → 又发通知」的循环要好，但它是产品可感的行为，记在这里请 PM 确认。
- [src/app.ts] （自决）`<dataRoot>/host.json` 只在「真的要用到它」时才读：启动参数给了端口就不读（坏文件不该拦住显式端口），`createHost` 传了 `configPort` 也不读（CLI 已经读过一次）。所以「配置文件坏掉」这件事只有在它那一档真被用到时才会报出来。

## W6-C（两条已知缺口补齐 + 计数口径注释）追加

- [src/wire/methods.ts] `DefaultSelection.language?: Language | null` 按裁定进契约（R58 的三条语义照旧：省略 = 这次不改、`null` = 清掉并回落英文、`config.get` 读回「没设置」时是 `null` 而不是 `"en"`）。`ConfigService` 里那个本地类型 `DefaultsInput` 随之删掉：`config.setDefaults` 的 `defaults`、`config.patch` 的 `defaults` 与 `config.get` 的 `defaults` 现在同一个类型，宿主不再有一份「契约外的形状」。
- [src/services/AgentService.ts] （自决）`describe(agentId)` 返回 `{ agentId, name, available } | null`；`null` 的口径按你拍的那两点：文件不在（助手被删、而对话仍记着那个 id，L7）与文件在但读不出来（坏 JSON）都回 `null`。`available` 复用 `toView()` 的判定（模型 / 端点 / 密钥都齐才算），所以 `agent.list` / `agent.get` / 状态栏块三处说的是同一件事。代价：每次 `conversation.state` 多读一次定义文件 + 配置 + 思考策略表（`toView` 要 presets 才能算 thinking）；单次快照的量，没有加缓存。
- [src/handlers/conversationHandlers.ts] （自决）助手那条事实的 IO 留在 `conversationStateOf`（按你的裁定），`statusBlocksOf` 保持同步纯函数：`StatusBlockInput` 多一个 `agent: { name, available }` 字段，由上面的 `agentFactOf` 填。`ConversationHandlerDeps.agents` 做成可选的结构化端口（只用 `describe`，`AgentService` 是唯一实现者），不注入时两格都是 `null`；`handlers/index.ts` 总会把 `AgentService` 递进来，所以生产路径上不会走那条空路。
- [src/wire/states.ts] （自决，只改注释）`StatusBlock` 里 agent 块那段说明跟着改：「`name` / `available` 由 `conversation.state` 现读助手定义得出，定义没了或读不出来才是 `null`」——`null` 的语义从「这一跳拿不到」变成「定义已经没了」。类型没动（仍是 `string | null` / `boolean | null`），这个文件不在 B1 的可改清单里，属于「改完之后原注释就变成错的」那一类，只动了这一段注释。
- [src/storage/MessageRepository.ts, src/services/ConversationService.ts, src/services/WorkspaceService.ts] 按 B1(a)(b)/B2 落注释：两个仓储读方法各一段（`listByConversation` 数的是主线、`countByConversation` 数的是全部行），代价一侧三个调用点各一段（删对话、删项目、`toSummary` 的 `messageCount`）。只写「这一处是哪个数、为什么与另一处不同」，不写「应该用哪个」；SQL、类型、行为一个字没动。
- [docs/architecture.md] §5 存储表下方补「消息条数的两个口径」（读路径口径 + 谁在用），§9 删掉「状态栏块里的助手名字与可用性」与「`config.setDefaults` 写缺省语言的契约形状」两条已知缺口，§11 加一行变更记录。删第二条是我顺手做的：task 1 落地之后那条描述已经不成立，留着就是错的（B3 只点名了第一条）。
- [src/app.test.ts] 原来那句 `{ defaults: { language: "zh" } } as unknown as MethodParams<"config.setDefaults">`（注释写着「契约的 `DefaultSelection` 还没有 `language`」）按契约落地改成正常调用，并补上「写 `null` → 下一条连接握手回 `en`」的往返。认不出来的语言那条反向断言留着（照旧 `as unknown as`，因为类型上就拦得住）。

## C1（`packages/client` 按新契约重写）追加

- ~~[packages/client/src/connection.ts] R69 之后不能再用 `npx @ai-zen/agents-host` 拉起本地宿主（那是「依赖已发布版本」）。缺省实现改成 `process.execPath <已装包的 dist/cli.js> serve --ai-zen-dir <数据根>`，入口从 `@ai-zen/agents-host/package.json` 解析；打包后的 cli / desktop 没有这个包可解析，需要宿主用 `hostEntry` 把入口递进来（`spawnHost` 也可整个换掉）。这个「入口由宿主给」的口径认不认，还是要一个环境变量（如 `AI_ZEN_HOST_ENTRY`）作为第二来源？~~ **作废（2026-11-14）**：用户后来裁定本机模式就是 **`npx` 现下现起**（PRD L14 / W2-1），连接层的缺省实现已改成 `spawnHostViaNpx`（`npx -y @ai-zen/agents-host@<range> serve --ai-zen-dir <数据根>`，`<range>` 由 CLI 构建时从 `devDependencies` 注入）；桌面端走另一条路（把宿主捆进自己的产物、用 `entry` 递入口）。所以「入口由宿主给还是环境变量」这个二选一已被两条路的判据取代：`context.entry === undefined` 就 npx，否则起给的那个入口。
- [packages/client/src/errors.ts] 有一类失败宿主**不在场**、没有 `data.message` 可用：连不上、握手超时、连接断了、拉起超时。这几句我按连接语言（zh / en，缺省英文，与 D8 / R58 一致）在客户端渲染，是全包唯一由客户端产出的用户可见文本。要不要把它们收进宿主 i18n（客户端只按码取），还是就留在客户端？
- [packages/client/src/client.ts] 本波的门面只有「连接 + 调用 + 事件分派 + 补拉」，没有「一轮之内的状态机」：`message.delta` 只把 `AgentNS.Delta` 分派出去，折叠交给前端（core 的 `applyChunk` 在运行时由调用方用）。旧 client 里那份 `session/stream.ts`（阶段 / 用量 / 子 Agent / 失败终态的纯状态机）这一波没有搬 —— 若 C2 / C3 不希望各写一份，需要另派一个波次把它按新契约重写。
- [packages/client/src/resume.ts] 补拉的 `after` 锚点由调用方给（`client.track(id, anchor)` / `setAnchor`）或由上一次 `resume` 的结果回填；客户端**不**从 `message.delta` 自动推导锚点（那要求客户端解释事件载荷的语义）。要自动维护的话请定：客户端是否允许理解「哪个 messageId 是这段对话的最后一条」。
- [packages/client/src/connection.ts] 「就绪」的判据是「发现文件出现 + `host.hello` 成功」。`HostApp.start()` 目前是先装配再监听，所以这条判据在当下够用；若将来出现「端口在听、业务还没就绪」的窗口，需要宿主在 `hello` 里给一个就绪标记（现在没有）。
- [packages/client/src/client.ts] `asset.begin` / `asset.end` 在契约里是普通方法，但上传还要发**二进制分帧**（`net/UploadReceiver.ts` 的帧格式）。本波的客户端没有上传实现（门面不含它），C2 / C3 做图片上传时要么客户端补一段「发二进制帧」，要么各前端自己发。
- [packages/client/src/settings.ts] 设置里加了 `language`（D26 的「记住上次连接」+ D8 的连接语言）。我的理解是：设置存**用户的偏好语言**，每次 `connect` 握手时带上、`host.setLanguage` 之后跟着更新；语言本身仍是连接级、断开即忘。这条口径认不认（尤其「换了个语言偏好，是否要立刻对现有连接生效」）？
- [packages/client/package.json] `@ai-zen/agents-core` 还在 `dependencies` 里，但本包运行期已经不再 import 它（消息与增量全是 `import type`，折叠在调用方）。降成 devDependency 要动根 `pnpm-lock.yaml`，超出本波可改范围，所以这次只留注释说明，等下一轮 install 时再降。

### C1 自决（记在这里，供 PM 复核）

- [packages/client/src/connection.ts] （自决）「被宿主拒」（`unauthorized`）不当成「还没就绪」：发现文件里那个实例答了话但拒了凭证时，直接把这句错误抛出去，**不**再 spawn 一个新的。否则症状是「明明有个实例在跑，客户端又拉一个、等满 15 秒，最后报『宿主起不来』」。
- [packages/client/src/connection.ts] （自决）凭证每一轮轮询都重读 `run/token`：刚拉起的宿主是它自己启动时才生成那串文件的，只在 spawn 之前读一次会让「第一次拉起」永远连不上。
- [packages/client/src/connection.ts] （自决）发现文件的形状在客户端本地声明成 `LocalHostFacts`（只读 `pid` / `host` / `port`）：它不是契约的一部分（`net/discovery.ts` 的 `HostFileInfo` 不在包根出口里），而客户端对它的要求只有「读不出来就当没有」。
- [packages/client/src/reconnect.ts] （自决）缺省策略是**一直重试**（`maxAttempts: Infinity`）、退避从 250ms 起、封顶 10 秒：放弃的时机是产品判断，包内不预设「试三次就放弃」（那是旧宿主被作废的决定之一）。
- [packages/client/src/client.ts, src/errors.ts] （自决）客户端**不维护第二份清单**：事件名没有白名单（没人订阅的名字自然没人接），业务码没有码表（宿主新增的码照样递出去，调用方的 `switch` 落进 `default`）。两份清单的漂移方向永远是「宿主加了、客户端静默丢掉」。
- [packages/client/src/client.ts] （自决）传输用 Node 内建的全局 `WebSocket`，不引入 `ws`：两个前端要把这个包捆进产物，运行期依赖越少越好。代价是 `error` 事件没有底层原因，所以本地文案里带上 `host:port`。

## W7-A（cwd 注入改成会话创建时一条隐藏消息）追加

- [PRD F-D9 / src/runtime/ChatRunner.ts / src/services/ConversationService.ts] 用户当场裁定：cwd 注入不再是「每轮拼进最后一条用户消息末尾」，而是**会话创建（落库那一刻）写一条独立的 `hidden` 的 `user` 消息**；每轮不重复注入；`hidden` 回到 core 的原意「这条不给人看」（不再表示「这条里有宿主加的东西」）。原 `appendInjectedText` + 每轮拼接 + 把用户消息标 `hidden` 那套整体删掉。
- [src/services/ConversationService.ts] （自决）`ensurePersisted(conversationId, language = DEFAULT_LANGUAGE)`：那条 cwd 消息的正文要落成一句话，所以落库时就得定一个渲染语言。真实现场能给的只有「发起这条连接的语言」（D8），而 `handlers/conversationHandlers.ts` 不在本波可改文件里，所以**生产路径眼下用的是缺省语言（en）**；把发起连接的语言接进去只需在那一跳多传一个参数（`ensurePersisted(id, language)`），请 PM 派给接线层。
- [src/services/ConversationService.ts] （自决）交接开新对话（`HandoffService.openFollowUpConversation`）也会先调 `ensurePersisted`，于是新对话同样是「一条 hidden 的 cwd 消息 + 一条 hidden 的交接摘要」。两条都不展示，`message.list` 默认两条都不返回；`HandoffService.test.ts` 原来断言「新对话只有一条消息」，改成显式 `includeHidden` 后断言两条。
- [src/storage/MessageRepository.ts] （自决）`hidden` 落在 `data` 列 JSON 里（没有单独的列，也没改迁移）。过滤与计数用 SQL 的 `json_extract` 读它：`(CASE WHEN json_valid(data) THEN json_extract(data, '$.hidden') ELSE 0 END) IS NOT 1`。`json_valid` 那层是为了让「库里出现坏 JSON」不至于把整条消息读不出来（与已有的 `parseJson` 兜底同一个口径）。
- [src/storage/MessageRepository.ts] （自决，留一个已知缺口）全文检索 `search()` 没有跟着筛 `hidden`：那段 SQL 是 join 过的、列都带别名，加条件要动检索那条路径，而本波拿到的边界是「只加 `includeHidden` 过滤与计数口径」。结果是那条 cwd 消息的正文（含项目路径）在全文检索里搜得到。要不要一起筛，请定。
- [src/app.ts, src/runtime/index.ts] 越界两处、都只是一个删除/一行：`ChatRunner` 不再有 `resolveCwd` 这个注入点（cwd 现在由对话服务自己从 `workspaces` 读），所以 `app.ts` 组装处那一行与 `runtime/index.ts` 的 `InjectedContext` 导出跟着删；不删就编不过（`tsc` 会报多余属性 / 不存在的导出）。
- [src/services/HandoffService.ts] （连带影响，该文件不在本波可改清单里，没有动）新的默认口径是「`listByConversation` 不返回 `hidden` 的消息」，于是 `HandoffService.loadHistory` 交给交接 agent 的历史里不再有 `hidden` 的两类消息（会话开头那条 cwd 消息、上一轮交接写的摘要）。要不要在这里显式传 `includeHidden: true`（模型看得到、界面仍然不展示），请定 —— 语义上我认为该传，但那是另一个文件的改动。

## W7-C（模型与思考档位改成会话级、持久化）追加

- **用户当场裁定（本节即结论，别再重开）**：`/model` 与 `/think` 只改**这一段会话**的模型与思考档位，**持久化到会话级**（落库，不落内存、不重启丢）；要改**全局**（以后的对话）就改助手定义（`agent.setModel` / `agent.setThinking`），不用命令临时指定；**两者的持久化级别必须对称**（都在会话级）；**换模型必须同步清掉思考档位**。由此作废：旧计划 L7 的「临时换模型只在内存、不进库、重开回默认」半句（该计划文件已删，作废结论仍有效）、`ConversationStateRegistry` 的「临时覆盖」概念，以及 R41（「`setThinking` 的当前档靠参数补丁反推，不另外记档位名」——会话这一侧现在存的就是档位名；助手定义那一侧仍是参数即真相，`agent.setThinking` 口径不变）。
- [src/storage/migrations.ts, src/storage/types.ts, src/storage/ConversationRepository.ts] `conversations` 加 `thinkingLevel TEXT`（可空 = 跟随助手定义），`modelId` 保留但允许更新；仓储加 `setModel`（一条语句同时写 `modelId` 并清 `thinkingLevel`）与 `setThinkingLevel`。表结构仍改在 v1（未发布）。
- [src/runtime/ChatRunner.ts] （自决）**装配时的参数口径**：会话行上的 `thinkingLevel` 按该模型引用的策略表展开成补丁，叠在助手定义的 `modelParams` 之上 —— 但**只在「会话模型 == 助手定义那个模型」时**才叠。SDK 的 `resolveModelParams` 明写「参数取模型来自哪一级那一份、绝不跨级混合」（会话把模型换掉之后，定义那份是给旧模型配的，混进来就是 400），两条要求在这个条件下同时成立。换模型时档位被清空，所以换完通常什么都不带。实现是 `ChatRunner.conversationModelParams`（纯函数，用例直接钉）。
- [src/runtime/ChatRunner.ts] （自决）为了拿「助手定义上的 `modelParams`」，工厂里多读一次定义文件（`new AgentRepository(scope.agentsDir).read(agentId)`）：`createAgent` 内部也会读一次，多这一遍是因为只有定义在手才知道该叠什么。读不出来就当作没有（真正的报错由 `createAgent` 那句给出）。
- [src/services/HandoffService.ts] **越界一行、不改就编不过**：`AgentBuildContext` 多一个必填 `thinkingLevel`，交接回合组装 agent 那一处必须跟着传 `conversation.thinkingLevel`（交接回合与普通一轮用同一套会话级模型与档位，语义上也该传）。
- [src/services/ConversationService.ts] （自决）`setModel` 传回**行上已有的那个模型**当作空操作（档位不被顺手清掉）；`modelId: null` 的口径保留成「回到助手定义上那个模型」（助手没绑时用配置里的兜底，都没有就报 `config_invalid`）。只有模型真的变了才清档位、才推事件。
- [src/services/ConversationService.ts] （自决）换模型 / 调档之后推一条 `conversation.changed`（`change: "settings_changed"`，用的是 `src/wire/events.ts` 里已有的取值，没有新增）：它们现在会出现在**别的窗口**的状态栏上（从前只在内存里，别的窗口本来也看不到，所以当时不推）。若认为这两个动作不该推，删掉那两行 `emitChanged` 即可。
- [src/services/ConversationService.ts] （自决）`ConversationModelState.source` 的判定与装配口径同一处逻辑：`agent` = 会话行上的模型就是助手定义绑的那个（助手没绑时算配置里的兜底模型），否则 `conversation`。清掉 `overriddenThisSession`。
- [src/services/AgentService.ts] （自决）`agent.setModel` 换了模型时，把定义上「旧模型策略表里出现过的键」从 `modelParams` 里剔掉（SDK 那套表本来就以「某个键属于思考参数 = 它在表里出现过」为准，不硬编码键名）；与思考无关的参数（`temperature` 之类）不动。换成同一个模型时一个字都不动。
- [src/wire/states.ts] （自决，越界一处）`StatusBlock` 的 model 块事实原先内联写了一份 `{ modelId; name; vision; overriddenThisSession }`，改成引用新的 `ModelState`：契约里同一个形状只留一份，`ConversationModelState` 现在是它的别名。
- [src/app.ts] `ConversationStateRegistry` 删掉后，服务层要的 `ConversationRuntimePort` 只剩 `isRunning` / `forget`，由 `HostApp.createConversationRuntime()` 现拼（`forget` 指向 `ChatRunner.forget`，晚绑定）。`app.conversationStates` 这个可读属性随之消失。
- [src/net/UploadReceiver.ts] 宿主已补上「上传前先让草稿对话落库」（`asset.begin` → `ConversationService.ensurePersisted`），所以 `packages/client/src/integration.test.ts` 里那条「草稿对话上传到 asset.end 被外键拒掉、码是 internal」的用例会红（它自己写了「宿主哪天补上，这条会红」），CLI 里「草稿上不尝试上传」的分支也该一起删：这一波按边界没有碰 `packages/client`，交客户端那一侧收尾。

## W10（资源表与厂商关联表）追加

- **用户裁定（本节即结论，别再重开）**：两张表 —— `assets`（现有表，不改名）= **资源的唯一真相**（补 `sha256 NOT NULL` + `width`/`height` 可空，加 `UNIQUE(conversationId, sha256)` 做对话内去重）；`asset_vendor_files`（新增）= **可失效的缓存**（`assetId → assets(id) ON DELETE CASCADE`、`endpointId`、`vendorFileId`、`createdAt`、`lastUsedAt`，`UNIQUE(assetId, endpointId)`，索引 `lastUsedAt`，删光能从 `assets` 重建）。消息里只许持久化 `asset://<assetId>`；厂商 `file_id` / base64 / SDK 的文本降级文案一律不进库。SDK 已删掉它自己的上传缓存，去重由我们的表负责，注入点是 `deps.upload`。`vendorFileId` 失效时删掉该端点下这段对话的缓存行、重试一次（每轮最多一次）。`asset.begin` 收 `sha256`，命中「同 conversationId + 同 sha256 + 同 bytes」直接回既有 assetId、不收字节。新方法 `asset.get({ assetId, variant })`，`thumb` 本波等同原图。不做：持久化 `file_id` 以外的东西、跨机共享、新依赖、给 SDK 加缓存。
- [src/wire/methods.ts] （自决）`AssetBeginResult` 用**判别式的两个字段**而不是联合类型：`deduped: boolean` + `uploadId: string | null` + `asset: AssetRef | null`。理由是它在 `MethodMap` 里必须是一个具名类型（联合会被拆成两个匿名分支，客户端 `call` 的返回类型也跟着变成联合）。代价是「`deduped: true` 时 `asset` 必非空」这条只能靠注释与实现保证，类型上表达不出来；客户端 `uploadAsset` 里加了一句显式校验（两个字段自相矛盾时报本地错）。
- [src/net/UploadReceiver.ts] （自决）去重判定放在 `begin` 的**最前面**，命中时连「让草稿对话落库」都跳过：素材行上的外键已经证明这段对话在库里，再去 `ensurePersisted` 一次只是多一次读库。去重查询本身失败按「没命中」处理（去重是省一次上传的优化，不是上传的前提）。
- [src/net/UploadReceiver.ts] （自决）「同 bytes」这个条件是我加的第三道校验：摘要相同本来就等于内容相同，但它能挡住「客户端报的总长与宿主那一行对不上」这种自相矛盾的声明 —— 对不上就当作没命中，让客户端老实传一遍（宿主会复核长度与摘要）。
- [src/services/AssetService.ts] （自决）缺省上传实现（`POST {baseUrl}/files`）在宿主重写了一份，因为 SDK 的 `defaultUpload` **没有从包根导出**（宿主只能调 SDK 的公开出口），而注入了 `deps.upload` 之后 SDK 就不会再用自己的缺省实现。用原生 `fetch` + `FormData`，不引依赖。
- [src/services/AssetService.ts] （自决）`asset_dedup` 撞车（两个上传同时落同一份字节）走 `upsert`：后者删掉自己刚改名的那份文件、回先到的那一行。`finalizeUpload` 因此不再用 `create`。
- [src/services/AssetService.ts] （自决）**落库形态包含「这一轮没送出去的图」**：`storedContent` 收的是「有素材行的那几份」，与「这一轮实际送达了哪几份」无关（送达失败的事实进 `AttachmentOutcome`，不进库）。理由是 `assets` 是真相、消息记的是「用户挂了哪几张图」；下一轮发送时会重新尝试（可能这次送得出去）。若认为「送不出去的就不该进历史」，改一行（只在 `outcome.deliveredAs !== "dropped"` 时收）即可，请 PM 定。
- [src/services/AssetService.ts] （自决）`resolveHistory` 里还原失败的那一段换成一句**给模型看的**英文说明（`[Attachment] <name> is no longer available in this conversation.`），而不是把 `asset://` 原样交给厂商（那会整条请求 400）。它不进 i18n：这是发给模型的文字，不是给人看的文案（SDK 自己的降级提示也是这么写的）。
- [src/runtime/ChatRunner.ts] （自决）「file 失效 → 清缓存 + 重试一次」的触发条件是**两个**都成立：错误文本里说到「文件 / `file_id`」，且给出的是「不存在 / 无效 / 已过期」这类结局。只看一半就会对任何报错都重发一遍（额度就是这么烧掉的）。另外只在「这一次尝试还没产生任何可观测进展」（没流出增量、没落过库）时重试 —— 已经有人看见内容的那一轮重跑，会在历史里多出一条用户消息。
- [src/runtime/ChatRunner.ts] （自决）重试是「重新装配 agent + 重备内容」（`reprepare` 回调重新跑一次 `prepareAttachments` 与 `resolveHistory`），而不是复用上一趟的 agent：厂商产物在缓存被作废之后本来就该重算。`asset_vendor_files` 被清空后，重传失败仍走 SDK 既有的选路降级（上传失败 → 内联；内联超限 → 文字），我们没有另造一套降级。
- [src/services/ConversationService.ts] （自决，越界一行）撤回回填的 `assetIds` 现在合并两个来源：`assets.messageId`（上传早于消息落库时挂上的那条）与**消息 content 里的 `asset://`**。对话内去重让同一张图可以被好几条消息引用，而 `messageId` 一列只能指向最后挂上去的那一条 —— 「这条消息挂了哪几张图」的真值其实是 content。
- [packages/client/src/upload.ts] （自决）`sha256` 现在在 `begin` 就交上去（以前只在 `end` 交）：客户端本来就要算它，提前给等于让宿主能提前短路。`maxBytes` 的本地复核挪到 `deduped` 判断之后（命中时不必再看上限）。
- [packages/client/src/integration.test.ts] 按 W7-C 的交接删掉了那条「草稿对话上传被外键拒」的存量红用例（宿主已让草稿在 `asset.begin` 落库），另外把「一次传 5 张」的用例改成五份**内容各不相同**的字节：相同内容现在会命中对话内去重（那是另一条用例的前提）。

## W11（引用方式改 `__asset_id` + 全局去重 + 关系表）追加

- **用户裁定（本节即结论，别再重开）**：消息里不再用 `asset://` 塞 `image_url.url` / `file.file_id`；引用只在内容段上的本地扩展字段 **`__asset_id`**（`AgentNS.MessageContentSection & { __asset_id?: string }`，只在宿主 `wire/states.ts` 定义一次）。段上所有 `__` 开头的字段都是本地扩展、**发送前一概剥离**（白名单化，只留 core 定义的字段）。发送前把带 `__asset_id` 的段整段替换成当前模型/端点能吃的形式（Files API → `file` 段；视觉模型 → `image_url` + data URL；无视觉 → 一句文字），替换结果对同一 `(素材, 端点)` 必须稳定。去重从「对话内」改成「**全局**」：`assets.sha256` 唯一，删掉 `conversationId` / `messageId` 两列；新增关系表 `conversation_assets`，消息落库那一刻写行，级联删行，删完 `COUNT(*)` 归零才删素材行 + 磁盘文件。客户端按「有没有 `__asset_id`」决定回显，不解析 scheme。
- [src/wire/states.ts] （自决）两个纯函数的签名：`localAssetIdOf(section: AgentNS.MessageContentSection): string | null` 与 `stripLocalExtensions(content: AgentNS.MessageContent): AgentNS.MessageContent`。剥离用**按类型列的字段白名单**（`text` / `image_url` / `file` 各一份，`image_url` 内层只留 `url` / `detail`），认不出的段只留 `type` / `index` —— 这样「哪些字段能出网」由 core 的类型决定，而不是由上次谁写进库的内容决定。
- [src/services/AssetService.ts] （自决）落库形态：图片段 `{ type: "image_url", image_url: { url: "" }, __asset_id }`，文件段 `{ type: "file", filename?, __asset_id }`（`file_id` / `file_data` 都不出现）。`index` 本波不写：内容段的顺序就是数组顺序，而 `index` 是流式攒段时的产物，写进库只会变成第二份顺序事实。
- [src/services/AssetService.ts] （自决）替换结果收敛成三种形态，`detail` 原样透传、不凭空造值（本波没有产出 `detail` 的地方）。Files API 的段带 `filename`（元数据里那一列的原始名字），**这一点与 core 类型注释里「`filename` 仅 `file_data` 时可带」有出入**：按本波口径照写，若厂商侧真因此报 400，去掉 `filename` 是一行改动，请 PM 定。
- [src/services/AssetService.ts] （自决）「无视觉」那一句用中文：`[Image] <名字>（当前模型看不了图片）`（名字取 `assets.name`，取不到时取文件名）。早先 SDK 的降级句里带**磁盘绝对路径**，那是本机事实、厂商不需要知道，所以这一句由我们自己的替换函数出。
- [src/services/AssetService.ts] （自决）`finalizeUpload` 不再校验「对话存在」（`assets` 上没有那条外键了）：校验挪到 `UploadReceiver.begin` 的 `ensureConversation`，并且**排在看去重之前** —— 去重是全局的，命中不再证明这段对话存在。
- [src/runtime/ChatRunner.ts] （自决）关系行的写入口是 `ChatRunner` 新增的注入点 `linkMessageAssets`，调用点紧跟用户消息那条 `upsertMany`（扫的正是落库的那一份内容）。`conversationHandlers.sendTurn` 里原来那句 `assets.linkToMessage(assetIds, ...)` 随之删掉（否则同一件事两处写）。
- [src/services/ConversationService.ts, src/services/WorkspaceService.ts] （自决）`ConversationRemovalReport` / `WorkspaceRemovalReport` 的 `assetPaths` 换成 `assetIds`：全局去重之后「这段对话名下的文件」不再是可删的清单（别的对话可能也在用），只能交 id 让素材层删完再数一遍。撤回同理（先记下要删的消息引用过哪些素材，删完再扫）。
- [src/handlers/conversationHandlers.ts, src/handlers/workspaceHandlers.ts] 连带删两处：`ConversationHandlerDeps.assets` / `WorkspaceHandlerDeps.assets` 现在没人用（挂接与清文件都不在接线层了），所以这两个依赖与 `createHandlers` 里的两行一并去掉。
- [packages/client/src/upload.test.ts] 顺手修一条既有类型错：`new FakeMethodError("invalid_params", "...")` 传了两个参数，而它的构造器收一个对象（`npx tsc -p tsconfig.test.json` 一直报这一条）。不影响行为，只让客户端的测试 tsconfig 干净。

## W12（素材层删简 + core 内容格式化）追加

- **用户裁定（本节即结论，别再重开）**：素材层不再为边缘情况写兜底。最终只有三条 —— ①**同端点内复用**：`asset_vendor_files` 命中 `(assetId, endpointId)` 就直接用那个 `vendorFileId`，miss 才上传一次并写回；②**换厂商 / 换端点**：该端点上没有这个 asset 的缓存行 → 直接 base64 内联，不重传到新端点、不跨端点复用；③**失败就报错**：不自动重试、不清缓存、不判失效、不设 TTL、不做「无进展才重试」那套判据。为此删掉 `AssetService.invalidateVendorFiles`、`AssetRepository` 的 `listVendorFiles` / `deleteVendorFiles` / `deleteVendorFile` / `touchVendorFile`、`ChatRunner` 的 `retryAfterVendorFileError` / `resetForRetry` / 「file 不存在/无效」文本判据 / 「本轮无任何可观测进展」分支，以及 `asset_vendor_files.lastUsedAt` 列与它的索引（迁移仍在 v1，未发布）。保留：`asset.begin` 的 sha256 去重短路、`asset://`→`__asset_id`、`asset.get`、`thumb` 等同原图、「无视觉模型」与「上传失败」这两条既定选路（SDK/选路的分支，不是失效兜底）。
- **用户裁定（core 格式化）**：`packages/core` 新增并导出 `formatContent(content: AgentNS.MessageContent): AgentNS.MessageContent` 与 `formatContentSection(section: AgentNS.MessageContentSection): AgentNS.MessageContentSection`。`formatContent` 是入口、由它自己决定委派（`string` 原样返回、不走 `formatContentSection`；数组逐段交给它）；`formatContentSection` 按段类型取认识的字段（`text` / `image_url` / `file`，`image_url` 内层只留 `url` / `detail`；未知段类型只留 `type` / `index`）；`formatHistory` 内部走这两个函数，不再自己内联白名单；三个都可重写（与 `formatHistory` 同一套机制：`Agent` 上的公开方法）。宿主发送前的剥离改成调 core 的 `formatContent`，自己那份字段清单（`stripLocalExtensions`）删掉，只留认 `__asset_id` 的 `localAssetIdOf`。`formatHistory` 的产物与改动前逐字节一致（有回归用例）。
- **用户裁定（一行）**：Files API 的 `file` 段**不带 `filename`**（core 的类型注释：`filename` 仅 `file_data` 时可带、不能与 `file_id` 同现），宿主的替换函数删掉那个字段。
- [core `formatContent`, `Agent.formatContent*`] （自决）可重写的落点：`Agent.formatContent` / `Agent.formatContentSection` 是实例方法（与 `formatHistory` 同一种覆盖方式：继承或实例赋值），`formatContent` 逐段调的是 `this.formatContentSection`，所以覆写任一个都生效；模块级导出的两个纯函数是默认实现（宿主拿它剥字段，没有 agent 实例）。
- [src/services/AssetService.ts] （自决）「换厂商 / 换端点」的判据：一次查询同时看「这个端点上有没有」（`onEndpoint`）与「别的端点上有没有」（`elsewhere`）；`onEndpoint` 或两边都没有就照常交给 SDK 的 Files API 路径（复用 / 首传），只有「这里没有、别处有」才把端点换成 `null`，让 SDK 走内联 base64。这样三条规则不依赖「是谁在调」（本轮附件与历史重放同一条规则），也不产生跨端点的 `file_id`。
- [src/services/AssetService.ts] （自决）替换函数的形态收敛：`file_id` 段只留 `{ type: "file", file_id }`，`filename` 只跟 `file_data` 一起出现；`image_url` 段的内层 `detail` 有就带上（原样透传，不凭空造值）。

## W14-A（素材尺寸 R76）追加

- [src/services/imageSize.ts] （自决）解码口径：签名说话，不看 `asset.begin` 声明的 `mime` —— 声明 `image/png` 而字节其实是 JPEG 时，按文件头解（`readImageSize` 先试 PNG 签名与 IHDR 块，再试 JPEG 的 `SOI` + 段长遍历），两边都对不上就是 `null`。理由：容器是字节自己的事实，`mime` 是客户端说的。另外解尺寸只读文件头前 64 KiB（`IMAGE_HEAD_BYTES`）：PNG 只需 24 字节，JPEG 的 SOF 段前面排着大块 EXIF 时可能被推到几十 KB 之后 —— 超出这个窗口的 JPEG 会得到 `null`（客户端按「未知」排占位框）。若要覆盖更大 EXIF，改成按段长流式读即可，请 PM 定要不要现在扩。
