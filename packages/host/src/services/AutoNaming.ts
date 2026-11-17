/**
 * 自动命名（PRD D2 / F-C4）。
 *
 * 两件事同时成立才起名，缺一不动：
 *
 *   1. **名字还是「创建时间默认值」**（{@link defaultConversationName}）—— 这是**唯一**的判据：
 *      还是它 → 起名；不是它（用户改过、或已经自动起过）→ 永不再动；
 *   2. **开关开着**（`AppConfig.autoTitle`，缺省视为开 —— 老配置里没有这个字段，用户的意图
 *      显然是「按出厂的样子跑」）。
 *
 * ## 为什么不数消息
 *
 * 交接换记忆是**原地换人**：旧记忆整段搬去 `已存档_<原名>`，原会话只剩自己那几条占位消息，
 * 名字一个字都没动。于是「库里现在有几条消息 / 有几条用户消息」这种判据在换记忆前后会重新
 * 说出「这一段还没起过名」—— 那不是事实，它只是那一段的形状变了。所以起名这件事不能拿
 * 「库里现在有几条消息」当判据，只能问名字本身：它还是不是创建时那个默认值。
 *
 * 用哪一个模型：「取名模型」`AppConfig.namingModel`，没配就回落 `defaultModel`；两个都拿不到
 * 就**保持原名**（原名 = 创建时间，D2）。起不出名（调用失败 / 模型给了个空串）同样保持原名，
 * 不报错、不重试 —— 改名是锦上添花，不该在界面上留一条失败提示。
 *
 * 写回走 `applyAutoName`（而不是用户改名那个方法）：它把 `nameIsAuto` 置 1，于是「这个名字是
 * 自动起的」这个事实在库里继续成立（R35）。而它同时也是「起名这件事到此为止」的凭据：写回之后
 * 名字不再是默认值，下一次调用会当场掉头。
 */

import { AgentNS } from "@ai-zen/agents-core";

import type { AppConfig, ConfigManager } from "@ai-zen/agents-sdk";
import { completeOnce, createModelFromConfig } from "@ai-zen/agents-sdk";

import { DEFAULT_LANGUAGE, render } from "../i18n/index.js";
import type { Language } from "../i18n/index.js";
import type { ChatEventEmitter } from "../runtime/ChatRunner.js";
import type { ConversationRepository } from "../storage/ConversationRepository.js";
import type { MessageRepository } from "../storage/MessageRepository.js";
import type { Conversation } from "../storage/types.js";
import type { ProblemFact } from "../wire/index.js";
import { defaultConversationName } from "./ConversationService.js";
import { toAgentMessage } from "./MessageService.js";
import type { NoticeService } from "./NoticeService.js";

/** 起名时喂给模型的正文上限（够看出在聊什么，又不至于把整段历史发一遍） */
const PROMPT_CHARS = 2000;

/** 起出来的名字最长多少个字符（侧栏一行的容量） */
const MAX_TITLE_CHARS = 60;

/**
 * 起名的指令。
 *
 * 这是**给模型看**的提示，不是界面文案，所以不走 i18n 键空间（那套是给人看的句子）。
 */
const TITLE_INSTRUCTION = [
  "You name conversations. Read the exchange below and give it a short title.",
  "Rules: at most 6 words, no quotes, no trailing punctuation, no preamble like \"Title:\".",
  "Name what the task actually is, in the language the user wrote in.",
  "Answer with the title only.",
].join("\n");

/** 一次「取名」调用的形状（用例注入替身，不必连模型） */
export type TitleCompleter = (input: {
  system: string;
  user: string;
  modelId: string;
}) => Promise<string>;

/** 为什么这次没起名（内部结果，用于测试与日志；不出网） */
export type AutoNameSkip =
  | "conversation_missing"
  | "config_unreadable"
  | "disabled"
  /** 用户把名字改成了别的（`nameIsAuto` 为假）：这个名字归用户，永不再动 */
  | "renamed_by_user"
  /** 名字不是默认值、也不是用户改的 —— 那就已经自动起过了，永不再动 */
  | "already_named"
  | "no_model"
  | "empty_title"
  | "call_failed";

/** 一次自动命名的结果 */
export interface AutoNameOutcome {
  /** 这次有没有真的改名 */
  named: boolean;
  /** 结果名字（没改名时是原来的名字） */
  name: string;
  /** 没改名时是原因；改了就为 `null` */
  skipped: AutoNameSkip | null;
  /** 起不出名的事实（失败时给结构化原因，便于日志与测试断言） */
  problem: ProblemFact | null;
}

export interface AutoNamingDeps {
  conversations: ConversationRepository;
  messages: MessageRepository;
  configManager: ConfigManager;
  /** 取名调用；缺省走 SDK 的 `completeOnce`（与交接摘要共用同一份请求体形状） */
  complete?: TitleCompleter;
  /** 通知通道（起好名字后那条「给它起名叫…」的提示，F-I8） */
  notices?: NoticeService;
  emit?: ChatEventEmitter;
  now?: () => number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 一段消息里的纯文本（分段内容只取文本段） */
function textOf(content: AgentNS.MessageContent | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((section) => ("text" in section && typeof section.text === "string" ? section.text : ""))
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return "";
}

/** 截断到上限（模型看到的正文不必比这更长） */
function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * 把模型那句「标题」收拾成能放进侧栏的一行。
 *
 * 模型常见的越界只有三种：加引号、写「Title: xxx」、换行写解释。三种都在这里收掉；
 * 收完是空串就当作「起不出名」。
 */
function sanitizeTitle(raw: string): string {
  let text = raw.trim();
  if (text.length === 0) return "";
  text = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  text = text.replace(/^\s*(title|name|标题)\s*[:：]\s*/i, "").trim();
  text = text.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, "").trim();
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/[。．.,，;；:：!！?？]+$/g, "").trim();
  if (text.length === 0) return "";
  return text.length > MAX_TITLE_CHARS ? text.slice(0, MAX_TITLE_CHARS).trim() : text;
}

export class AutoNaming {
  private readonly conversations: ConversationRepository;
  private readonly messages: MessageRepository;
  private readonly configManager: ConfigManager;
  private readonly complete: TitleCompleter;
  private readonly notices?: NoticeService;
  private readonly emit?: ChatEventEmitter;
  private readonly now: () => number;

  constructor(deps: AutoNamingDeps) {
    this.conversations = deps.conversations;
    this.messages = deps.messages;
    this.configManager = deps.configManager;
    this.complete =
      deps.complete ??
      (async (input) => await this.completeOnce(input.system, input.user, input.modelId));
    this.notices = deps.notices;
    this.emit = deps.emit;
    this.now = deps.now ?? Date.now;
  }

  /**
   * 变闲那一刻调一次（`app.ts` 把它接在 `ChatRunner.onIdle` 上）。
   *
   * 这个方法是幂等且可反复调用的：条件不成立时什么都不做（直接返回原因），所以接在每一次
   * 变闲上都不会多做一次请求 —— 起过名之后名字就不再是默认值，后面的调用都从这里掉头，
   * 不必在内存里另记一份「谁起过了」。
   */
  async afterTurn(conversationId: string, language: Language = DEFAULT_LANGUAGE): Promise<AutoNameOutcome> {
    const conversation = await this.conversations.get(conversationId);
    if (!conversation) {
      return skip("conversation_missing", "", null);
    }

    let config: AppConfig;
    try {
      config = await this.configManager.read();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return skip("config_unreadable", conversation.name, failure(reason, language));
    }

    if (config.autoTitle === false) return skip("disabled", conversation.name, null);

    // 判据只有这一条：名字还是不是那个「创建时间默认值」。不是它 → 永不再动（用户改过，
    // 或已经自动起过 —— `nameIsAuto` 只用来把这两种情形分别说清楚，不参与「起不起名」）
    if (conversation.name !== defaultConversationName(conversation.createdAt)) {
      const reason: AutoNameSkip = conversation.nameIsAuto ? "already_named" : "renamed_by_user";
      return skip(reason, conversation.name, null);
    }

    // 取名模型：配了就用它，否则回落兜底模型；配置里找不到这个模型也等于「没有取名模型」
    const namingModelId = config.namingModel ?? config.defaultModel;
    if (!namingModelId) return skip("no_model", conversation.name, null);
    const namingModel = config.models.find((model) => model.id === namingModelId);
    if (!namingModel) return skip("no_model", conversation.name, null);

    // 正文只取这一段的两端（第一条用户消息 + 最后一条助手回复）：不数条数，也就不必筛条数
    const rows = await this.messages.listByConversation(conversation.id);
    const user = buildPrompt(rows.map((row) => toAgentMessage(row)));
    if (user.length === 0) return skip("empty_title", conversation.name, null);

    let title: string;
    try {
      title = await this.complete({ system: TITLE_INSTRUCTION, user, modelId: namingModel.id });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return skip("call_failed", conversation.name, failure(reason, language));
    }

    const name = sanitizeTitle(title);
    if (name.length === 0) return skip("empty_title", conversation.name, null);

    const updatedAt = this.now();
    await this.conversations.applyAutoName(conversation.id, name, updatedAt);
    this.emit?.("conversation.changed", {
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      change: "renamed",
      at: iso(updatedAt),
    });
    if (this.notices) {
      await this.notices.create(
        {
          level: "info",
          code: "notice.autoNamed",
          params: { name },
          duration: 5,
          conversationId: conversation.id,
        },
        language,
      );
    }
    return { named: true, name, skipped: null, problem: null };
  }

  /**
   * 缺省的取名调用：用 SDK 的 `completeOnce`（与交接摘要共用同一份请求体形状）。
   *
   * 客户端按配置里的模型现场装配（`createModelFromConfig`）—— 起名是一次几十 token 的小
   * 请求，为它拉一个 Scope（会连带连 MCP）代价与收益不成比例，所以这里不借 Scope。
   */
  private async completeOnce(system: string, user: string, modelId: string): Promise<string> {
    const config = await this.configManager.read();
    const { client, model, modelConfig } = createModelFromConfig(config, modelId);
    return await completeOnce({ client, model, modelConfig, system, user });
  }
}

/** 喂给模型的正文：第一条用户消息 + 最后一条助手回复（取两端，不数条数） */
function buildPrompt(messages: AgentNS.Message[]): string {
  const first = messages.find((message) => message.role === AgentNS.Role.User);
  const userText = clip(first ? textOf(first.content) : "", PROMPT_CHARS);
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === AgentNS.Role.Assistant);
  const replyText = clip(lastAssistant ? textOf(lastAssistant.content) : "", PROMPT_CHARS);
  return [
    userText.length > 0 ? `You: ${userText}` : "",
    replyText.length > 0 ? `Assistant: ${replyText}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

/** 没改名：带上原因 */
function skip(reason: AutoNameSkip, name: string, problem: ProblemFact | null): AutoNameOutcome {
  return { named: false, name, skipped: reason, problem };
}

/** 起不出名的事实（`autoName.failed`：不报错，只是记下为什么保持原名） */
function failure(reason: string, language: Language): ProblemFact {
  const params = { reason };
  return {
    code: "autoName.failed",
    messageKey: "autoName.failed",
    params,
    message: render(language, "autoName.failed", params),
    detail: { reason },
  };
}
