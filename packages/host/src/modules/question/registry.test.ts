/**
 * 四条验收。前两条钉住「题只有一次生命」：答过的那道题若还留在登记表里，界面会一直显示它在等
 * 人答；若再答一次还能走一遍，那一件事就被做了两遍 —— 两处都看不出来，只能在这里钉住。
 *
 * 第三条钉住 `forget` 只清那一段会话的题：写成「清空整张表」时，别的段上正等着人答的题会
 * 凭空消失，而那一段的用户看不出是谁拿走的。
 *
 * 后两条（`askAwaitable`）钉住「等」这件事：答了要解出那个 value，「题没被答就没了」要解出
 * `undefined` —— 后者不是「用户说了不」，而是一条真实的死路：调用方拿着 `undefined` 就得按默认
 * 执行者走，两道意思在同一个值上汇合就不行。
 */

import { describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { QuestionRegistry } from "./registry.js";
import type { Choice } from "./types.js";

const HANDOFF: readonly Choice[] = [
  { value: "self", label: "在这段会话里自己写" },
  { value: "summary", label: "另起一次调用写摘要" },
  { value: "decline", label: "不交接" },
];

function createRegistry(): QuestionRegistry {
  return new QuestionRegistry({ events: createBus<HostEvent>(), t: createTranslator(() => "zh") });
}

describe("提问", () => {
  it("答过一次之后再答会抛，答完列表里没有它", () => {
    const questions = createRegistry();
    const question = questions.ask({
      sessionId: "s-1",
      message: "这段会话要用哪种方式交接",
      choices: HANDOFF,
    });

    expect(questions.list("s-1")).toEqual([question]);
    expect(questions.answer(question.id, "self")).toEqual(question);

    expect(questions.list("s-1")).toEqual([]);
    expect(questions.get(question.id)).toBeUndefined();
    expect(() => questions.answer(question.id, "decline")).toThrowError(HostError);
  });

  it("forget 只清那一段的题", () => {
    const questions = createRegistry();
    const gone = questions.ask({
      sessionId: "s-1",
      message: "这段会话要用哪种方式交接",
      choices: HANDOFF,
    });
    const kept = questions.ask({
      sessionId: "s-2",
      message: "这段会话要用哪种方式交接",
      choices: HANDOFF,
    });

    questions.forget("s-1");

    expect(questions.list("s-1")).toEqual([]);
    expect(questions.get(gone.id)).toBeUndefined();
    expect(questions.list("s-2")).toEqual([kept]);
  });

  it("问出去能等一个答复：答了之后 Promise 解出那个 value，题也不在表里了", async () => {
    const questions = createRegistry();
    const { question, answer } = questions.askAwaitable({
      sessionId: "s-1",
      message: "这段会话要用哪种方式交接",
      choices: HANDOFF,
    });

    // 题还是同一道题：同一条表、同一个 id
    expect(questions.list("s-1")).toEqual([question]);

    questions.answer(question.id, "self");

    await expect(answer).resolves.toBe("self");
    expect(questions.get(question.id)).toBeUndefined();
    expect(questions.list("s-1")).toEqual([]);
  });

  it("没人答它就没了：forget 之后 Promise 解出 undefined", async () => {
    const questions = createRegistry();
    const { question, answer } = questions.askAwaitable({
      sessionId: "s-1",
      message: "这段会话要用哪种方式交接",
      choices: HANDOFF,
    });
    // 同一张表上另一段的题：它不该被这一段消失带走
    const kept = questions.askAwaitable({
      sessionId: "s-2",
      message: "这段会话要用哪种方式交接",
      choices: HANDOFF,
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

  it("同一拍答回来也不会挂：订阅者在 question.asked 里当场就答，一样解得出值", async () => {
    // 题先登记、后发事件：倒过来的话，这一拍里 `answer()` 找不到等的人，那个 Promise
    // 永远不会兑现 —— 发题的人（越线那一刻的交接）就挂在那里了，而界面上什么也看不出来
    const events = createBus<HostEvent>();
    const questions = new QuestionRegistry({ events, t: createTranslator(() => "zh") });
    events.subscribe((event) => {
      if (event.type === "question.asked") questions.answer(event.question.id, "self");
    });

    const { question, answer } = questions.askAwaitable({
      sessionId: "s-1",
      message: "这段会话要用哪种方式交接",
      choices: HANDOFF,
    });

    await expect(answer).resolves.toBe("self");
    expect(questions.get(question.id)).toBeUndefined();
  });
});
