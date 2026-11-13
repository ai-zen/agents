/**
 * 英文文案表 —— 键的真相源（key 的集合以本文件为准，`zh` 与它逐键对应，类型层面拦住漂移）。
 *
 * 写作口径（PRD §1「它说人话」）：一句能直接摆在用户面前的话，说「发生了什么」以及
 * 「用户可以怎么做」，不写 `Error: undefined`、不写 `E_XXX` 这类机器码，也不写
 * 「请求失败」这种没有信息量的话。占位符用 `{name}` 形式，值与含义在键旁的注释里。
 *
 * 文案只描述事实，不做取舍判断（例如目录不存在时只说「目录已不存在」，是否只读由客户端定，
 * PRD D12）；凡是「宿主给事实、客户端给表现」的地方，事实都在结构化字段里，文案只是给人看的那一层。
 */
export const en = {
  // ---- 业务码对应的兜底文案（每个 BizCode 至少一条，见 wire/errors.ts）----
  "error.unauthorized": "That access key wasn't accepted. Check the key and try again.",
  "error.invalidParams": "Part of this request doesn't look right: {field}.",
  "error.notFound": "There's no {entity} with that id.",
  "error.busy": "This conversation is still working on the previous turn. Stop it or wait for it to finish.",
  "error.payloadTooLarge": "That file is {size}, which is over the {limit} limit.",
  "error.unsupported": "The host can't handle {what}.",
  "error.internal": "Something broke on the host. The log has the details.",
  "error.configInvalid": "The settings aren't usable yet: {reason}.",
  // 端口写得不对（D25 的三档来源里，显式给出的那个值不合法；裁定 R67）
  "error.portInvalid":
    "That port number can't be used: {value} (from {source}). It has to be a whole number from 1 to 65535 — 0 means \"let the system pick one\" and only works on the command line.",
  // 助手没有可用模型（`conversation.create` 借 `config_invalid` 这个码，结构化原因在 `detail` 里）
  "error.modelUnresolved":
    "No model could be resolved for this assistant — pick a model for it, or set a default model in the settings.",
  // 恢复出厂时这次编辑的模型在出厂清单里没有对应定义（没有可用来替换的那一条）
  "error.notFactoryModel":
    "\"{id}\" isn't part of the factory model list, so there's no factory version to restore.",
  "error.mcpUnavailable": "{name} isn't answering, so its tools are missing this turn. Everything else still works.",
  "error.modelUnsupported": "{model} can't take the images already in this conversation, so the switch was refused.",
  "error.handoffDeclined": "Handoff was declined, so this conversation carries on as it is.",
  "error.questionPending": "There's an unanswered question ({question}). Answer it before sending something new.",
  "error.contextGuard": "This conversation reached its {limit}-token limit at {used} tokens, so the request was stopped before it could fail.",

  // ---- 通知：三档语气，`duration` 决定是否到点消失（PRD L3 / F-I8）----
  "notice.settingsSaved": "Settings saved.",
  "notice.settingsApplied": "Settings applied — no restart needed.",
  "notice.conversationDeleted": "Conversation deleted.",
  "notice.workspaceDeleted": "Project removed, along with its {count} conversation(s). The folder itself was left alone.",
  "notice.assetsUploaded": "{count} image(s) uploaded.",
  "notice.attachmentDropped": "{name} couldn't be sent and was left out of the message.",
  "notice.upgradeRestarting": "Updated to {version}. Restarting now.",
  "notice.logWarning": "Host warning: {summary}",
  "notice.logError": "Host error: {summary}",
  "notice.configRecovered": "Config file {path} was broken; factory settings restored.",
  "notice.handoffWritten": "Handoff document written to {path}.",
  "notice.autoNamed": "Named this conversation \"{name}\".",
  "notice.languageChanged": "This connection now speaks {language}.",
  "notice.hardLimitHit": "This turn stopped at the {limit}-token limit. Nothing was lost — the conversation is waiting for you.",

  // ---- 生成六态（PRD L8 / F-I3）：每一态一句人话，事实在 run.state 字段里 ----
  "status.connected": "Connected",
  "status.awaitingFirstToken": "Connected — waiting for the first word",
  "status.thinking": "Thinking…",
  "status.generating": "Writing…",
  "status.assemblingToolCalls": "Putting together {count} tool call(s)…",
  "status.awaitingTools": "Waiting on {tools}",
  "status.idle": "Ready",
  "status.done": "Finished",
  "status.aborted": "Stopped",
  "status.error": "Stopped by an error",

  // ---- 问题对象（PRD D22 / F-I9）----
  "question.handoff.prompt": "This conversation is at {percent}% of the context budget set for it. How should we continue?",
  "question.handoff.self": "Let the assistant write the handoff itself",
  "question.handoff.selfDetail": "Uses the full conversation and its tools — the best result, at the price of one more full input.",
  "question.handoff.summary": "Summarise the history instead",
  "question.handoff.summaryDetail": "Cheaper and predictable, but the document is less faithful.",
  "question.handoff.decline": "Keep going in this conversation",
  "question.confirm.prompt": "{action} can't be undone. Go ahead?",
  "question.confirm.accept": "Yes, do it",
  "question.confirm.decline": "Cancel",
  "question.blocking": "This question is holding the conversation. Answer it to continue.",

  // ---- 消息与状态的事实叙述（配结构化字段一起给出）----
  "message.reverted": "Removed {count} message(s). The text is back in your input.",
  "message.cwdMissing": "This project's folder no longer exists ({cwd}). The conversation and its history are still here.",
  "message.injectedContext": "Sent by the host, not typed by you: {summary}",
  // 会话创建时那条 hidden 消息里的那句事实（PRD F-D9：cwd 来自对话所属项目，不是宿主进程的目录）
  "message.injectedContext.cwd": "the current folder is {cwd}",
  "message.subagentFailed": "The helper agent {name} failed: {reason}",
  "message.subagentFinished": "The helper agent {name} finished.",
  "message.imageAsText": "{model} can't look at images, so {name} was described in text instead.",
  "message.attachmentTooMany": "A message carries at most {limit} images. {name} was left out.",

  // ---- 用量（PRD F-I5）：三个数字分开给，句子只是给人看的拼装 ----
  "usage.turn": "{value} tokens this turn",
  "usage.total": "{value} tokens in total",
  "usage.rate": "{value} tokens/s",
  "usage.withSubAgents": "the total includes {value} from helper agents",

  // ---- 状态栏各块的标签（PRD F-I6：宿主给块名，客户端排版）----
  "label.agent": "Assistant",
  "label.model": "Model",
  "label.thinking": "Thinking",
  "label.context": "Context",
  "label.usage": "Usage",
  "label.cwd": "Folder",
  "label.tools": "Tools running",
  "label.subagents": "Helper agents",

  // ---- `@` 补全（PRD F-H5 / D7）----
  "completion.scanning": "Still reading the project's file list — a few more characters and it will fill in.",
  "completion.timedOut": "The file list took longer than {seconds}s to build, so it may be incomplete.",
  "completion.unavailable": "The file list isn't available here: {reason}",
  "completion.noFolder": "this project's folder isn't there anymore",
  "completion.truncated":
    "Only the first {limit} files are listed; narrow what you type to see the rest.",

  // ---- 配置、模型、交接、工作区的短句 ----
  "config.referenced": "Still used by {count} item(s), so it can't be removed: {names}",
  "config.fileBroken": "{path} can't be read as settings: {reason}",

  // ---- 端点、模型、助手的可用性（PRD F-B5：用不了也要列出来并说明原因）----
  "endpoint.missing": "{id} isn't in the endpoint list anymore, so this can't be reached.",
  "endpoint.noKey": "{endpoint} has no access key yet, so its models can't answer.",
  "model.endpointMissing":
    "{model} points to an endpoint ({id}) that isn't in the endpoint list anymore.",
  "agent.modelMissing":
    "This assistant is bound to a model ({id}) that isn't in the model list anymore.",
  "agent.fileBroken": "{name} can't be read as an assistant definition: {reason}",
  // 恢复出厂时这个助手在出厂清单里没有对应定义（用户自建的那一份，没有可用来替换的出厂版）
  "agent.notFactory":
    "\"{id}\" isn't part of the factory assistant list, so there's no factory version to restore.",

  // ---- 配置检查（PRD F-A8：配错了要能当场修，问题指到具体字段）----
  "config.issue.thresholdOrder":
    "{name} has its handoff line ({handoff} tokens) at or above its hard limit ({guard} tokens).",
  "config.issue.defaultMissing": "{field} points to {id}, which isn't in that list anymore.",
  "config.issue.defaultAgentMissing":
    "The default assistant ({id}) isn't among the assistant definitions anymore.",

  // ---- 能力发现（PRD F-G2 / F-F6：坏掉的那一条也要看得见）----
  "discovery.notADirectory": "{path} isn't a directory, so nothing was read from it.",
  "discovery.shadowed": "This entry is overridden by the closer {path}.",
  "discovery.mcpEntryInvalid":
    "{name} has neither a transport nor a command, so it can't be connected.",
  "discovery.skillBroken":
    "{name} has a SKILL.md that can't be used as a skill: {reason}",
  "discovery.toolUnloadable": "{name} couldn't be loaded as a tool: {reason}",
  "discovery.subAgentBroken": "{name} isn't a usable sub-agent definition: {reason}",
  "model.unavailable": "{name} is listed but can't be used right now: {reason}",
  "model.visionRequired": "{model} can't read images, and this conversation has some.",
  "handoff.degraded": "The handoff fell back to {mode}: {reason}",
  "handoff.declined": "No handoff this time.",
  "handoff.noDocuments": "No handoff documents in this project yet.",
  "workspace.removalCost": "This removes {conversations} conversation(s) and their {messages} message(s). The folder on disk stays.",
  "attachment.tooLarge": "Each image can be at most {limit}; {name} is {size}.",
  "attachment.tooMany": "A message carries at most {limit} images.",

  // ---- 通知 / 问题 / 交接 / 自动命名 / 临时对话（W4-H）----
  // 库里那条通知的码认不出来（配置被手改坏、旧版本写进去的码）时的兜底句
  "notice.unknown": "A notice from the host ({code}).",
  // 交接本身失败（写不出文档、摘要请求出错）；用户取消不算失败，走 `error.handoffDeclined`
  "error.handoffFailed": "The handoff didn't go through: {reason}",
  // 临时对话（D3）：一次请求跑一轮，失败时没有会话可回看，只能在这一句里说清
  "error.transientFailed": "That one-off request didn't finish: {reason}",
  // 交接之后新开的那段对话，开场带上交接文档的位置与摘要（D18）
  "handoff.newConversationSummary":
    "This conversation continues an earlier one. The handoff document is at {path} — read it first, then carry on with the task.\n\nSummary of the handoff:\n{summary}",
  // 降级的原因（`handoff.degraded` 的 {reason} 就是这句话）
  "handoff.degradeReason.fallback":
    "the assistant couldn't write the document itself this time",
  // 自动命名（D2）：起不出名就保持原名，这句只在内部结果与日志里出现
  "autoName.failed": "No name came out of it, so the original one stays: {reason}",

  // ---- 能力清单：帮助页与指令菜单按它渲染（F-E5 / F-E6 / F-F9，裁定 R6）----
  // 每个方法一条标题（`capability.<方法名>`）加一句说明（`.detail`）；
  // 编号与阻塞 / 不可撤销属性见 `handlers/capabilities.ts`
  "capability.host.hello": "Connect to the host",
  "capability.host.hello.detail": "Opens a connection with an access key and fixes the language this connection speaks.",
  "capability.host.version": "Show the host version",
  "capability.host.version.detail": "The running version and the protocol version, so an upgrade can be checked.",
  "capability.host.upgrade": "Restart into a newer version",
  "capability.host.upgrade.detail": "Compares the version on disk with the running one and restarts when the update has really landed.",
  "capability.host.shutdown": "Shut the host down",
  "capability.host.shutdown.detail": "Stops serving once nothing is left running — open connections are closed.",
  "capability.host.capabilities": "List what the host can do",
  "capability.host.capabilities.detail": "The list this help page is drawn from: what each ability does and whether it blocks or can't be undone.",
  "capability.host.reload": "Reload from disk",
  "capability.host.reload.detail": "Re-read configuration, assistants, tools, skills or MCP entries: affected projects rebuild their capabilities, nothing restarts.",
  "capability.host.setLanguage": "Switch language for this connection",
  "capability.host.setLanguage.detail": "Every message on this connection is rendered in the chosen language; a reconnect forgets it.",

  "capability.workspace.list": "List projects",
  "capability.workspace.list.detail": "Every project on this machine, including the ones whose folder is gone.",
  "capability.workspace.create": "Add a project",
  "capability.workspace.create.detail": "Registers a folder as a project; the same folder can only be added once.",
  "capability.workspace.get": "Show a project",
  "capability.workspace.get.detail": "One project by id, with whether its folder still exists.",
  "capability.workspace.rename": "Rename a project",
  "capability.workspace.rename.detail": "Changes the display name only; the folder path never changes.",
  "capability.workspace.remove": "Remove a project",
  "capability.workspace.remove.detail": "Deletes the project and every conversation in it; the folder on disk is left alone.",

  "capability.conversation.list": "List conversations",
  "capability.conversation.list.detail": "Newest first, pinned ones on top; can be narrowed to one project.",
  "capability.conversation.create": "Start a conversation",
  "capability.conversation.create.detail": "Fixes the project, the assistant and the model for this conversation up front.",
  "capability.conversation.get": "Open a conversation",
  "capability.conversation.get.detail": "One conversation by id — how you pick up where you left off.",
  "capability.conversation.state": "Show what is happening right now",
  "capability.conversation.state.detail": "The six-state run, context thresholds, pending questions and usage in one snapshot.",
  "capability.conversation.rename": "Rename a conversation",
  "capability.conversation.rename.detail": "Changes the name only; identity and order stay as they were.",
  "capability.conversation.pin": "Pin a conversation",
  "capability.conversation.pin.detail": "Keeps it at the top of the sidebar without changing anything else.",
  "capability.conversation.delete": "Delete a conversation",
  "capability.conversation.delete.detail": "Removes the conversation and its messages for good, and cleans up its images.",
  "capability.conversation.send": "Send a message",
  "capability.conversation.send.detail": "Starts one turn: you get the message ids back at once, the answer streams in after.",
  "capability.conversation.abort": "Stop the current turn",
  "capability.conversation.abort.detail": "Stops the answer that is being written; what was written so far stays.",
  "capability.conversation.revert": "Take back messages",
  "capability.conversation.revert.detail": "Deletes everything after a chosen message and puts that text back in your input.",
  "capability.conversation.setModel": "Switch model for this conversation",
  "capability.conversation.setModel.detail": "Without touching the assistant's default and without restarting the conversation.",
  "capability.conversation.setThinking": "Set how hard the model thinks",
  "capability.conversation.setThinking.detail": "Turns a thinking level into request parameters for this conversation only.",
  "capability.conversation.transient": "Ask once without a conversation",
  "capability.conversation.transient.detail": "One request, one answer, nothing saved and no conversation created.",

  "capability.message.list": "Show messages",
  "capability.message.list.detail": "The whole history of a conversation, or everything from a given message on, helper agents included.",

  "capability.question.list": "Show open questions",
  "capability.question.list.detail": "Questions waiting for an answer; every window sees the same ones.",
  "capability.question.answer": "Answer a question",
  "capability.question.answer.detail": "Records the answer and carries on: a handoff question starts the handoff by itself.",

  "capability.notice.list": "Show notices",
  "capability.notice.list.detail": "The notices still on screen — separate from the message stream.",
  "capability.notice.dismiss": "Dismiss a notice",
  "capability.notice.dismiss.detail": "Clears one notice; timed notices go away on their own.",
  "capability.notice.clear": "Clear all notices",
  "capability.notice.clear.detail": "Clears a batch at once, either the whole list or one conversation's.",

  "capability.config.get": "Show settings",
  "capability.config.get.detail": "Endpoints (keys masked), models, defaults and what is misconfigured, in one read.",
  "capability.config.patch": "Change settings",
  "capability.config.patch.detail": "Writes the change and applies it right away — no restart, no save button.",
  "capability.config.setDefaults": "Set the defaults",
  "capability.config.setDefaults.detail": "Default assistant, fallback model, migration model, image model and naming model.",
  "capability.config.getDiscovery": "Show where abilities come from",
  "capability.config.getDiscovery.detail": "The MCP layers, Skills, tools and helpers that are actually found, plus the files that can't be read.",
  "capability.config.saveMcp": "Save an MCP server",
  "capability.config.saveMcp.detail":
    "Creates it if the id is new, edits it otherwise — one entry at a time, with its transport and that transport's parameters; fields this version doesn't know are kept as they are.",
  "capability.config.deleteMcp": "Delete an MCP server",
  "capability.config.deleteMcp.detail":
    "Removes one entry from one of the two editable scopes; says so plainly when it wasn't there.",
  "capability.config.saveEndpoint": "Save an endpoint",
  "capability.config.saveEndpoint.detail": "Creates or edits an endpoint; leave the key out to keep the current one.",
  "capability.config.deleteEndpoint": "Delete an endpoint",
  "capability.config.deleteEndpoint.detail": "Refuses while models still point at it and lists who does.",

  "capability.agent.list": "List assistants",
  "capability.agent.list.detail": "Every assistant, including the ones that can't be used right now and why.",
  "capability.agent.get": "Show an assistant",
  "capability.agent.get.detail": "One assistant definition by id, straight from its file.",
  "capability.agent.create": "Create an assistant",
  "capability.agent.create.detail": "Writes a new definition file — one file per assistant, editable by hand.",
  "capability.agent.update": "Edit an assistant",
  "capability.agent.update.detail": "Changes the definition file; from then on it counts as your own, not the factory one.",
  "capability.agent.delete": "Delete an assistant",
  "capability.agent.delete.detail": "Removes the definition and says who else points at it first.",
  "capability.agent.setModel": "Set an assistant's model",
  "capability.agent.setModel.detail": "Changes the assistant's default model, which affects conversations started later.",
  "capability.agent.setThinking": "Set an assistant's thinking level",
  "capability.agent.setThinking.detail": "Writes the expanded request parameters into the assistant definition.",
  "capability.agent.restoreFactory": "Restore an assistant to factory settings",
  "capability.agent.restoreFactory.detail":
    "Puts the whole assistant definition — prompt, model, permissions and thinking settings — back to the one that shipped with the host. You can look at the result before it's written.",

  "capability.model.list": "List models",
  "capability.model.list.detail": "Factory-managed and custom models with thresholds, thinking presets and availability.",
  "capability.model.listImages": "List image models",
  "capability.model.listImages.detail": "The models used for image generation, plus which one is the default.",
  "capability.model.create": "Create a model",
  "capability.model.create.detail": "Adds a model bound to an endpoint; a new one counts as custom right away.",
  "capability.model.update": "Edit a model",
  "capability.model.update.detail": "Editing a factory model turns it into a custom one so later updates leave it alone.",
  "capability.model.delete": "Delete a model",
  "capability.model.delete.detail": "Refuses while an assistant still points at it, and fixes the defaults when it goes.",
  "capability.model.restoreFactory": "Restore a model to factory settings",
  "capability.model.restoreFactory.detail": "Replaces the whole model definition with the factory one in a single step.",
  "capability.model.saveImage": "Create or edit an image model",
  "capability.model.saveImage.detail": "Binds an image model to an endpoint with its default size and quality.",
  "capability.model.deleteImage": "Delete an image model",
  "capability.model.deleteImage.detail": "Refuses while it is the default image model.",

  "capability.asset.begin": "Start an upload",
  "capability.asset.begin.detail": "Declares the size and type of a file; anything over the limit is refused right here.",
  "capability.asset.end": "Finish an upload",
  "capability.asset.end.detail": "Checks length and digest, then turns the file into something a message can reference.",
  "capability.asset.get": "Fetch an asset",
  "capability.asset.get.detail": "Returns the stored bytes so any model can replay an image from history; the thumbnail variant currently equals the original.",

  "capability.completion.files": "Complete file paths",
  "capability.completion.files.detail": "The project's file list behind the `@` menu; says so when it is still reading.",

  "capability.handoff.start": "Write a handoff document",
  "capability.handoff.start.detail": "Writes the document and, if asked, opens the next conversation; the old one stays complete.",
  "capability.handoff.listDocuments": "List handoff documents",
  "capability.handoff.listDocuments.detail": "The documents already written in this project, ready to be refined again.",

  "capability.search.conversations": "Search conversations by name",
  "capability.search.conversations.detail": "Finds old conversations by what they are called, optionally within one project.",
  "capability.search.messages": "Search inside conversations",
  "capability.search.messages.detail": "Full-text search over what was said, with a snippet of each hit.",
} as const;
