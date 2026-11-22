/**
 * 两条验收。
 *
 * 其一：一条带两个 `__asset_id` 的消息经观察者落库之后，`session_assets` 里恰两行；同一条
 * 消息再报一次 `messageChanged` 之后仍然是两行。
 *
 * 两半各管一件事：
 * - 少了登记，那份素材就没人认领 —— 用户删了那条消息之后它会被当成无主的东西删掉，而列表里
 *   它又还在；
 * - 不幂等，「同一条消息被报很多次」就会把引用行乘以次数（流式期间一条长回答会被写很多次），
 *   `countByAsset` 于是永远归不了零。
 *
 * 其二：关机时 `inboxCleared` 不删库，没关机时照删。两者是同一个内核事实（`kill` 清空队列），
 * 后果却相反 —— 关机不是杀死那一段，还没被处理的那几句话一条都没作废，下次打开还要接着等。
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
    createdAt: 1,
    updatedAt: 1,
  });

  const t = createTranslator(() => "zh");
  const messages = messageTable(db);
  const inbox = inboxTable(db);
  const assetRows = assetTable(db);
  const sessionAssets = sessionAssetTable(db);
  const assets = new AssetService({ assets: assetRows, sessionAssets, dataRoot, t });
  const events = createBus<HostEvent>();
  /** 观察者交给 `onError` 的每一条：错误本身与它贴的那个标签 */
  const errors: Array<{ error: unknown; what: string }> = [];

  const listeners: Array<(fact: RuntimeFact) => void> = [];
  const observer = new HostObserver({
    messages,
    inbox,
    assets,
    events,
    onError: (error, what) => errors.push({ error, what }),
    isHandingOff: () => false,
  });
  observer.attach({
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
    inbox,
    observer,
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

/** 一段会话预置两条还没被处理的话：它们只活在 core 的队列里就会随进程消失，所以要落库 */
function presetInbox(inbox: ReturnType<typeof inboxTable>): void {
  inbox.insert("s-1", {
    messageId: "m-pending-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    priority: "high",
    source: { kind: "user" },
    content: "第一句还在等",
  });
  inbox.insert("s-1", {
    messageId: "m-pending-2",
    createdAt: "2026-01-01T00:00:01.000Z",
    priority: "high",
    source: { kind: "user" },
    content: "第二句还在等",
  });
}

/** `kill` 清空队列时 core 报的那一条 */
function inboxClearedFact(): RuntimeFact {
  return {
    type: "inboxCleared",
    sessionId: "s-1",
    agent,
    seq: 1,
    at: "2026-01-01T00:00:02.000Z",
    entries: [],
  };
}

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

describe("关机时排队区不作废", () => {
  it("没调 `shutdown()`：`inboxCleared` 照老样子把两行删掉", () => {
    const { emit, inbox } = setup();
    presetInbox(inbox);
    expect(inbox.listBySession("s-1")).toHaveLength(2);

    emit(inboxClearedFact());

    expect(inbox.listBySession("s-1")).toHaveLength(0);
  });

  it("调了 `shutdown()`：同一个事实不再删库，两行还在等下一次打开", () => {
    const { emit, inbox, observer } = setup();
    presetInbox(inbox);
    expect(inbox.listBySession("s-1")).toHaveLength(2);

    observer.shutdown();
    emit(inboxClearedFact());

    expect(inbox.listBySession("s-1").map((entry) => entry.messageId)).toEqual([
      "m-pending-1",
      "m-pending-2",
    ]);
  });
});

/** 投递那条路写下去的那一条（宿主自己投的条目都带 `messageId`） */
function pendingEntry(messageId: string, content: string) {
  return {
    messageId,
    createdAt: "2026-01-01T00:00:03.000Z",
    priority: "high" as const,
    source: { kind: "user" as const },
    content,
  };
}

/** 一段有正文的条目进队时 core 报的那一条 */
function inboxAddedFact(
  sessionId: string,
  entry: ReturnType<typeof pendingEntry>,
): RuntimeFact {
  return {
    type: "inboxAdded",
    sessionId,
    agent,
    seq: 1,
    at: "2026-01-01T00:00:03.000Z",
    entry,
  };
}

describe("观察者写 inbox", () => {
  it("投递那条路已经先写过同一行：再来一条 `inboxAdded` 不报错，也不多一行", () => {
    const { emit, inbox, errors } = setup();
    const entry = pendingEntry("m-1", "这句话还在等");

    // 投递那一路的「先落库」：它排在 `push` 之前，所以观察者收到事实时这一行已经在库里
    inbox.insert("s-1", entry);
    emit(inboxAddedFact("s-1", entry));

    expect(errors).toEqual([]);
    expect(inbox.listBySession("s-1")).toHaveLength(1);
    expect(inbox.listBySession("s-1")[0]).toEqual(entry);
  });

  it("`sessionId` 指不到会话：这一次写库失败照旧被报成错误", () => {
    const { emit, errors } = setup();

    emit(inboxAddedFact("no-such-session", pendingEntry("m-1", "没处安放")));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.what).toBe("inbox-write");
    expect(String(errors[0]?.error)).toMatch(/FOREIGN KEY|constraint/);
  });
});
