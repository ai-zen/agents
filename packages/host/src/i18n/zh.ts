import type { en } from "./en.js";

/**
 * 中文文案表。
 *
 * `satisfies Record<keyof typeof en, string>` 让「少一个键」「多一个键」都在编译期露馅：
 * 键的集合唯一真相在 `en.ts`，本文件只负责把每一句换成中文。语气与英文版一致 ——
 * 说清发生了什么、用户能做什么，判断留给客户端（PRD D12）。
 */
export const zh = {
  // ---- 业务码对应的兜底文案（与 wire/errors.ts 的 BizCode 一一对应）----
  "error.unauthorized": "这个访问密钥没被接受，检查一下密钥再试一次。",
  "error.invalidParams": "这次请求里有不对的地方：{field}。",
  "error.notFound": "找不到这个 id 对应的{entity}。",
  "error.busy": "这段对话还在跑上一轮。等它跑完，或者先停下它。",
  "error.payloadTooLarge": "这个文件是 {size}，超过了 {limit} 的上限。",
  "error.unsupported": "宿主处理不了{what}。",
  "error.internal": "宿主内部出错了，细节写进日志里了。",
  "error.configInvalid": "当前配置还用不了：{reason}。",
  // 端口写得不对（D25 的三档来源里，显式给出的那个值不合法；裁定 R67）
  "error.portInvalid":
    "这个端口号不能用：{value}（来自 {source}）。端口要是 1..65535 的整数 —— 0 表示「让系统分配」，只在命令行里有效。",
  // 助手没有可用模型（结构化原因在 `detail` 里）
  "error.modelUnresolved": "这个助手没有可用的模型 —— 给它挑一个模型，或者在设置里指定一个默认模型。",
  "error.notFactoryModel": "「{id}」不在出厂模型清单里，没有可以恢复的出厂版本。",
  "error.mcpUnavailable": "{name} 没有响应，这一轮缺它的工具，其它能力照常。",
  "error.modelUnsupported": "这段对话里已经有图片，{model} 读不了图片，所以没有换过去。",
  "error.handoffDeclined": "这次不交接，对话继续往下跑。",
  "error.questionPending": "还有一个问题没回答（{question}）。先回答它，再发新内容。",
  "error.contextGuard": "这段对话在第 {used} 个 token 时到了 {limit} 这条线，请求在发出去之前就停下了。",

  // ---- 通知：三档语气 + 是否到点消失（PRD L3 / F-I8）----
  "notice.settingsSaved": "配置已保存。",
  "notice.settingsApplied": "配置已生效，不用重启。",
  "notice.conversationDeleted": "对话已删除。",
  "notice.workspaceDeleted": "项目已移除，它名下的 {count} 段对话一起删掉了，磁盘上的目录没动。",
  "notice.assetsUploaded": "已上传 {count} 张图片。",
  "notice.attachmentDropped": "{name} 没能发出去，这条消息里没有它。",
  "notice.upgradeRestarting": "已更新到 {version}，现在重启。",
  "notice.logWarning": "宿主警告：{summary}",
  "notice.logError": "宿主错误：{summary}",
  "notice.configRecovered": "配置文件 {path} 坏了，已恢复出厂设置。",
  "notice.handoffWritten": "交接文档已写到 {path}。",
  "notice.autoNamed": "给这段对话起名叫「{name}」。",
  "notice.languageChanged": "这条连接现在说{language}。",
  "notice.hardLimitHit": "这一轮在 {limit} 这条线停下了。东西都还在，对话等你继续。",

  // ---- 生成六态（PRD L8 / F-I3）----
  "status.connected": "已连上",
  "status.awaitingFirstToken": "已连上，等第一个字",
  "status.thinking": "在想…",
  "status.generating": "在输出…",
  "status.assemblingToolCalls": "正在拼 {count} 个工具调用…",
  "status.awaitingTools": "在等 {tools}",
  "status.idle": "空闲",
  "status.done": "已结束",
  "status.aborted": "已中止",
  "status.error": "出错停下",

  // ---- 问题对象（PRD D22 / F-I9）----
  "question.handoff.prompt": "这段对话已用到上下文预算的 {percent}%。接下来怎么办？",
  "question.handoff.self": "让助手自己写交接",
  "question.handoff.selfDetail": "用完整对话和它的工具来写，质量最好，代价是多一次全量输入。",
  "question.handoff.summary": "改成摘要历史",
  "question.handoff.summaryDetail": "更便宜也更确定，但文档没那么多细节。",
  "question.handoff.decline": "就在这段对话里继续",
  "question.confirm.prompt": "「{action}」撤不回来。确定要做吗？",
  "question.confirm.accept": "确定",
  "question.confirm.decline": "取消",
  "question.blocking": "这段对话被这个问题挡住了，答了才能继续。",

  // ---- 消息与状态的事实叙述 ----
  "message.reverted": "删掉了 {count} 条消息，内容已经放回输入框。",
  "message.cwdMissing": "这个项目的目录已经不存在了（{cwd}）。对话和历史都还在。",
  "message.injectedContext": "这段是宿主加进来的，不是你输入的：{summary}",
  // 会话创建时那条 hidden 消息里的那句事实（PRD F-D9：cwd 来自对话所属项目，不是宿主进程的目录）
  "message.injectedContext.cwd": "当前目录是 {cwd}",
  "message.subagentFailed": "子 Agent {name} 失败了：{reason}",
  "message.subagentFinished": "子 Agent {name} 跑完了。",
  "message.imageAsText": "{model} 看不了图片，{name} 改成用文字描述发过去。",
  "message.attachmentTooMany": "一条消息最多带 {limit} 张图片，{name} 没放进去。",

  // ---- 用量（PRD F-I5）----
  "usage.turn": "本轮 {value} tokens",
  "usage.total": "累计 {value} tokens",
  "usage.rate": "{value} tokens/秒",
  "usage.withSubAgents": "累计里有 {value} 来自子 Agent",

  // ---- 状态栏各块的标签（PRD F-I6）----
  "label.agent": "助手",
  "label.model": "模型",
  "label.thinking": "思考强度",
  "label.context": "上下文",
  "label.usage": "用量",
  "label.cwd": "目录",
  "label.tools": "在跑的工具",
  "label.subagents": "子 Agent",

  // ---- `@` 补全（PRD F-H5 / D7）----
  "completion.scanning": "还在读项目的文件清单，再多打几个字它就出来了。",
  "completion.timedOut": "文件清单超过 {seconds} 秒才建好，可能不完整。",
  "completion.unavailable": "这里拿不到文件清单：{reason}",
  "completion.noFolder": "这个项目的目录已经不在了",
  "completion.truncated": "只列了前 {limit} 个文件，再打几个字缩小范围就能看到其余的。",

  // ---- 配置、模型、交接、工作区的短句 ----
  "config.referenced": "还有 {count} 处引用它，所以不能删：{names}",
  "config.fileBroken": "{path} 读不成配置：{reason}",

  // ---- 端点、模型、助手的可用性（PRD F-B5：用不了也要列出来并说明原因）----
  "endpoint.missing": "{id} 已经不在端点列表里了，所以这里连不出去。",
  "endpoint.noKey": "{endpoint} 还没配访问密钥，它的模型答不了话。",
  "model.endpointMissing": "{model} 指向的端点（{id}）已经不在端点列表里了。",
  "agent.modelMissing": "这个助手绑定的模型（{id}）已经不在模型列表里了。",
  "agent.fileBroken": "{name} 读不成助手定义：{reason}",
  "agent.notFactory": "{id} 不在出厂助手清单里，没有可恢复的出厂版本。",

  // ---- 配置检查（PRD F-A8：配错了要能当场修，问题指到具体字段）----
  "config.issue.thresholdOrder": "{name} 的交接线（{handoff} 个 token）到了或者超过了硬线（{guard} 个 token）。",
  "config.issue.defaultMissing": "{field} 指向 {id}，那条已经不在清单里了。",
  "config.issue.defaultAgentMissing": "默认助手（{id}）已经不在助手定义里了。",

  // ---- 能力发现（PRD F-G2 / F-F6：坏掉的那一条也要看得见）----
  "discovery.notADirectory": "{path} 不是目录，从它这里什么都读不到。",
  "discovery.shadowed": "这一条被更近的 {path} 覆盖了。",
  "discovery.mcpEntryInvalid": "{name} 既没有 transport 也没有 command，连不上。",
  "discovery.skillBroken": "{name} 的 SKILL.md 用不成一个 Skill：{reason}",
  "discovery.toolUnloadable": "{name} 加载不成一个工具：{reason}",
  "discovery.subAgentBroken": "{name} 不是一个能用的子 Agent 定义：{reason}",
  "model.unavailable": "{name} 还在列表里，但现在用不了：{reason}",
  "model.visionRequired": "{model} 读不了图片，而这段对话里有图片。",
  "handoff.degraded": "交接退回到了 {mode}：{reason}",
  "handoff.declined": "这次不交接。",
  "handoff.noDocuments": "这个项目里还没有交接文档。",
  "workspace.removalCost": "这会删掉 {conversations} 段对话和它们的 {messages} 条消息，磁盘上的目录不动。",
  "attachment.tooLarge": "一张图片最大 {limit}，{name} 是 {size}。",
  "attachment.tooMany": "一条消息最多带 {limit} 张图片。",

  // ---- 通知 / 问题 / 交接 / 自动命名 / 临时对话（W4-H）----
  "notice.unknown": "宿主有一条通知（{code}）。",
  "error.handoffFailed": "交接没走通：{reason}",
  "error.transientFailed": "这次一次性请求没跑完：{reason}",
  "handoff.newConversationSummary":
    "这段对话接着上一段。交接文档在 {path}，先读它，再接着做这件事。\n\n交接摘要：\n{summary}",
  "handoff.degradeReason.fallback": "这次助手自己没能把文档写出来",
  "autoName.failed": "没起出名字，保持原来的名字：{reason}",

  // ---- 能力清单：帮助页与指令菜单按它渲染（F-E5 / F-E6 / F-F9）----
  "capability.host.hello": "连上宿主",
  "capability.host.hello.detail": "拿一串访问密钥建立连接，并定下这条连接说哪种语言。",
  "capability.host.version": "看宿主版本",
  "capability.host.version.detail": "正在跑的版本与协议版本，升级靠它比对。",
  "capability.host.upgrade": "升级后重启",
  "capability.host.upgrade.detail": "比对磁盘上的版本与正在跑的版本，确认新版本真的落盘了才重启。",
  "capability.host.shutdown": "关掉宿主",
  "capability.host.shutdown.detail": "等手上没有欠着的事之后停止服务，已连上的连接会断开。",
  "capability.host.capabilities": "列出宿主能做什么",
  "capability.host.capabilities.detail": "帮助页就是照这份清单渲染的：每件事做什么、会不会占住对话、能不能撤。",
  "capability.host.reload": "从磁盘重载",
  "capability.host.reload.detail": "重新读一遍配置、助手、工具、技能或 MCP 条目：受影响的项日会重建能力，不用重启。",
  "capability.host.setLanguage": "换这条连接的语言",
  "capability.host.setLanguage.detail": "这条连接上的文案都按选的语言渲染；断开重连就忘掉。",

  "capability.workspace.list": "列出项目",
  "capability.workspace.list.detail": "这台机器上的全部项目，包括目录已经不在的那些。",
  "capability.workspace.create": "添加项目",
  "capability.workspace.create.detail": "把一个目录登记成项目；同一个目录只能登记一次。",
  "capability.workspace.get": "看一个项目",
  "capability.workspace.get.detail": "按 id 取一个项目，同时告诉你它的目录还在不在。",
  "capability.workspace.rename": "重命名项目",
  "capability.workspace.rename.detail": "只改显示名，目录路径不变。",
  "capability.workspace.remove": "移除项目",
  "capability.workspace.remove.detail": "把这个项目和它名下的对话一起删掉，磁盘上的目录不动。",

  "capability.conversation.list": "列出对话",
  "capability.conversation.list.detail": "新的在前、置顶的在最上；可以只看某个项目的。",
  "capability.conversation.create": "开一段对话",
  "capability.conversation.create.detail": "创建时就把项目、助手、模型定下来。",
  "capability.conversation.get": "打开一段对话",
  "capability.conversation.get.detail": "按 id 取一段对话，接着上次聊靠它。",
  "capability.conversation.state": "看现在到哪了",
  "capability.conversation.state.detail": "一份快照里给出六态运行现场、上下文阈值、待答问题与用量。",
  "capability.conversation.rename": "给对话改名",
  "capability.conversation.rename.detail": "只改名字，身份与排序不变。",
  "capability.conversation.pin": "置顶对话",
  "capability.conversation.pin.detail": "把它钉在侧栏最上面，其余不变。",
  "capability.conversation.delete": "删除对话",
  "capability.conversation.delete.detail": "把这段对话和它的消息硬删，顺带清掉它引用的图片。",
  "capability.conversation.send": "发一条消息",
  "capability.conversation.send.detail": "跑一轮：消息 id 立刻回来，回答随后流式到达。",
  "capability.conversation.abort": "停下这一轮",
  "capability.conversation.abort.detail": "把正在写的回答停下来，已经写出的那些留在库里。",
  "capability.conversation.revert": "撤回消息",
  "capability.conversation.revert.detail": "把某条消息之后的全部删掉，并把那段正文回填到输入框。",
  "capability.conversation.setModel": "只给这段对话换模型",
  "capability.conversation.setModel.detail": "不动助手的默认模型，也不重开对话。",
  "capability.conversation.setThinking": "调这段对话的思考强度",
  "capability.conversation.setThinking.detail": "把档位展开成请求参数，只对这段对话生效。",
  "capability.conversation.transient": "问一次、不留痕迹",
  "capability.conversation.transient.detail": "一次请求一次回答，不入库、不建对话。",

  "capability.message.list": "看消息",
  "capability.message.list.detail": "一段对话的全部历史，或从某条消息开始的全部；子 Agent 的消息也能取。",

  "capability.question.list": "看待答问题",
  "capability.question.list.detail": "还在等回答的问题；多端看到的是同一批。",
  "capability.question.answer": "回答问题",
  "capability.question.answer.detail": "记下答案并接着往下走：交接问题会自己把交接开起来。",

  "capability.notice.list": "看通知",
  "capability.notice.list.detail": "现在还在界面上的通知——它不进消息流。",
  "capability.notice.dismiss": "清掉一条通知",
  "capability.notice.dismiss.detail": "把一条通知手动清掉；带持续时间的会自己到点消失。",
  "capability.notice.clear": "清掉一批通知",
  "capability.notice.clear.detail": "一次清一批：整个列表，或某一对话的那些。",

  "capability.config.get": "看配置",
  "capability.config.get.detail": "一次读出端点（密钥掩码）、模型、默认项，以及哪里配错了。",
  "capability.config.patch": "改配置",
  "capability.config.patch.detail": "改完当场生效——不用重启，也没有全局保存键。",
  "capability.config.setDefaults": "设默认项",
  "capability.config.setDefaults.detail": "默认助手、兜底模型、迁移模型、图片模型、取名模型。",
  "capability.config.getDiscovery": "看能力从哪来",
  "capability.config.getDiscovery.detail": "MCP 各层、Skill、工具、子 Agent 到底找到了哪些，以及哪些文件读不出来。",
  "capability.config.saveMcp": "保存一条 MCP 服务器",
  "capability.config.saveMcp.detail":
    "有这一条就改、没有就建；只动这一条，传输方式与它的参数都在入参里，这一版不认识的字段原样保留。",
  "capability.config.deleteMcp": "删除一条 MCP 服务器",
  "capability.config.deleteMcp.detail":
    "只从可编辑的那两个作用域里删这一条；本来就没有时如实回报，不算失败。",
  "capability.config.saveEndpoint": "保存端点",
  "capability.config.saveEndpoint.detail": "新建或修改端点；密钥省略就表示保留现有的。",
  "capability.config.deleteEndpoint": "删除端点",
  "capability.config.deleteEndpoint.detail": "还有模型指着它时拒删，并把引用者列出来。",

  "capability.agent.list": "列出助手",
  "capability.agent.list.detail": "全部助手，不可用的也列出来并说明原因。",
  "capability.agent.get": "看一个助手",
  "capability.agent.get.detail": "按 id 取一份助手定义，直接来自它的文件。",
  "capability.agent.create": "新建助手",
  "capability.agent.create.detail": "写一份新的定义文件——一助手一文件，能手改、能进 git。",
  "capability.agent.update": "编辑助手",
  "capability.agent.update.detail": "改定义文件；从此它算你自己定的，不再按出厂版覆盖。",
  "capability.agent.delete": "删除助手",
  "capability.agent.delete.detail": "删掉这份定义，删前先说清还有谁指着它。",
  "capability.agent.setModel": "设助手默认模型",
  "capability.agent.setModel.detail": "改的是助手的默认模型，影响以后新开的对话。",
  "capability.agent.setThinking": "设助手的思考档位",
  "capability.agent.setThinking.detail": "把展开后的请求参数写进助手定义。",
  "capability.agent.restoreFactory": "恢复助手出厂设置",
  "capability.agent.restoreFactory.detail":
    "把这份助手定义整条换回宿主自带的那一份——提示词、模型、权限、思考设置一起回退；可以先看恢复之后会是什么样再决定。",

  "capability.model.list": "列出模型",
  "capability.model.list.detail": "出厂托管与自定义的模型，带两条阈值、思考档位与可用性。",
  "capability.model.listImages": "列出图片模型",
  "capability.model.listImages.detail": "用来生成图片的那些模型，以及哪个是默认。",
  "capability.model.create": "新建模型",
  "capability.model.create.detail": "新建时就绑到某个端点上，并且立刻算自定义。",
  "capability.model.update": "编辑模型",
  "capability.model.update.detail": "编辑出厂模型会把它转成自定义，以后的出厂更新不再覆盖它。",
  "capability.model.delete": "删除模型",
  "capability.model.delete.detail": "还被助手指着时拒删；删掉时把默认项一起收拾干净。",
  "capability.model.restoreFactory": "恢复出厂",
  "capability.model.restoreFactory.detail": "用出厂那一份整条替换掉现在的模型定义。",
  "capability.model.saveImage": "新建或修改图片模型",
  "capability.model.saveImage.detail": "把图片模型绑到端点上，带默认尺寸与质量。",
  "capability.model.deleteImage": "删除图片模型",
  "capability.model.deleteImage.detail": "它还是默认图片模型时拒删。",

  "capability.asset.begin": "开始上传",
  "capability.asset.begin.detail": "先声明文件的大小与类型，超限的当场就拒。",
  "capability.asset.end": "结束上传",
  "capability.asset.end.detail": "校验长度与摘要，然后把它变成消息可以引用的素材。",
  "capability.asset.get": "取回素材",
  "capability.asset.get.detail": "把存着的字节取回来，任何模型都能重放历史里的图；缩略图这一档目前等同原图。",

  "capability.completion.files": "补全文件路径",
  "capability.completion.files.detail": "`@` 菜单背后的项目文件清单；还在读的时候会说出来。",

  "capability.handoff.start": "写交接文档",
  "capability.handoff.start.detail": "写出文档，需要的话顺手开新对话；旧对话完整保留。",
  "capability.handoff.listDocuments": "列出交接文档",
  "capability.handoff.listDocuments.detail": "这个项目里已经写好的文档，可以反复打磨同一份。",

  "capability.search.conversations": "按名字搜对话",
  "capability.search.conversations.detail": "按名字找旧对话，可以只在某个项目里找。",
  "capability.search.messages": "搜对话内容",
  "capability.search.messages.detail": "对说过的话做全文搜索，每条命中带一小段原文。",
} satisfies Record<keyof typeof en, string>;
