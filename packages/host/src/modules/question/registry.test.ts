/**
 * 两条验收。一条钉住「题只有一次生命」：答过的那道题若还留在登记表里，界面会一直显示它在等
 * 人答；若再答一次还能走一遍，那一件事就被做了两遍 —— 两处都看不出来，只能在这里钉住。
 *
 * 另一条钉住 `forget` 只清那一段会话的题：写成「清空整张表」时，别的段上正等着人答的题会
 * 凭空消失，而那一段的用户看不出是谁拿走的。
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
  it("答过一次之后再答会抛，答完 pending 里没有它", () => {
    const questions = createRegistry();
    const question = questions.ask({
      sessionId: "s-1",
      message: "这段会话要用哪种方式交接",
      choices: HANDOFF,
    });

    expect(questions.pending("s-1")).toEqual([question]);
    expect(questions.answer(question.id, "self")).toEqual(question);

    expect(questions.pending("s-1")).toEqual([]);
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
});
