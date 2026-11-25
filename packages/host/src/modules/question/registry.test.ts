/**
 * 六条验收。前两条钉住「题只有一次生命」：答过的那道题若还留在登记表里，界面会一直显示它在等
 * 人答；若再答一次还能走一遍，那一件事就被做了两遍 —— 两处都看不出来，只能在这里钉住。
 *
 * 第三条钉住 `forget` 只清那一段会话的题：写成「清空整张表」时，别的段上正等着人答的题会
 * 凭空消失，而那一段的用户看不出是谁拿走的。
 *
 * 后两条（`askAwaitable`）钉住「等」这件事：答了要解出那份答案，「题没被答就没了」要解出
 * `undefined` —— 后者不是「用户说了不」，而是一条真实的死路：调用方拿着 `undefined` 就得按默认
 * 执行者走，两道意思在同一个值上汇合就不行。
 *
 * 最后一条钉住「答案要被这张表接住」：面板是我们自己画的，但填进来的是用户、将来还会是外部
 * 服务器发来的 elicitation —— 形状不对就在这里拒，别让一个类型错的值穿到下游去。
 */

import { describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { QuestionRegistry } from "./registry.js";
import type { FormAnswer, FormSchema } from "./types.js";

/** 交接那道题：一个单选枚举字段（最常见的一格） */
const HANDOFF: FormSchema = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      title: "要用哪种方式交接",
      enum: ["self", "summary", "no"],
      enumNames: ["在这段会话里自己写", "另起一次调用写摘要", "不交接"],
    },
  },
  required: ["mode"],
};

/** 一次「选了某一个」的作答 */
const picked = (mode: string): FormAnswer => ({ action: "accept", content: { mode } });

function createRegistry(): QuestionRegistry {
  return new QuestionRegistry({ events: createBus<HostEvent>(), t: createTranslator(() => "zh") });
}

describe("提问", () => {
  it("答过一次之后再答会抛，答完列表里没有它", () => {
    const questions = createRegistry();
    const question = questions.ask({
      sessionId: "s-1",
      message: "这段会话要用哪种方式交接",
      requestedSchema: HANDOFF,
    });

    expect(questions.list("s-1")).toEqual([question]);
    expect(questions.answer(question.id, picked("self"))).toEqual(question);

    expect(questions.list("s-1")).toEqual([]);
    expect(questions.get(question.id)).toBeUndefined();
    expect(() => questions.answer(question.id, picked("no"))).toThrowError(HostError);
  });

  it("forget 只清那一段的题", () => {
    const questions = createRegistry();
    const gone = questions.ask({
      sessionId: "s-1",
      message: "这段会话要用哪种方式交接",
      requestedSchema: HANDOFF,
    });
    const kept = questions.ask({
      sessionId: "s-2",
      message: "这段会话要用哪种方式交接",
      requestedSchema: HANDOFF,
    });

    questions.forget("s-1");

    expect(questions.list("s-1")).toEqual([]);
    expect(questions.get(gone.id)).toBeUndefined();
    expect(questions.list("s-2")).toEqual([kept]);
  });

  it("问出去能等一个答复：答了之后 Promise 解出那份答案，题也不在表里了", async () => {
    const questions = createRegistry();
    const { question, answer } = questions.askAwaitable({
      sessionId: "s-1",
      message: "这段会话要用哪种方式交接",
      requestedSchema: HANDOFF,
    });

    // 题还是同一道题：同一条表、同一个 id
    expect(questions.list("s-1")).toEqual([question]);

    questions.answer(question.id, picked("self"));

    await expect(answer).resolves.toEqual({ action: "accept", content: { mode: "self" } });
    expect(questions.get(question.id)).toBeUndefined();
    expect(questions.list("s-1")).toEqual([]);
  });

  it("没人答它就没了：forget 之后 Promise 解出 undefined", async () => {
    const questions = createRegistry();
    const { question, answer } = questions.askAwaitable({
      sessionId: "s-1",
      message: "这段会话要用哪种方式交接",
      requestedSchema: HANDOFF,
    });
    // 同一张表上另一段的题：它不该被这一段消失带走
    const kept = questions.askAwaitable({
      sessionId: "s-2",
      message: "这段会话要用哪种方式交接",
      requestedSchema: HANDOFF,
    });

    questions.forget("s-1");

    await expect(answer).resolves.toBeUndefined();
    expect(questions.get(question.id)).toBeUndefined();
    // 那一段之外的那道题照旧挂着，也没被解成 undefined：拿一个立刻兑现的哨兵去比
    expect(questions.list("s-2")).toEqual([kept.question]);
    await expect(Promise.race([kept.answer, Promise.resolve("still-pending")])).resolves.toBe(
      "still-pending",
    );
  });

  it("同一拍答回来也不会挂：订阅者在 question.asked 里当场就答，一样解得出答案", async () => {
    // 题先登记、后发事件：倒过来的话，这一拍里 `answer()` 找不到等的人，那个 Promise
    // 永远不会兑现 —— 发题的人（越线那一刻的交接）就挂在那里了，而界面上什么也看不出来
    const events = createBus<HostEvent>();
    const questions = new QuestionRegistry({ events, t: createTranslator(() => "zh") });
    events.subscribe((event) => {
      if (event.type === "question.asked") questions.answer(event.question.id, picked("self"));
    });

    const { question, answer } = questions.askAwaitable({
      sessionId: "s-1",
      message: "这段会话要用哪种方式交接",
      requestedSchema: HANDOFF,
    });

    await expect(answer).resolves.toEqual({ action: "accept", content: { mode: "self" } });
    expect(questions.get(question.id)).toBeUndefined();
  });

  it("答案要被这张表接住：缺必填 / 不在候选里 / 类型不对都是 invalid_params", () => {
    const questions = createRegistry();
    const ask = () =>
      questions.ask({
        sessionId: "s-1",
        message: "这段会话要用哪种方式交接",
        requestedSchema: HANDOFF,
      });

    const missing = ask();
    expect(() => questions.answer(missing.id, { action: "accept", content: {} })).toThrowError(
      expect.objectContaining({ code: "invalid_params" }),
    );

    const foreign = ask();
    expect(() =>
      questions.answer(foreign.id, { action: "accept", content: { mode: "elsewhere" } }),
    ).toThrowError(expect.objectContaining({ code: "invalid_params" }));

    const wrongType = ask();
    expect(() =>
      questions.answer(wrongType.id, { action: "accept", content: { mode: 3 } }),
    ).toThrowError(expect.objectContaining({ code: "invalid_params" }));

    const unknownField = ask();
    expect(() =>
      questions.answer(unknownField.id, { action: "accept", content: { mode: "self", x: 1 } }),
    ).toThrowError(expect.objectContaining({ code: "invalid_params" }));
  });

  it("拒了 / 关掉：内容被丢掉（它不是一份没人认领的输入）", () => {
    const events = createBus<HostEvent>();
    const questions = new QuestionRegistry({ events, t: createTranslator(() => "zh") });
    const answered: HostEvent[] = [];
    events.subscribe((event) => {
      if (event.type === "question.answered") answered.push(event);
    });

    const question = questions.ask({
      sessionId: "s-1",
      message: "这段会话要用哪种方式交接",
      requestedSchema: HANDOFF,
    });
    // 客户端把选中的那一项一起递回来了，但这一趟说的是「拒绝」
    questions.answer(question.id, { action: "decline", content: { mode: "self" } });

    expect(answered).toEqual([
      {
        type: "question.answered",
        sessionId: "s-1",
        questionId: question.id,
        answer: { action: "decline" },
      },
    ]);
  });
});
