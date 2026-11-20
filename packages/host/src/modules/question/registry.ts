import type { Bus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import type { HostEvent } from "../events.js";
import type { Translator } from "../i18n/index.js";
import type { Choice, Question } from "./types.js";

export interface QuestionRegistryDeps {
  readonly events: Bus<HostEvent>;
  readonly t: Translator;
}

/** 问一道题要的事实：id 与时间由 `ask` 当场给，调用方给的是内容 */
export interface AskInput {
  readonly sessionId: string;
  readonly message: string;
  readonly choices: readonly Choice[];
  /** 不给就是挡着 */
  readonly blocking?: boolean;
}

/**
 * 题是活物，一张内存表，没有表也没有状态格。
 *
 * 它只有两种去处：被答了、它那一段没了。两个去处都在这一张表上收场 —— 答过的那一条当场摘掉，
 * 所以「还挂着」与「在表里」是同一个事实。多留一格 `state` 会让两处各说一半：表里有它、状态说
 * 已答，读到这种中间态的调用方必须自己判断该信哪一个。
 */
export class QuestionRegistry {
  private readonly questions = new Map<string, Question>();

  constructor(private readonly deps: QuestionRegistryDeps) {}

  ask(input: AskInput): Question {
    const question: Question = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      message: input.message,
      choices: input.choices,
      // 缺省挡着：题就是为「停下来问」而造的，不挡的那一种是调用方显式说出来的
      blocking: input.blocking ?? true,
      createdAt: Date.now(),
    };

    this.questions.set(question.id, question);
    this.deps.events.emit({
      type: "question.asked",
      sessionId: question.sessionId,
      question,
    });
    return question;
  }

  get(id: string): Question | undefined {
    return this.questions.get(id);
  }

  /** 这一段上还挂着的题，按提出的先后 */
  list(sessionId: string): Question[] {
    const found: Question[] = [];
    for (const question of this.questions.values()) {
      if (question.sessionId === sessionId) found.push(question);
    }
    return found;
  }

  /** 这一段现在被哪几道题挡着：答过的题已经不在表里，所以这里的每一道都还等着人答 */
  pending(sessionId: string): Question[] {
    return this.list(sessionId).filter((question) => question.blocking);
  }

  /**
   * 答一道题：它离开登记表，事件在这一拍发出去。
   *
   * 已经答过的那道题到此为止 —— 它不在表里了，再答一次落到 `not_found` 上。题只有一次生命，
   * 不留「上次答的是什么」那一格：留着它就得回答「答过之后还能不能改」，而这个项目里没有改答案
   * 这回事（没有「不答」、也没有「重答」）。
   */
  answer(id: string, value: string): Question {
    const question = this.get(id);
    if (question === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("找不到 id 为 {questionId} 的题", { questionId: id }),
        { entity: "question", questionId: id },
      );
    }

    if (!question.choices.some((choice) => choice.value === value)) {
      throw new HostError(
        "invalid_params",
        this.deps.t("题 {questionId} 的候选项里没有 {value}", { questionId: id, value }),
        { entity: "question", questionId: id, value },
      );
    }

    this.questions.delete(id);
    this.deps.events.emit({
      type: "question.answered",
      sessionId: question.sessionId,
      questionId: id,
      value,
    });
    return question;
  }

  /**
   * 这一段的题跟着这一段一起消失。
   *
   * 不在这里发事件：题的去处只有两条事件，一条是「问了」、一条是「答了」，而没有哪一种能说
   * 「题没被答就没了」。硬拿 `question.answered` 顶替是编一个没发生过的答案 —— 客户端会照着那个
   * 值去走一遍「答完之后该发生什么」。
   */
  forget(sessionId: string): void {
    for (const [id, question] of this.questions) {
      if (question.sessionId === sessionId) this.questions.delete(id);
    }
  }
}
