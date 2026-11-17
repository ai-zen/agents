/**
 * `conversation.*` 的验收：投递、素材挂接、按连接语言重渲染、中止、四格与待办、删除时的现场丢弃。
 *
 * 「真正属于 core 的那部分」在用例里照原样跑（`FakeAgent` 走同一个 `applyChunk`），只有
 * 「流从哪来」换成了脚本 —— 所以这里验的是接线，不是模型。
 *
 * 两条这个文件刻意**不验**的事（它们已经不是契约面了）：没有「一轮的运行状态」（用量与阶段归
 * 客户端按事件自己算）、没有「排队受理」这条分支（投递只有一条路，忙也照收）。
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentNS as AgentNSValue } from "@ai-zen/agents-core";

import { createHost } from "../app.js";
import type { HostApp } from "../app.js";
import { render } from "../i18n/index.js";
import type { ConnectionInfo } from "../net/index.js";
import { makeTempDir, wait, type TempDir } from "../net/TestSupport.js";
import type { AgentFactory } from "../runtime/index.js";
import { deferred, FakeAgent, type Deferred } from "../runtime/TestSupport.js";
import { HostError } from "../wire/index.js";
import type {
  ConversationAbortResult,
  ConversationDeleteResult,
  ConversationSendResult,
  ConversationView,
  MethodName,
  MethodParams,
  MethodResult,
} from "../wire/index.js";

/** 模型故意不带 `vision`：图片会退化成文字，于是「按连接语言重渲染」才有东西可验 */
const CONFIG = JSON.stringify(
  {
    endpoints: [
      { id: "fake", name: "Fake", baseUrl: "https://example.invalid/v1", apiKey: "sk-fake" },
    ],
    models: [
      {
        id: "test-model",
        name: "Test Model",
        endpointId: "fake",
        tokenThresholds: { handoff: 1000, guard: 2000 },
        custom: true,
      },
    ],
  },
  null,
  2,
);

const AGENT = JSON.stringify(
  {
    id: "default",
    name: "Test Assistant",
    modelId: "test-model",
    messages: [{ id: "sys-1", role: "system", status: "completed", content: "测试助手" }],
    custom: true,
  },
  null,
  2,
);

const temps: TempDir[] = [];
const apps: HostApp[] = [];

/** 一次回答：先想一句，再吐一句正文 */
function oneRound(): FakeAgent {
  return new FakeAgent([
    {
      deltas: [{ reasoning_content: "想一下。" }, { content: "好。" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);
}

interface Harness {
  app: HostApp;
  workspaceId: string;
  conversationId: string;
  workspaceDir: TempDir;
}

async function makeHarness(options: { createAgent?: AgentFactory } = {}): Promise<Harness> {
  const dataRoot = await makeTempDir("ai-zen-conv-handlers-");
  temps.push(dataRoot);
  await fs.mkdir(join(dataRoot.path, "agents"), { recursive: true });
  await fs.writeFile(join(dataRoot.path, "config.json"), CONFIG, "utf8");
  await fs.writeFile(join(dataRoot.path, "agents", "default.json"), AGENT, "utf8");
  const workspaceDir = await makeTempDir("ai-zen-conv-handlers-cwd-");
  temps.push(workspaceDir);

  const app = await createHost({
    aiZenDir: dataRoot.path,
    port: 0,
    local: true,
    createAgent: options.createAgent ?? (async () => oneRound()),
    exit: () => undefined,
    logger: { warn: () => undefined, error: () => undefined },
  });
  await app.start();
  apps.push(app);

  const { workspace } = await callMethod(app, "workspace.create", { cwd: workspaceDir.path });
  const conversation = await seedConversation(app, workspace.id);
  return {
    app,
    workspaceId: workspace.id,
    conversationId: conversation.id,
    workspaceDir,
  };
}

/**
 * 建一段对话并让它落库（R56：`conversation.create` 只发 id，首次 `send` 才写 `conversations` 行）。
 *
 * 这里的用例要看的是别的东西（列表、四格、删除），所以直接把草稿落成真行。
 */
async function seedConversation(app: HostApp, workspaceId: string): Promise<ConversationView> {
  const created = await callMethod(app, "conversation.create", {
    workspaceId,
    agentId: "default",
    modelId: "test-model",
  });
  if (!created.conversation) throw new Error("conversation.create 没有建出对话");
  await app.conversationService.ensurePersisted(created.conversation.id);
  return created.conversation;
}

async function callMethod<M extends MethodName>(
  app: HostApp,
  method: M,
  params: MethodParams<M> = {} as MethodParams<M>,
): Promise<MethodResult<M>> {
  const handler = app.handlers[method];
  if (!handler) throw new Error(`方法未注册：${method}`);
  return await handler({ method, params, connection: CONNECTION });
}

/** 按指定语言调一个方法（`attachments[].problem` 的重渲染要换语言才看得出来） */
async function callInLanguage<M extends MethodName>(
  app: HostApp,
  method: M,
  params: MethodParams<M>,
  language: ConnectionInfo["language"],
): Promise<MethodResult<M>> {
  const handler = app.handlers[method];
  if (!handler) throw new Error(`方法未注册：${method}`);
  return await handler({ method, params, connection: { ...CONNECTION, language } });
}

const CONNECTION: ConnectionInfo = {
  id: "test-connection",
  language: "en",
  clientInfo: null,
  credentialId: null,
};

/** 造一条素材行（等价于一次上传落定：临时文件 → 正式文件 + 库里的引用） */
async function uploadAsset(app: HostApp, conversationId: string): Promise<string> {
  const tempPath = join(app.paths.assetsDir, ".upload-conv.part");
  await fs.writeFile(tempPath, "png-bytes");
  const ref = await app.assetService.finalizeUpload({
    uploadId: "upload-conv",
    tempPath,
    mime: "image/png",
    bytes: 9,
    sha256: "not-checked-here",
    name: "a.png",
    purpose: "message_image",
    conversationId,
  });
  return ref.assetId;
}

/** 等这段对话真的闲下来（那一格是 idle、队里也空了），且写库推进完 */
async function idle(app: HostApp, conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const now = app.chatRunner.state(conversationId);
    if (now.status === "idle" && now.inbox.length === 0) return;
    await wait(10);
  }
  throw new Error("这段对话没有闲下来");
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop("requested").catch(() => undefined);
  for (const temp of temps.splice(0)) await temp.remove();
});

describe("conversation.send", () => {
  it("回执只有 userMessageId 与附件结局，并把素材记成用户消息的引用关系（L6 / D5）", async () => {
    const { app, conversationId } = await makeHarness();
    const assetId = await uploadAsset(app, conversationId);

    const sent = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "看图", assetIds: [assetId] },
    });

    // 回执里没有状态、没有「叫醒了没有」、没有结果
    expect(Object.keys(sent).sort()).toEqual(["attachments", "userMessageId"]);
    expect(sent.userMessageId.length).toBeGreaterThan(0);
    // 消息落库那一刻扫 content 里的 `__asset_id` 写关系行
    await idle(app, conversationId);
    expect(await app.assets.listAssetIdsByMessage(sent.userMessageId)).toEqual([assetId]);
    expect(await app.assets.countConversations(assetId)).toBe(1);
    expect(await app.assetService.get(assetId)).toBeDefined();

    const page = await callMethod(app, "message.list", { conversationId });
    expect(page.messages.map((message) => message.id)).toContain(sent.userMessageId);
    // 回答在库里（回执不再替它报 id：客户端按 `message.added` 认领那条消息）
    expect(page.messages.map((message) => message.role)).toContain(AgentNSValue.Role.Assistant);
  });

  it("附件结局里的句子按这条连接的语言渲染（D8：库里存码不存句子）", async () => {
    const { app, conversationId } = await makeHarness();
    const assetId = await uploadAsset(app, conversationId);

    const english = await callInLanguage(
      app,
      "conversation.send",
      { conversationId, input: { content: "看图", assetIds: [assetId] } },
      "en",
    );
    await idle(app, conversationId);
    expect(english.attachments).toHaveLength(1);
    const outcome = english.attachments[0];
    // 这个模型读不了图 → 退化成文字，并且带一条原因
    expect(outcome?.deliveredAs).toBe("text_fallback");
    expect(outcome?.problem?.messageKey).toBe("message.imageAsText");
    expect(outcome?.problem?.message).toBe(
      render("en", "message.imageAsText", outcome?.problem?.params ?? {}),
    );

    const chinese = await callInLanguage(
      app,
      "conversation.send",
      { conversationId, input: { content: "再看", assetIds: [assetId] } },
      "zh",
    );
    await idle(app, conversationId);
    expect(chinese.attachments[0]?.problem?.message).toBe(
      render("zh", "message.imageAsText", chinese.attachments[0]?.problem?.params ?? {}),
    );
    // 同一份事实、两种语言：参数不动，句子变了
    expect(chinese.attachments[0]?.problem?.params).toEqual(outcome?.problem?.params);
    expect(chinese.attachments[0]?.problem?.message).not.toBe(outcome?.problem?.message);
  });

  it("它忙着的时候照收：第二句也入队，回执同样是「收下了」", async () => {
    const gate: Deferred<void> = deferred();
    const agent = new FakeAgent([
      { gate: gate.promise, deltas: [{ content: "慢" }] },
      { deltas: [{ content: "回头答你上面那句" }] },
    ]);
    const { app, conversationId } = await makeHarness({ createAgent: async () => agent });

    const first: ConversationSendResult = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "第一句" },
    });
    const second: ConversationSendResult = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "第二句" },
    });

    // 忙不是拒绝的理由：两句都是「收下了」，回执形状一模一样
    expect(second.userMessageId).not.toBe(first.userMessageId);
    expect(Object.keys(second).sort()).toEqual(["attachments", "userMessageId"]);
    // 第二句此刻压在队里（现读的待办）
    expect(app.chatRunner.state(conversationId).inbox.map((item) => item.messageId)).toEqual([
      second.userMessageId,
    ]);

    gate.resolve();
    await idle(app, conversationId);

    // 两句都落了库，id 就是回包里那两个（D5：先画的那条与库里那条是同一条）
    const page = await callMethod(app, "message.list", { conversationId });
    expect(page.messages.map((message) => message.id)).toContain(first.userMessageId);
    expect(page.messages.map((message) => message.id)).toContain(second.userMessageId);
  });

  it("挡着的问题先答再发：投递不是绕道（D23）", async () => {
    const { app, conversationId } = await makeHarness();

    // 摆一个挡着这段对话的问题（交接确认那一类）
    await app.questionService.ask({
      conversationId,
      kind: "confirmation",
      prompt: { messageKey: "question.blocking" },
      options: [{ value: "ok", label: { messageKey: "question.blocking" } }],
    });

    await expect(
      callMethod(app, "conversation.send", { conversationId, input: { content: "想绕过去" } }),
    ).rejects.toSatisfy(
      (error: unknown) => HostError.is(error) && error.code === "question_pending",
    );
    // 那一句没有进队
    expect(app.chatRunner.state(conversationId).inbox).toEqual([]);
  });
});

describe("conversation.abort", () => {
  it("本来就没有 agent 时 signalled 为 false（那不是错误）", async () => {
    const { app, conversationId } = await makeHarness();
    const result: ConversationAbortResult = await callMethod(app, "conversation.abort", {
      conversationId,
    });
    expect(Object.keys(result)).toEqual(["signalled"]);
    expect(result.signalled).toBe(false);
  });

  it("在干着活时打到了 agent 上，并且落在「暂停」格（中断不是杀死）", async () => {
    const gate: Deferred<void> = deferred();
    const agent = new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢慢说" }] }]);
    const { app, conversationId } = await makeHarness({ createAgent: async () => agent });

    await callMethod(app, "conversation.send", { conversationId, input: { content: "第一句" } });
    const aborted: ConversationAbortResult = await callMethod(app, "conversation.abort", {
      conversationId,
      reason: "用户按了中断",
    });

    expect(aborted.signalled).toBe(true);
    expect(agent.abortCalls).toBe(1);
    // 掐完还在「暂停」格：能继续，不是死
    expect(app.chatRunner.state(conversationId).status).toBe("paused");

    gate.resolve();
    await wait(20);
  });
});

describe("conversation.clearInbox", () => {
  it("清掉这段对话的待办，回清了几条（待办归客户端自己管）", async () => {
    const gate: Deferred<void> = deferred();
    const { app, conversationId } = await makeHarness({
      createAgent: async () => new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢" }] }]),
    });

    // 第一句在跑，后两句排在待办里
    await callMethod(app, "conversation.send", { conversationId, input: { content: "第一句" } });
    await callMethod(app, "conversation.send", { conversationId, input: { content: "排一句" } });
    await callMethod(app, "conversation.send", { conversationId, input: { content: "再排一句" } });
    // 「有几条」客户端本来就能从读数的待办那一格里读到
    expect(app.chatRunner.state(conversationId).inbox).toHaveLength(2);

    const cleared = await callMethod(app, "conversation.clearInbox", { conversationId });
    expect(cleared).toEqual({ cleared: 2 });
    expect(app.chatRunner.state(conversationId).inbox).toEqual([]);

    gate.resolve();
    await idle(app, conversationId);
  });

  it("没有 agent 就没有待办可清：回 0，不是错误", async () => {
    const { app, conversationId } = await makeHarness();
    expect(await callMethod(app, "conversation.clearInbox", { conversationId })).toEqual({
      cleared: 0,
    });
  });
});

describe("conversation.delete", () => {
  it("删除走服务层，并让运行时丢掉这段对话的现场（R33）", async () => {
    const { app, conversationId } = await makeHarness();
    const assetId = await uploadAsset(app, conversationId);
    await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "说点话", assetIds: [assetId] },
    });
    await idle(app, conversationId);

    const dryRun: ConversationDeleteResult = await callMethod(app, "conversation.delete", {
      conversationId,
      dryRun: true,
    });
    expect(dryRun.removed).toBe(false);
    expect(dryRun.consequences.messages).toBeGreaterThan(0);

    const removed = await callMethod(app, "conversation.delete", { conversationId });
    expect(removed.removed).toBe(true);
    // 现场没了：这段对话现在是死格
    expect(app.chatRunner.state(conversationId).status).toBe("dead");
    // 素材行随对话一起没了
    expect(await app.assetService.get(assetId)).toBeUndefined();
  });
});

describe("conversation.state：四格 + 待办 + 名册 + 交接态", () => {
  it("形状就是那六样：会话 id、那一格、队里压着什么、子 agent 名册、交接态、读数的时刻", async () => {
    const { app, conversationId } = await makeHarness();

    const { state } = await callMethod(app, "conversation.state", { conversationId });

    expect(Object.keys(state).sort()).toEqual([
      "at",
      "conversationId",
      "handoff",
      "inbox",
      "status",
      "subAgents",
    ]);
    expect(state.conversationId).toBe(conversationId);
    // 一次都没发过话：没有 agent 对象，也没有排着的投递 → 死
    expect(state.status).toBe("dead");
    expect(state.inbox).toEqual([]);
    // 死了就没有名册（子 agent 的话只在它自己那个对象里），也没在交接
    expect(state.subAgents).toEqual([]);
    expect(state.handoff).toBeNull();
    expect(Number.isNaN(Date.parse(state.at))).toBe(false);
  });

  it("发出去之后报忙，闲下来之后报闲", async () => {
    const gate: Deferred<void> = deferred();
    const { app, conversationId } = await makeHarness({
      createAgent: async () => new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢" }] }]),
    });

    await callMethod(app, "conversation.send", { conversationId, input: { content: "慢慢说" } });
    const during = await callMethod(app, "conversation.state", { conversationId });
    expect(during.state.status).toBe("busy");

    gate.resolve();
    await idle(app, conversationId);
    const after = await callMethod(app, "conversation.state", { conversationId });
    expect(after.state.status).toBe("idle");
    expect(after.state.inbox).toEqual([]);
  });

  it("会话不存在（也没有草稿）→ not_found", async () => {
    const { app } = await makeHarness();
    await expect(
      callMethod(app, "conversation.state", { conversationId: "没有这段" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("conversation.list：侧栏那一格（F-I3）", () => {
  it("忙 / 闲与压着几条都是现读的", async () => {
    const gate: Deferred<void> = deferred();
    const { app, conversationId, workspaceId } = await makeHarness({
      createAgent: async () => new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢" }] }]),
    });

    await callMethod(app, "conversation.send", { conversationId, input: { content: "慢慢说" } });
    await callMethod(app, "conversation.send", { conversationId, input: { content: "排一句" } });

    const during = await callMethod(app, "conversation.list", { workspaceId });
    const entry = during.conversations.find((item) => item.id === conversationId);
    expect(entry?.status).toBe("busy");
    expect(entry?.inboxPending).toBe(1);

    gate.resolve();
    await idle(app, conversationId);

    const after = await callMethod(app, "conversation.list", { workspaceId });
    const settled = after.conversations.find((item) => item.id === conversationId);
    expect(settled?.status).toBe("idle");
    expect(settled?.inboxPending).toBe(0);
  });
});
