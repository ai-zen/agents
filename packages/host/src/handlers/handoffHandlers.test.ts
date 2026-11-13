/**
 * `handoff.*` 的接线验收：语言从连接传下去、两种失败形态（取消 / 真失败）原样交给接线层、
 * 文档列表原样交回。
 */

import { describe, expect, it } from "vitest";

import type { Language } from "../i18n/index.js";
import type { MethodCallContext } from "../net/WsHub.js";
import type {
  HandoffListDocumentsParams,
  HandoffListDocumentsResult,
  HandoffStartParams,
  HandoffStartResult,
  MethodName,
  MethodParams,
} from "../wire/index.js";
import { HostError } from "../wire/errors.js";
import { isMethodName } from "../wire/index.js";
import { createHandoffHandlers } from "./handoffHandlers.js";

function call<M extends MethodName>(
  method: M,
  params: MethodParams<M>,
  language: Language,
  connectionId = "conn-1",
): MethodCallContext<M> {
  return {
    method,
    params,
    connection: { id: connectionId, language, clientInfo: null, credentialId: null },
  };
}

/** 交接服务的替身：记下被怎么调，返回一份最小结果 */
function fakeHandoff() {
  const calls: Array<{ params: HandoffStartParams; language: Language | undefined }> = [];
  const listCalls: HandoffListDocumentsParams[] = [];
  let failure: HostError | null = null;
  const result: HandoffStartResult = {
    document: {
      path: "/p/.ai-zen/handoffs/20260101-000000.md",
      bytes: 512,
      writtenAt: "2026-01-01T00:00:00.000Z",
      mode: "summary",
    },
    requestedMode: "summary",
    usedMode: "summary",
    degraded: false,
    problem: null,
    conversation: {} as HandoffStartResult["conversation"],
    newConversationId: "c2",
  };
  const documents: HandoffListDocumentsResult = {
    documents: [
      {
        path: "/p/.ai-zen/handoffs/20260101-000000.md",
        name: "20260101-000000.md",
        bytes: 512,
        modifiedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };

  const service = {
    start: async (params: HandoffStartParams, language?: Language) => {
      calls.push({ params, language });
      if (failure) throw failure;
      return result;
    },
    listDocuments: async (params: HandoffListDocumentsParams) => {
      listCalls.push(params);
      return documents;
    },
  };

  return {
    service,
    calls,
    listCalls,
    result,
    documents,
    fail(error: HostError | null) {
      failure = error;
    },
  };
}

describe("handoff.* 接线", () => {
  it("起始参数与连接语言一起递下去", async () => {
    const fake = fakeHandoff();
    const handlers = createHandoffHandlers({ handoff: fake.service });

    const returned = await handlers["handoff.start"]?.(
      call(
        "handoff.start",
        { conversationId: "c1", mode: "self", then: "new_conversation", questionId: "q1" },
        "zh",
      ),
    );

    expect(fake.calls).toEqual([
      {
        params: { conversationId: "c1", mode: "self", then: "new_conversation", questionId: "q1" },
        language: "zh",
      },
    ]);
    expect(returned).toBe(fake.result);
  });

  it("用户取消（handoff_declined）原样抛给接线层：它不是失败", async () => {
    const fake = fakeHandoff();
    fake.fail(new HostError("handoff_declined", { detail: { reason: "cancelled" } }));
    const handlers = createHandoffHandlers({ handoff: fake.service });

    await expect(
      handlers["handoff.start"]?.(
        call("handoff.start", { conversationId: "c1", mode: "self", then: "document_only" }, "en"),
      ),
    ).rejects.toMatchObject({ code: "handoff_declined" });
  });

  it("真失败（internal + 交接没走通）也原样抛", async () => {
    const fake = fakeHandoff();
    fake.fail(
      new HostError("internal", {
        messageKey: "error.handoffFailed",
        params: { reason: "写不出文档" },
      }),
    );
    const handlers = createHandoffHandlers({ handoff: fake.service });

    await expect(
      handlers["handoff.start"]?.(
        call("handoff.start", { conversationId: "c1", mode: "summary", then: "document_only" }, "en"),
      ),
    ).rejects.toMatchObject({ code: "internal", messageKey: "error.handoffFailed" });
  });

  it("文档列表按项目取，原样交回", async () => {
    const fake = fakeHandoff();
    const handlers = createHandoffHandlers({ handoff: fake.service });

    const listed = await handlers["handoff.listDocuments"]?.(
      call("handoff.listDocuments", { workspaceId: "w1" }, "en"),
    );
    expect(fake.listCalls).toEqual([{ workspaceId: "w1" }]);
    expect(listed).toBe(fake.documents);
  });

  it("方法表里这两个方法都注册了", () => {
    const fake = fakeHandoff();
    const handlers = createHandoffHandlers({ handoff: fake.service });
    // 注册的键必须是方法表里认得的方法名（isMethodName 是运行期的同一份真相）
    const names = Object.keys(handlers).filter(isMethodName);
    expect(names.sort()).toEqual(["handoff.listDocuments", "handoff.start"]);
  });
});
