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
  /**
   * 等答复的那些人，按题 id。与 `questions` 同生同死：表里没了的那一格，这里也不能留着。
   *
   * 不进 `Question` 本体：那一份是要发到客户端去的（`question.asked` 的载荷），一个函数放进去
   * 既过不了 wire，也不是题的一部分。
   */
  private readonly waiting = new Map<string, (value: string | undefined) => void>();

  constructor(private readonly deps: QuestionRegistryDeps) {}

  ask(input: AskInput): Question {
    const question = this.create(input);
    this.publish(question);
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
    // 那一格也收掉：一张只增不减的表会一直长，而答过的题谁也不会再回来取
    const settle = this.waiting.get(id);
    this.waiting.delete(id);
    this.deps.events.emit({
      type: "question.answered",
      sessionId: question.sessionId,
      questionId: id,
      value,
    });
    settle?.(value);
    return question;
  }

  /**
   * 问一道题并等一个答复。答复是选中的那个 `value`；题没被答就消失了（那一段没了、或被
   * `forget` 掉）时回 `undefined`。
   *
   * 与 `ask` 的差别只在「等不等」：题还是同一道题（同一张表、同样两条事件），等的是同一件事。
   *
   * **题仍然只做实时、不落库**（`dev-docs/prd/01-decisions.md` 第 107–111 行）：挂着的这一格只
   * 活在内存里，进程没了它就没了。`undefined` 不是「用户说了不」而是「没人答它了」—— 调用方据此
   * 按默认执行者走，不能把它当成一个否定的答复。
   */
  askAwaitable(input: AskInput): { question: Question; answer: Promise<string | undefined> } {
    const question = this.create(input);
    // 先登记再发事件：`question.asked` 一出去，答的人就可能在同一拍把答案递回来（同步的订阅者
    // 就是那样），而那一刻如果没人在等，这个 Promise 就永远不会兑现 —— 发题的人就挂在那里了。
    const answer = new Promise<string | undefined>((resolve) => {
      this.waiting.set(question.id, resolve);
    });
    this.publish(question);
    return { question, answer };
  }

  /**
   * 这一段的题跟着这一段一起消失。
   *
   * 不在这里发事件：题的去处只有两条事件，一条是「问了」、一条是「答了」，而没有哪一种能说
   * 「题没被答就没了」。硬拿 `question.answered` 顶替是编一个没发生过的答案 —— 客户端会照着那个
   * 值去走一遍「答完之后该发生什么」。
   *
   * 等答复的那个人（{@link askAwaitable}）在这里解出 `undefined`：没人答它了，不是「不」。
   */
  forget(sessionId: string): void {
    for (const [id, question] of this.questions) {
      if (question.sessionId !== sessionId) continue;
      this.questions.delete(id);
      const settle = this.waiting.get(id);
      this.waiting.delete(id);
      settle?.(undefined);
    }
  }

  /** 造一道题：id 与时间在这里给，内容由调用方给 */
  private create(input: AskInput): Question {
    return {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      message: input.message,
      choices: input.choices,
      // 缺省挡着：题就是为「停下来问」而造的，不挡的那一种是调用方显式说出来的
      blocking: input.blocking ?? true,
      createdAt: Date.now(),
    };
  }

  /** 题进表、事件出去：两条路（`ask` 与 `askAwaitable`）共用它，免得事件只有一条路发得出去 */
  private publish(question: Question): void {
    this.questions.set(question.id, question);
    this.deps.events.emit({
      type: "question.asked",
      sessionId: question.sessionId,
      question,
    });
  }
}
