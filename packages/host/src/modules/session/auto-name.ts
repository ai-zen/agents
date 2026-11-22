import { AgentNS } from "@ai-zen/agents-core";
import {
  completeOnce,
  type AgentModel,
  type AgentRuntime,
  type AppConfig,
} from "@ai-zen/agents-sdk";

import type { GeneralConfig } from "../config/general.js";
import type { Translator } from "../i18n/index.js";
import type { NoticeService } from "../notice/service.js";
import type { messageTable } from "./messages.js";
import type { SessionService } from "./service.js";

/** 交给模型的正文上限：够看出在聊什么，又不至于把整段历史发一遍 */
const PROMPT_CHARS = 2000;

/** 名字的长度上限：侧栏一行的容量 */
const NAME_CHARS = 60;

/**
 * 起名指令。它是发给模型的输入，不是给人看的句子，所以不走 `t`。
 */
const NAMING_INSTRUCTION = `You name sessions. Read the exchange below and give it a short title.

Rules: at most 6 words; no quotes; no trailing punctuation; no preamble such as "Title:";
name the task itself, in the language the user wrote in; answer with the title only.`;

export interface AutoNamerDeps {
  readonly sessions: SessionService;
  readonly messages: ReturnType<typeof messageTable>;
  readonly config: GeneralConfig;
  /**
   * 按配置造一次请求要的客户端（SDK 的 `createModelFromConfig`）。从外面递进来是为了让用例数得清
   * 调用次数：起没起名只有一个可观察的后果，就是有没有发那次请求。
   */
  readonly createModel: (config: AppConfig, modelId: string) => AgentModel;
  /** 失败那条路上唯一的用户出口：名字没换成，得有一句话说明（见 `reportFailure`） */
  readonly notices: NoticeService;
  /** 用户可见的那句话在产生处渲染（见 `reportFailure`） */
  readonly t: Translator;
  readonly onError: (error: unknown, what: string) => void;
}

/**
 * 自动起名。名字一开始是创建时那个时刻串，第一次答完之后换成模型给的一个短名字；用户自己改过
 * 名字的那一段不再动它。
 *
 * 四条判据，缺一条都不发那次请求，顺序就是它们在这里出现的顺序：
 * 1. 这一段闲下来了 —— 由 {@link watch} 接在运行时的事实流上，只有 `state:idle` 那一拍进得来；
 * 2. 名字还归自动 —— 会话行上的 `nameIsAuto` 是真；
 * 3. 第一次答完 —— 这段记忆里由用户本人说的话恰好一条；
 * 4. 开关开着 —— 配置里的 `autoTitle` 不是 `false`（缺省按开着算）。
 *
 * 第 3 条读消息的 `source.kind`：那是 core 定的事实，「这句话是谁说的」只有它答得出。宿主注入的
 * 隐藏消息（例如 cwd 那一条）填的是 `system`，于是不会被数成用户说的话。
 *
 * 配置在动手之前现读，装配那一刻读到的那一份不留在实例上：用户改完这个开关，下一次闲下来就按
 * 新值判，不必重建执行体。
 *
 * 写回时 `nameIsAuto` 仍然是真：自动起的名字还能被下一个名字换掉。不会一直换下去靠的正是第 3 条
 * —— 用户说的第二句话进来之后就不止一条，此后不再进来。交接把旧记忆整段搬去存档会话之后，这一
 * 段这边只剩系统提示与断点，第 3 条重新成立，于是新记忆也能有自己的名字。
 */
export class AutoNamer {
  constructor(private readonly deps: AutoNamerDeps) {}

  /**
   * 挂到运行时的事实流上：这一段闲下来了，就是该起名的那一拍。返回退订函数。
   *
   * 只认 `state:idle`：那一刻手上没活、队列也真空，刚答完的那一句已经在记忆里了。「谁活着、什么
   * 时候闲下来」只有运行时知道，这里读它交出来的事实，不另记一份。
   *
   * 不 await：这一次请求要几秒，而这一拍之后这一段还要接着干活 —— 起名失败、超时、模型胡说都
   * 不该让谁等它。{@link name} 自己接住全部失败，所以这里不必再接一层。
   */
  watch(runtime: AgentRuntime): () => void {
    return runtime.observe((fact) => {
      if (fact.type !== "state:idle") return;
      void this.name(fact.sessionId);
    });
  }

  /**
   * 给这一段起个名字并写回会话行。
   *
   * 失败只进日志与一条会话内通知，不抛给调用方：起名发生在一次回答结束之后，抛出去就等于把那次
   * 成功的回答报成失败，而名字只是一个标签。它也不跨 wire，属于宿主自己的运行事故。
   */
  async name(sessionId: string): Promise<void> {
    try {
      await this.rename(sessionId);
    } catch (error) {
      this.deps.onError(error, "auto-name");
      this.reportFailure(sessionId);
    }
  }

  private async rename(sessionId: string): Promise<void> {
    const session = this.deps.sessions.get(sessionId);
    // 会话可能刚被删掉：这是挂在「闲下来」上的后台动作，没有东西可改名时沉默
    if (session === undefined || !session.nameIsAuto) return;

    const messages = this.deps.messages.listBySession(sessionId);
    // 第一次答完：用户本人说的话恰好一条。答过第二句就有两条，此后不再改名 —— 它挡的是「每一次
    // 闲下来都换一个名字」
    const fromUser = messages.filter((message) => message.source?.kind === "user");
    if (fromUser.length !== 1) return;

    const config = this.deps.config.read();
    // 关掉这一格就不发那次请求。只认 `false`：老配置里没有这一格，用户的意图是按出厂的样子跑，
    // 而不是关掉一个他不知道的功能
    if (config.autoTitle === false) return;
    // 两格都指不到模型就是「不该起名」，不是一次失败
    const modelId = config.namingModel ?? config.defaultModel;
    if (modelId === undefined) return;

    const prompt = promptFor(messages);
    if (prompt.length === 0) return;

    const { client, model, modelConfig } = this.deps.createModel(config, modelId);
    const answer = await completeOnce({
      client,
      model,
      modelConfig,
      system: NAMING_INSTRUCTION,
      user: prompt,
    });
    const name = nameFrom(answer);
    // 模型给了个空串（或只有引号、标点）：同样保持原名
    if (name.length === 0) return;

    // 这一次请求要几秒：期间用户可能自己改过名，写回之前按库里的现读值再判一次
    const latest = this.deps.sessions.get(sessionId);
    if (latest === undefined || !latest.nameIsAuto) return;

    this.deps.sessions.update(sessionId, { name, nameIsAuto: true });
  }

  /**
   * 失败说给用户：一条会话内通知，挂在这一段名下。成功不发。
   *
   * 句子在这里渲染好再落库 —— 用户可见的文本在产生处本地化，库里存的就是那一刻的成品句子。
   *
   * 报这件事自己失败也不能抛出去：这条路上没有人接，抛出去就是一句没人处理的拒绝，而它要说的事
   * （名字没换成）已经由上面那行日志说了。
   */
  private reportFailure(sessionId: string): void {
    try {
      // 会话可能在这几秒里被删掉：通知挂在一个不存在的会话名下会撞外键，而那段会话已经不在了，
      // 也没有要告知的人
      if (this.deps.sessions.get(sessionId) === undefined) return;

      this.deps.notices.push({
        level: "warning",
        code: "auto_title_failed",
        sessionId,
        // 永久留到用户自己清：名字为什么还是那一串时刻，得有机会读到
        durationMs: null,
        message: this.deps.t("这一段会话自动起名失败，名字还是创建时的那一个"),
      });
    } catch (error) {
      this.deps.onError(error, "auto-name-notice");
    }
  }
}

/**
 * 喂给模型的正文：第一条用户消息与最后一条助手回复。前者说的是这段会话要做什么，后者说的是
 * 做到哪里；中间的来回对「这段会话在做什么」没有更多可加的信息。
 */
function promptFor(messages: AgentNS.Message[]): string {
  const firstUser = messages.find((message) => message.role === AgentNS.Role.User);
  const lastReply = [...messages]
    .reverse()
    .find((message) => message.role === AgentNS.Role.Assistant);

  return [
    firstUser === undefined ? "" : `You: ${clip(textOf(firstUser.content))}`,
    lastReply === undefined ? "" : `Assistant: ${clip(textOf(lastReply.content))}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > PROMPT_CHARS ? `${trimmed.slice(0, PROMPT_CHARS)}…` : trimmed;
}

/** 内容可能是图文混排的分段，是否在聊这件事只看文本段 */
function textOf(content: AgentNS.MessageContent | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((section) => (section.type === "text" ? section.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * 把模型那句「名字」收拾成侧栏能放的一行。模型常见的越界就三种：加引号、写「标题：」、
 * 前面多说一句 —— 三种都在这里收掉；收完是空串就当作没起出来。
 */
function nameFrom(answer: string): string {
  const line = answer.split(/\r?\n/).find((text) => text.trim().length > 0) ?? "";
  return line
    .replace(/^\s*(?:title|name|标题)\s*[:：]\s*/i, "")
    .replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[。．.,，;；:：!！?？]+$/, "")
    .trim()
    .slice(0, NAME_CHARS)
    .trim();
}
