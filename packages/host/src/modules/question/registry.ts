import type { Bus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import type { HostEvent } from "../events.js";
import type { Translator } from "../i18n/index.js";
import type { FormAction, FormAnswer, FormField, FormRequest, FormSchema } from "./types.js";

export interface QuestionRegistryDeps {
  readonly events: Bus<HostEvent>;
  readonly t: Translator;
}

/** 问一道题要的事实：id 与时间由 `ask` 当场给，调用方给的是内容 */
export interface AskInput {
  readonly sessionId: string;
  readonly message: string;
  readonly requestedSchema: FormSchema;
  /** 不给就是挡着 */
  readonly blocking?: boolean;
  /** 这道题允许交哪几态；不给就是三态齐全（见 `FormRequest.actions`） */
  readonly actions?: readonly FormAction[];
}

/**
 * 题只存在内存里：一张表，没有库表，也没有状态格。
 *
 * 它只有两种去处：被答了、它那一段没了。两个去处都在这一张表上收场 —— 答过的那一条当场摘掉，
 * 所以「还挂着」与「在表里」是同一个事实。多留一格 `state` 会让两处各说一半：表里有它、状态说
 * 已答，读到这种中间态的调用方必须自己判断该信哪一个。
 */
export class QuestionRegistry {
  private readonly questions = new Map<string, FormRequest>();
  /**
   * 等答复的那些人，按题 id。与 `questions` 同生同死：表里没了的那一格，这里也不能留着。
   *
   * 不进 `FormRequest` 本体：那一份是要发到客户端去的（`question.asked` 的载荷），一个函数放进去
   * 既过不了 wire，也不是题的一部分。
   */
  private readonly waiting = new Map<string, (answer: FormAnswer | undefined) => void>();

  constructor(private readonly deps: QuestionRegistryDeps) {}

  ask(input: AskInput): FormRequest {
    const question = this.create(input);
    this.publish(question);
    return question;
  }

  get(id: string): FormRequest | undefined {
    return this.questions.get(id);
  }

  /** 这一段上还挂着的题，按提出的先后 */
  list(sessionId: string): FormRequest[] {
    const found: FormRequest[] = [];
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
   *
   * `accept` 的 `content` 按题自己那张表校验一遍：面板由宿主渲染，但填进来的是用户，
   * 而接上外部服务器之后这一格还会来自更远的地方 —— 形状不对就在这里拒，别让一个类型错的值
   * 穿到下游去。
   */
  answer(id: string, answer: FormAnswer): FormRequest {
    const question = this.get(id);
    if (question === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("找不到 id 为 {questionId} 的题", { questionId: id }),
        { entity: "question", questionId: id },
      );
    }

    assertActionOffered(question, answer, this.deps.t);
    const normalized = normalize(question, answer, this.deps.t);

    this.questions.delete(id);
    // 那一格也收掉：一张只增不减的表会一直长，而答过的题谁也不会再回来取
    const settle = this.waiting.get(id);
    this.waiting.delete(id);
    this.deps.events.emit({
      type: "question.answered",
      sessionId: question.sessionId,
      questionId: id,
      answer: normalized,
    });
    settle?.(normalized);
    return question;
  }

  /**
   * 问一道题并等一个答复。
   *
   * 等不到的情形有两种，都回 `undefined`：那一段没了（{@link forget}），以及题被答了之后才轮到
   * 等的那一方 —— 后者在现实中不会发生（先登记再发事件，见下），留着只是因为类型上必须有。
   *
   * 题仍然只做实时、不落库：挂着的这一格只
   * 活在内存里，进程没了它就没了。`undefined` 不是「用户说了不」而是「没人答它了」—— 调用方据此
   * 按默认执行者走，不能把它当成一个否定的答复。
   */
  askAwaitable(input: AskInput): {
    question: FormRequest;
    answer: Promise<FormAnswer | undefined>;
  } {
    const question = this.create(input);
    // 先登记再发事件：`question.asked` 一出去，答的人就可能在同一拍把答案递回来（同步的订阅者
    // 就是那样），而那一刻如果没人在等，这个 Promise 就永远不会兑现 —— 发题的人就挂在那里了。
    const answer = new Promise<FormAnswer | undefined>((resolve) => {
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
  private create(input: AskInput): FormRequest {
    return {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      message: input.message,
      requestedSchema: input.requestedSchema,
      ...(input.actions === undefined ? {} : { actions: [...new Set(input.actions)] }),
      // 缺省挡着：题就是为「停下来问」而造的，不挡的那一种是调用方显式说出来的
      blocking: input.blocking ?? true,
      createdAt: Date.now(),
    };
  }

  /** 题进表、事件出去：两条路（`ask` 与 `askAwaitable`）共用它，免得事件只有一条路发得出去 */
  private publish(question: FormRequest): void {
    this.questions.set(question.id, question);
    this.deps.events.emit({
      type: "question.asked",
      sessionId: question.sessionId,
      question,
    });
  }
}

/**
 * 把一次作答收成能落地的那一份：`accept` 校验内容，另两种把内容丢掉。
 *
 * 校验只做这张表声明过的事（必填、枚举、类型与范围），不引入 JSON Schema 引擎：表由宿主
 * 或者 MCP 服务器按同一个子集给出，子集之外的东西本来就该在产生它的那一侧被挡掉。
 */
/**
 * 交回来的那一态必须是这道题开着的。
 *
 * 面板只会画开着的按钮，但答话这条路不只面板在用：客户端可以自己拼一份 `question.answer`。
 * 开了两态的题收到第三种，那是调用方的错，不是这道题的答复 —— 在这里拒掉，别让它落到出题方手里
 * 变成一个它没打算处理的取值。
 */
function assertActionOffered(question: FormRequest, answer: FormAnswer, t: Translator): void {
  const offered = question.actions;
  if (offered === undefined || offered.includes(answer.action)) return;
  throw new HostError("invalid_params", t("这道题不接受这种作答"), {
    questionId: question.id,
    action: answer.action,
    offered: offered.join(", "),
  });
}

function normalize(question: FormRequest, answer: FormAnswer, t: Translator): FormAnswer {
  if (answer.action !== "accept") {
    // 拒了、关掉了：内容没有意义，留着它就是一份没人认领的输入
    return { action: answer.action };
  }

  const content = answer.content ?? {};
  const { properties, required } = question.requestedSchema;

  for (const name of required ?? []) {
    if (!(name in content)) {
      throw invalid(t, question.id, `缺字段 ${name}`);
    }
  }

  for (const [name, value] of Object.entries(content)) {
    const field = properties[name];
    if (field === undefined) {
      throw invalid(t, question.id, `表里没有字段 ${name}`);
    }
    const problem = checkField(field, value);
    if (problem !== undefined) {
      throw invalid(t, question.id, `${name}：${problem}`);
    }
  }

  return { action: "accept", content };
}

function checkField(field: FormField, value: unknown): string | undefined {
  switch (field.type) {
    case "string":
      if (typeof value !== "string") return "不是字符串";
      if (field.enum !== undefined && !field.enum.includes(value)) return "不在候选里";
      if (field.minLength !== undefined && value.length < field.minLength) return "太短";
      if (field.maxLength !== undefined && value.length > field.maxLength) return "太长";
      return undefined;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "不是数字";
      return rangeProblem(field, value);
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return "不是整数";
      return rangeProblem(field, value);
    case "boolean":
      return typeof value === "boolean" ? undefined : "不是布尔值";
    case "array": {
      if (!Array.isArray(value)) return "不是数组";
      if (!value.every((item) => typeof item === "string" && field.items.enum.includes(item))) {
        return "有不在候选里的项";
      }
      if (field.minItems !== undefined && value.length < field.minItems) return "项数太少";
      if (field.maxItems !== undefined && value.length > field.maxItems) return "项数太多";
      return undefined;
    }
  }
}

function rangeProblem(
  field: { minimum?: number; maximum?: number },
  value: number,
): string | undefined {
  if (field.minimum !== undefined && value < field.minimum) return "小于下限";
  if (field.maximum !== undefined && value > field.maximum) return "大于上限";
  return undefined;
}

function invalid(t: Translator, questionId: string, reason: string): HostError {
  return new HostError(
    "invalid_params",
    t("题 {questionId} 的答案不合这张表：{reason}", {
      questionId,
      reason,
    }),
    { entity: "question", questionId, reason },
  );
}
