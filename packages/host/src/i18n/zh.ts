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
} satisfies Record<keyof typeof en, string>;
