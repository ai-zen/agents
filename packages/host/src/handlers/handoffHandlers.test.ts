/**
 * `handoff.*` 的接线验收：语言从连接传下去、起始参数原样递下去、文档列表原样交回。
 *
 * 两条口径：
 *
 * 1. `handoff.start` 只回「已经开始」，所以这里**没有**「取消 / 失败怎么回给调用方」这两条 ——
 *    那一趟在后台跑，结局走通知与 `conversation.changed`（见 `services/HandoffService.test.ts`）。
 * 2. 接线层**不掐在途、不编排**（那条中断语义已作废）：入口判据「非空闲就拒」在服务里，
 *    本域的 deps 因此不再要 `runner`。
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

/** 交接服务的替身：记下被怎么调，返回「已经开始」 */
function fakeHandoff() {
  const calls: Array<{ params: HandoffStartParams; language: Language | undefined }> = [];
  const listCalls: HandoffListDocumentsParams[] = [];
  let failure: HostError | null = null;
  const result: HandoffStartResult = { started: true };
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
  it("把起始参数与连接语言原样递下去（接线层不多做一步）", async () => {
    const fake = fakeHandoff();
    const handlers = createHandoffHandlers({ handoff: fake.service });

    const returned = await handlers["handoff.start"]?.(
      call("handoff.start", { conversationId: "c1", mode: "self", then: "new_conversation" }, "zh"),
    );

    expect(fake.calls).toEqual([
      {
        params: { conversationId: "c1", mode: "self", then: "new_conversation" },
        language: "zh",
      },
    ]);
    expect(returned).toBe(fake.result);
  });

  it("非空闲被拒时原样抛给调用方（busy 是服务那边判的，接线层不改写）", async () => {
    const fake = fakeHandoff();
    fake.fail(
      new HostError("busy", { detail: { conversationId: "c1", reason: "working" } }),
    );
    const handlers = createHandoffHandlers({ handoff: fake.service });

    await expect(
      handlers["handoff.start"]?.(
        call("handoff.start", { conversationId: "c1", mode: "self", then: "document_only" }, "zh"),
      ),
    ).rejects.toMatchObject({ code: "busy", detail: { reason: "working" } });
  });

  it("参数不对照样在这里被拒（校验在返回「已经开始」之前）", async () => {
    const fake = fakeHandoff();
    fake.fail(
      new HostError("invalid_params", {
        params: { field: "mode" },
        detail: { field: "mode", value: "prune" },
      }),
    );
    const handlers = createHandoffHandlers({ handoff: fake.service });

    await expect(
      handlers["handoff.start"]?.(
        call(
          "handoff.start",
          { conversationId: "c1", mode: "prune" as unknown as "self", then: "document_only" },
          "en",
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_params" });
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
