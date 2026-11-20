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
  "error.busy": "This session is still busy. Stop it or wait for it to finish.",
  // 会话存在但没人驱动它（PRD 1.2）：外面投不进去，只有从界面上发话会先把它叫起来
  "error.sessionDead":
    "This session has nothing driving it right now, so nothing can be sent into it from outside. Sending from the app wakes it up first.",
  "error.payloadTooLarge": "That file is {size}, which is over the {limit} limit.",
  "error.unsupported": "The host can't handle {what}.",
  "error.internal": "Something broke on the host. The log has the details.",
  "error.configInvalid": "The settings aren't usable yet: {reason}.",
  // 端口写得不对（D25 的三档来源里，显式给出的那个值不合法；裁定 R67）
  "error.portInvalid":
    'That port number can\'t be used: {value} (from {source}). It has to be a whole number from 1 to 65535 — 0 means "let the system pick one" and only works on the command line.',
  // 助手没有可用模型（`session.create` 借 `config_invalid` 这个码，结构化原因在 `detail` 里）
  "error.modelUnresolved":
    "No model could be resolved for this assistant — pick a model for it, or set a default model in the settings.",
  // 恢复出厂时这次编辑的模型在出厂清单里没有对应定义（没有可用来替换的那一条）
  "error.notFactoryModel":
    "\"{id}\" isn't part of the factory model list, so there's no factory version to restore.",
  "error.mcpUnavailable":
    "{name} isn't answering, so its tools are missing for this request. Everything else still works.",
  "error.modelUnsupported":
    "{model} can't take the images already in this session, so the switch was refused.",
  "error.handoffDeclined": "Handoff was declined, so this session carries on as it is.",
  "error.questionPending":
    "There's an unanswered question ({question}). Answer it before sending something new.",
  "error.contextGuard":
    "This session reached its {limit}-token limit at {used} tokens, so the request was stopped before it could fail.",
  // 某个钩子在请求发出前拒了这一次请求（core 的 `denied` 事件）：历史上一个字都没多

  // ---- 通知：三档语气，`duration` 决定是否到点消失（PRD L3 / F-I8）----
  "notice.settingsApplied": "Settings applied — no restart needed.",
  "notice.attachmentDropped": "{name} couldn't be sent and was left out of the message.",
  "notice.upgradeRestarting": "Updated to {version}. Restarting now.",
  "notice.logWarning": "Host warning: {summary}",
  "notice.logError": "Host error: {summary}",
  "notice.configRecovered": "Config file {path} was broken; factory settings restored.",
  "notice.handoffWritten": "Handoff document written to {path}.",
  "notice.autoNamed": 'Named this session "{name}".',

  // ---- 问题对象（PRD D22 / F-I9）----
  "question.handoff.prompt":
    "This session is at {percent}% of the context budget set for it. How should we continue?",
  "question.handoff.self": "Let the assistant write the handoff itself",
  "question.handoff.selfDetail":
    "Uses the full session and its tools — the best result, at the price of one more full input.",
  "question.handoff.summary": "Summarise the history instead",
  "question.handoff.summaryDetail": "Cheaper and predictable, but the document is less faithful.",
  "question.handoff.decline": "Keep going in this session",

  // ---- 消息与状态的事实叙述（配结构化字段一起给出）----
  "message.imageAsText": "{model} can't look at images, so {name} was described in text instead.",

  // ---- 用量与状态栏的块名没有词条：宿主不推用量快照、也不给块名（PLAN §5.4）----

  // ---- 那两块由客户端按到达的事件自己拼 ----

  // ---- `@` 补全（PRD F-H5 / D7）----
  "completion.scanning":
    "Still reading the project's file list — a few more characters and it will fill in.",
  "completion.timedOut":
    "The file list took longer than {seconds}s to build, so it may be incomplete.",
  "completion.unavailable": "The file list isn't available here: {reason}",
  "completion.noFolder": "this project's folder isn't there anymore",
  "completion.truncated":
    "Only the first {limit} files are listed; narrow what you type to see the rest.",

  // ---- 配置、模型、交接、工作区的短句 ----
  "config.referenced": "Still used by {count} item(s), so it can't be removed: {names}",
  "config.fileBroken": "{path} can't be read as settings: {reason}",

  // ---- 端点、模型、助手的可用性（PRD F-B5：用不了也要列出来并说明原因）----
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
  "discovery.skillBroken": "{name} has a SKILL.md that can't be used as a skill: {reason}",
  "discovery.toolUnloadable": "{name} couldn't be loaded as a tool: {reason}",
  "discovery.subAgentBroken": "{name} isn't a usable sub-agent definition: {reason}",
  "handoff.degraded": "The handoff fell back to {mode}: {reason}",
  "attachment.tooMany": "A message carries at most {limit} images.",

  // ---- 通知 / 问题 / 交接 / 自动命名 / 一次性会话（W4-H）----
  // 库里那条通知的码认不出来（配置被手改坏、旧版本写进去的码）时的兜底句
  "notice.unknown": "A notice from the host ({code}).",
  // 交接本身失败（写不出文档、摘要请求出错）；用户取消不算失败，走 `error.handoffDeclined`
  "error.handoffFailed": "The handoff didn't go through: {reason}",
  // 一次性会话（D3）：一次请求就一个答案，失败时没有会话可回看，只能在这一句里说清
  "error.transientFailed": "That one-off request didn't finish: {reason}",
  // 交接之后新开的那段会话，开场带上交接文档的位置与摘要（D18）
  "handoff.newSessionSummary":
    "This session continues an earlier one. The handoff document is at {path} — read it first, then carry on with the task.\n\nSummary of the handoff:\n{summary}",
  // 降级的原因（`handoff.degraded` 的 {reason} 就是这句话）
  "handoff.degradeReason.fallback": "the assistant couldn't write the document itself this time",
} as const;
