/**
 * 补拉的验收：`conversation.state` + `message.list({ after })` 怎么要、怎么拼。
 *
 * 这里的调用方是假的（`ContractCaller`），所以断言的是「发了哪两帧、参数是什么、结果拼成什么」，
 * 不牵扯 socket。
 */

import { describe, expect, it } from "vitest";

import type {
  ConversationState,
  MessageListResult,
  MethodName,
  MethodParams,
  MethodResult,
} from "@ai-zen/agents-server";

import { lastMessageId, mergeResumed, resumeConversation, type ContractCaller } from "./resume.js";
import { assistantMessage, conversationState, userMessage } from "./testSupport/fakeServer.js";

/** 记下每次调用的方法名与参数，按脚本回结果 */
function fakeCaller(answers: { state: ConversationState; listed: MessageListResult }): {
  caller: ContractCaller;
  calls: { method: string; params: unknown }[];
} {
  const calls: { method: string; params: unknown }[] = [];
  const caller = {
    async call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
      calls.push({ method, params });
      if (method === "conversation.state") {
        return { state: answers.state } as MethodResult<M>;
      }
      if (method === "message.list") {
        return answers.listed as MethodResult<M>;
      }
      throw new Error(`用例没准备这个方法：${method}`);
    },
  };
  return { caller, calls };
}

describe("resumeConversation", () => {
  it("先拉 state、再拉消息；`after` 原样带出去（A12）", async () => {
    const { caller, calls } = fakeCaller({
      state: conversationState("c1"),
      listed: {
        conversationId: "c1",
        anchor: "m2",
        messages: [assistantMessage("m2", "答完了"), userMessage("m3", "接着问")],
      },
    });

    const resumed = await resumeConversation(caller, "c1", "m2");

    expect(calls.map((call) => call.method)).toEqual(["conversation.state", "message.list"]);
    expect(calls[1]?.params).toEqual({ conversationId: "c1", after: "m2" });
    expect(resumed.mode).toBe("anchor");
    expect(resumed.anchor).toBe("m2");
    expect(resumed.messages.map((message) => message.id)).toEqual(["m2", "m3"]);
    expect(resumed.state.conversationId).toBe("c1");
  });

  it("没有锚点时不带 `after` 这个键；服务端回 anchor null 就是全量", async () => {
    const { caller, calls } = fakeCaller({
      state: conversationState("c1"),
      listed: { conversationId: "c1", anchor: null, messages: [userMessage("m1", "问")] },
    });

    const resumed = await resumeConversation(caller, "c1");

    // 不发 `after: undefined`：帧里连这个键都不该有
    expect(calls[1]?.params).toEqual({ conversationId: "c1" });
    expect(resumed.mode).toBe("full");
    expect(resumed.anchor).toBeNull();
  });
});

describe("mergeResumed", () => {
  const resumed = (
    over: Partial<{ anchor: string | null; messages: ReturnType<typeof userMessage>[] }> = {},
  ) => ({
    conversationId: "c1",
    state: conversationState("c1"),
    anchor: over.anchor === undefined ? "m2" : over.anchor,
    messages: over.messages ?? [assistantMessage("m2", "答完了"), userMessage("m3", "接着问")],
    mode: (over.anchor === null ? "full" : "anchor") as "full" | "anchor",
  });

  it("续传：anchor 那条整体替换（流式中那条按最新内容换掉，不是追加）", () => {
    const local = [userMessage("m1", "问"), assistantMessage("m2", "答到一半")];
    const merged = mergeResumed(local, resumed());
    expect(merged.map((message) => message.content)).toEqual(["问", "答完了", "接着问"]);
    // anchor 之前的部分原样（还是本地那条对象）
    expect(merged[0]).toBe(local[0]);
  });

  it("全量：整份换掉", () => {
    const local = [userMessage("old", "旧的"), assistantMessage("old2", "更旧")];
    const merged = mergeResumed(
      local,
      resumed({ anchor: null, messages: [userMessage("x1", "现在的")] }),
    );
    expect(merged.map((message) => message.id)).toEqual(["x1"]);
  });

  it("续传但本地找不到那条：以服务端为准", () => {
    const merged = mergeResumed([userMessage("gone", "撤回过")], resumed());
    expect(merged.map((message) => message.id)).toEqual(["m2", "m3"]);
  });
});

describe("lastMessageId", () => {
  it("取最后一条的 id；空列表没有", () => {
    expect(lastMessageId([userMessage("a", ""), assistantMessage("b", "")])).toBe("b");
    expect(lastMessageId([])).toBeUndefined();
  });
});
