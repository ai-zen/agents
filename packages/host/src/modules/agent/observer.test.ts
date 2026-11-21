/**
 * 一条验收：一条带两个 `__asset_id` 的消息经观察者落库之后，`session_assets` 里恰两行；同一条
 * 消息再报一次 `messageChanged` 之后仍然是两行。
 *
 * 两半各管一件事：
 * - 少了登记，那份素材就没人认领 —— 用户删了那条消息之后它会被当成无主的东西删掉，而列表里
 *   它又还在；
 * - 不幂等，「同一条消息被报很多次」就会把引用行乘以次数（流式期间一条长回答会被写很多次），
 *   `countByAsset` 于是永远归不了零。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, AgentNS, Message } from "@ai-zen/agents-core";
import type { AgentRuntime, RuntimeFact } from "@ai-zen/agents-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { AssetService } from "../asset/service.js";
import { assetTable, sessionAssetTable } from "../asset/table.js";
import { messageTable } from "../session/messages.js";
import { sessionTable } from "../session/table.js";
import { WorkspaceService } from "../workspace/service.js";
import { workspaceTable } from "../workspace/table.js";
import { inboxTable } from "./inbox.js";
import { HostObserver } from "./observer.js";

const dataRoots: string[] = [];

afterEach(() => {
  for (const dataRoot of dataRoots.splice(0)) rmSync(dataRoot, { recursive: true, force: true });
});

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "observer-"));
  dataRoots.push(dataRoot);

  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });
  sessionTable(db).put({
    id: "s-1",
    workspaceId: "ws-1",
    name: "1712345678000",
    nameIsAuto: true,
    pinned: false,
    agentId: "agent-1",
    modelId: "model-1",
    thinkingLevel: null,
    autoHandoff: false,
    lineage: null,
    handoffThreshold: null,
    guardThreshold: null,
    pendingHandoff: null,
    createdAt: 1,
    updatedAt: 1,
  });

  const t = createTranslator(() => "zh");
  const messages = messageTable(db);
  const assetRows = assetTable(db);
  const sessionAssets = sessionAssetTable(db);
  const assets = new AssetService({ assets: assetRows, sessionAssets, dataRoot, t });
  const events = createBus<HostEvent>();
  const errors: unknown[] = [];

  const listeners: Array<(fact: RuntimeFact) => void> = [];
  new HostObserver({
    messages,
    inbox: inboxTable(db),
    assets,
    events,
    onError: (error) => errors.push(error),
    isHandingOff: () => false,
  }).attach({
    observe: (listener: (fact: RuntimeFact) => void) => {
      listeners.push(listener);
      return () => undefined;
    },
  } as unknown as AgentRuntime);

  // 素材行得先在：`session_assets.assetId` 指着它（引用行不能凭空造一个 id）
  const first = assets.store(Buffer.from("第一张图"), "image/png", "一.png");
  const second = assets.store(Buffer.from("第二张图"), "image/png", "二.png");

  return {
    messages,
    sessionAssets,
    errors,
    first,
    second,
    emit: (fact: RuntimeFact) => {
      for (const listener of listeners) listener(fact);
    },
  };
}

/** 带两段素材引用的一条用户消息：`__asset_id` 是段上的本地标记，会原样落库 */
function messageWithAssets(id: string, assetIds: readonly string[]): AgentNS.Message {
  return new Message({
    id,
    role: AgentNS.Role.User,
    status: AgentNS.MessageStatus.Completed,
    content: [
      { type: "text", text: "这两张" },
      ...assetIds.map(
        (assetId) => ({ type: "image_url", image_url: { url: "" }, __asset_id: assetId }) as never,
      ),
    ],
  });
}

const agent = new Agent({ client: {} as never, model: "model-1" });

describe("观察者登记素材引用", () => {
  it("一条带两个 `__asset_id` 的消息落库之后恰两行引用，再报一次 `messageChanged` 仍是两行", () => {
    const { emit, first, second, sessionAssets, messages } = setup();
    const message = messageWithAssets("m-1", [first.id, second.id]);

    emit({
      type: "messageAdded",
      sessionId: "s-1",
      agent,
      seq: 1,
      at: "2026-01-01T00:00:00Z",
      message,
    });

    expect(sessionAssets.countByAsset(first.id)).toBe(1);
    expect(sessionAssets.countByAsset(second.id)).toBe(1);
    // 内容原样入库：`__asset_id` 还在那两段上（清理只发生在发出那一刻）
    expect(messages.get("m-1")?.content).toEqual(message.content);

    emit({
      type: "messageChanged",
      sessionId: "s-1",
      agent,
      seq: 2,
      at: "2026-01-01T00:00:01Z",
      message,
    });

    expect(sessionAssets.countByAsset(first.id)).toBe(1);
    expect(sessionAssets.countByAsset(second.id)).toBe(1);
  });
});
