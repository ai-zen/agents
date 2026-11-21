import { AgentNS } from "@ai-zen/agents-core";
import { completeOnce, type AgentModel, type AppConfig } from "@ai-zen/agents-sdk";

import type { GeneralConfig } from "../config/general.js";
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
   * 按配置造一次请求要的客户端（SDK 的 `createModelFromConfig`）。从外面递进来是为了让用例数
   * 得清调用次数：起没起名只有一个可观察的后果，就是有没有发那次请求。
   */
  readonly createModel: (config: AppConfig, modelId: string) => AgentModel;
  readonly onError: (error: unknown, what: string) => void;
}

/**
 * 自动起名。判据只有会话行上那一格 `nameIsAuto`：名字还是自动起的，就可以换；用户改过的名字
 * 一个字都不碰。
 *
 * 不数消息 —— 「这段会话还没有几条消息，所以还没起过名」在交接之后会重新成立：交接把旧记忆整段
 * 搬去了存档会话，这段会话这边只剩系统提示与断点。
 *
 * 写回时 `nameIsAuto` 仍然是真：自动起的名字还能被下一个名字换掉，所以这个方法不幂等 —— 挂在
 * 每一次变闲上，就是每一次变闲都发一次请求。
 */
export class AutoNamer {
  constructor(private readonly deps: AutoNamerDeps) {}

  /**
   * 给这一段起个名字并写回会话行。
   *
   * 失败只进 `onError`，不抛给调用方：起名发生在一次回答结束之后，抛出去就等于把那次成功的
   * 回答报成失败，而名字只是一个标签。它也不跨 wire，属于宿主自己的运行事故。
   */
  async name(sessionId: string): Promise<void> {
    try {
      await this.rename(sessionId);
    } catch (error) {
      this.deps.onError(error, "auto-name");
    }
  }

  private async rename(sessionId: string): Promise<void> {
    const session = this.deps.sessions.get(sessionId);
    // 会话可能刚被删掉：这是挂在「变闲」上的后台动作，没有东西可改名时沉默
    if (session === undefined || !session.nameIsAuto) return;

    const config = this.deps.config.read();
    // 两格都指不到模型就是「不该起名」，不是一次失败
    const modelId = config.namingModel ?? config.defaultModel;
    if (modelId === undefined) return;

    const prompt = promptFor(this.deps.messages.listBySession(sessionId));
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
