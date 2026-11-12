/**
 * 英文文案表 —— 键的真相源（key 的集合以本文件为准，`zh` 与它逐键对应，类型层面拦住漂移）。
 *
 * 写作口径（PRD §1「它说人话」）：一句能直接摆在用户面前的话，说「发生了什么」以及
 * 「用户可以怎么做」，不写 `Error: undefined`、不写 `E_XXX` 这类机器码，也不写
 * 「请求失败」这种没有信息量的话。占位符用 `{name}` 形式，值与含义在键旁的注释里。
 *
 * 文案只描述事实，不做取舍判断（例如目录不存在时只说「目录已不存在」，是否只读由客户端定，
 * PRD D12）；凡是「服务端给事实、客户端给表现」的地方，事实都在结构化字段里，文案只是给人看的那一层。
 */
export const en = {
  // ---- 业务码对应的兜底文案（每个 BizCode 至少一条，见 wire/errors.ts）----
  "error.unauthorized": "That access key wasn't accepted. Check the key and try again.",
  "error.invalidParams": "Part of this request doesn't look right: {field}.",
  "error.notFound": "There's no {entity} with that id.",
  "error.busy": "This conversation is still working on the previous turn. Stop it or wait for it to finish.",
  "error.payloadTooLarge": "That file is {size}, which is over the {limit} limit.",
  "error.unsupported": "The server can't handle {what}.",
  "error.internal": "Something broke on the server. The log has the details.",
  "error.configInvalid": "The settings aren't usable yet: {reason}.",
  // 助手没有可用模型（`conversation.create` 借 `config_invalid` 这个码，结构化原因在 `detail` 里）
  "error.modelUnresolved":
    "No model could be resolved for this assistant — pick a model for it, or set a default model in the settings.",
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
  "notice.logWarning": "Server warning: {summary}",
  "notice.logError": "Server error: {summary}",
  "notice.handoffWritten": "Handoff document written to {path}.",
  "notice.autoNamed": "Named this conversation \"{name}\".",
  "notice.credentialRevoked": "That access key no longer works.",
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
  "question.workspaceRegister.prompt": "This folder ({cwd}) isn't a project yet. Add it?",
  "question.workspaceRegister.accept": "Add it as a project",
  "question.workspaceRegister.decline": "Not now",
  "question.confirm.prompt": "{action} can't be undone. Go ahead?",
  "question.confirm.accept": "Yes, do it",
  "question.confirm.decline": "Cancel",
  "question.blocking": "This question is holding the conversation. Answer it to continue.",

  // ---- 消息与状态的事实叙述（配结构化字段一起给出）----
  "message.reverted": "Removed {count} message(s). The text is back in your input.",
  "message.cwdMissing": "This project's folder no longer exists ({cwd}). The conversation and its history are still here.",
  "message.injectedContext": "Sent by the server, not typed by you: {summary}",
  "message.subagentFailed": "The helper agent {name} failed: {reason}",
  "message.subagentFinished": "The helper agent {name} finished.",
  "message.imageAsText": "{model} can't look at images, so {name} was described in text instead.",
  "message.attachmentTooMany": "A message carries at most {limit} images. {name} was left out.",

  // ---- 用量（PRD F-I5）：三个数字分开给，句子只是给人看的拼装 ----
  "usage.turn": "{value} tokens this turn",
  "usage.total": "{value} tokens in total",
  "usage.rate": "{value} tokens/s",
  "usage.withSubAgents": "the total includes {value} from helper agents",

  // ---- 状态栏各块的标签（PRD F-I6：服务端给块名，客户端排版）----
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

  // ---- 配置、模型、交接、工作区的短句 ----
  "config.referenced": "Still used by {count} item(s), so it can't be removed: {names}",
  "config.fileBroken": "{path} can't be read as settings: {reason}",
  "model.unavailable": "{name} is listed but can't be used right now: {reason}",
  "model.visionRequired": "{model} can't read images, and this conversation has some.",
  "handoff.degraded": "The handoff fell back to {mode}: {reason}",
  "handoff.declined": "No handoff this time.",
  "handoff.noDocuments": "No handoff documents in this project yet.",
  "workspace.removalCost": "This removes {conversations} conversation(s) and their {messages} message(s). The folder on disk stays.",
  "attachment.tooLarge": "Each image can be at most {limit}; {name} is {size}.",
  "attachment.tooMany": "A message carries at most {limit} images.",
} as const;
