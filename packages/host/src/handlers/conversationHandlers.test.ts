/**
 * `conversation.*` 的验收：受理、素材挂接、按连接语言重渲染、跑中发送排进 inbox、中止、
 * 删除时的现场丢弃。
 *
 * 一轮里「真正属于 core 的那部分」在用例里照原样跑（`FakeAgent` 走同一个 `applyChunk`），
 * 只有「流从哪来」换成了脚本 —— 所以这里验的是接线，不是模型。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentNS as AgentNSValue } from "@ai-zen/agents-core";
import type { AgentNS } from "@ai-zen/agents-core";

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
  RunState,
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

/** 一轮：先想一句，再吐一句正文 */
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
 * 这里的用例要看的是别的东西（列表、搜索结果、项目删除），所以直接把草稿落成真行。
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

/** 等这一轮结算（`ChatRunner` 结算后就把这一轮的现场扔掉） */
async function settle(app: HostApp, conversationId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.chatRunner.turn(conversationId) === undefined) return;
    await wait(10);
  }
  throw new Error("这一轮没有结算");
}

/**
 * 等这一轮跑到某个形状（用例要在「跑到一半」那一瞬读现场）。
 *
 * 不能用固定次数的 `wait`：轮次由后台推进，具体几个 tick 到那一步是实现的细节。
 */
async function waitForRun(
  app: HostApp,
  conversationId: string,
  predicate: (run: RunState) => boolean,
): Promise<RunState> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = app.chatRunner.turn(conversationId)?.runState();
    if (run && predicate(run)) return run;
    await wait(10);
  }
  throw new Error("这一轮没有进到用例等的那个形状");
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop("requested").catch(() => undefined);
  for (const temp of temps.splice(0)) await temp.remove();
});

describe("conversation.send", () => {
  it("受理即回两个 id，并把素材记成用户消息的引用关系（L6 / D5）", async () => {
    const { app, conversationId } = await makeHarness();
    const assetId = await uploadAsset(app, conversationId);

    const sent = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "看图", assetIds: [assetId] },
    });

    expect(sent.userMessageId.length).toBeGreaterThan(0);
    // 空闲时受理的是一轮新的：助手消息 id 必须在（`null` 只属于排队受理，D14）
    expect(typeof sent.assistantMessageId).toBe("string");
    expect(sent.assistantMessageId?.length).toBeGreaterThan(0);
    // 消息落库那一刻扫 content 里的 `__asset_id` 写关系行
    expect(await app.assets.listAssetIdsByMessage(sent.userMessageId)).toEqual([assetId]);
    expect(await app.assets.countConversations(assetId)).toBe(1);
    // 素材行本身不记归属（一张图可以被好几段对话引用）
    expect(await app.assetService.get(assetId)).toBeDefined();

    await settle(app, conversationId);
    const page = await callMethod(app, "message.list", { conversationId });
    expect(page.messages.map((message) => message.id)).toContain(sent.userMessageId);
    expect(page.messages.map((message) => message.id)).toContain(sent.assistantMessageId);
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
    await settle(app, conversationId);
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
    await settle(app, conversationId);
    expect(chinese.attachments[0]?.problem?.message).toBe(
      render("zh", "message.imageAsText", chinese.attachments[0]?.problem?.params ?? {}),
    );
    // 同一份事实、两种语言：参数不动，句子变了
    expect(chinese.attachments[0]?.problem?.params).toEqual(outcome?.problem?.params);
    expect(chinese.attachments[0]?.problem?.message).not.toBe(outcome?.problem?.message);
  });

  it("跑的时侯第二句不再被拒：它排进那一轮的 inbox，回包说 queued（D14）", async () => {
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
    expect(first.userMessageId.length).toBeGreaterThan(0);

    const second: ConversationSendResult = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "第二句" },
    });

    // 排队受理：没有属于它的助手消息（流还是那一轮原来那条），并且明说了 queued
    expect(second.queued).toBe(true);
    expect(second.assistantMessageId).toBeNull();
    expect(second.userMessageId.length).toBeGreaterThan(0);
    expect(second.userMessageId).not.toBe(first.userMessageId);
    // 条目真的进了这一轮 agent 的 inbox（不是只回了一句 queued）
    expect(agent.inbox.map((entry) => entry.messageId)).toEqual([second.userMessageId]);

    gate.resolve();
    await settle(app, conversationId);

    // 两句都落了库，id 就是回包里那两个（D5：先画的那条与库里那条是同一条）
    const page = await callMethod(app, "message.list", { conversationId });
    expect(page.messages.map((message) => message.id)).toContain(first.userMessageId);
    expect(page.messages.map((message) => message.id)).toContain(second.userMessageId);
  });

  it("回包的 userMessageId 就是落地那条消息的 id（D5：不会画两遍）", async () => {
    const gate: Deferred<void> = deferred();
    const agent = new FakeAgent([
      { gate: gate.promise, deltas: [{ content: "先答" }] },
      { deltas: [{ content: "再答" }] },
    ]);
    const { app, conversationId } = await makeHarness({ createAgent: async () => agent });

    await callMethod(app, "conversation.send", { conversationId, input: { content: "第一句" } });
    const queued: ConversationSendResult = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "排队的那句" },
    });

    gate.resolve();
    await settle(app, conversationId);

    // 消息列表里那一条：id 与内容对得上回包（落地时没有另生成一个 id）
    const page = await callMethod(app, "message.list", { conversationId });
    const landed = page.messages.find((message) => message.id === queued.userMessageId);
    expect(landed).toBeDefined();
    expect(landed?.role).toBe(AgentNSValue.Role.User);
    expect(landed?.content).toBe("排队的那句");
    // 也没有第二条带着同样内容的用户消息（那就是「同一条显示两遍」的形状）
    const same = page.messages.filter(
      (message) => message.role === AgentNSValue.Role.User && message.content === "排队的那句",
    );
    expect(same).toHaveLength(1);
  });

  it("库里的顺序（seq）：排队那句排在它引出的回答之前，读回来是「用户插一句 → 助手回它」", async () => {
    const firstGate: Deferred<void> = deferred();
    const replyGate: Deferred<void> = deferred();
    const agent = new FakeAgent([
      { gate: firstGate.promise, deltas: [{ content: "先答" }] },
      { gate: replyGate.promise, deltas: [{ content: "回你插的那句" }] },
    ]);
    const { app, conversationId } = await makeHarness({ createAgent: async () => agent });

    const first: ConversationSendResult = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "第一句" },
    });

    // 先让边流边写的节流点（200ms）过去：之后每一条助手消息都是**当片就写**，
    // 「谁先落库」便不再取决于节流巧合，用例才真的钉得住顺序（不是赌时间）
    await wait(250);

    const queued: ConversationSendResult = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "跑着的时候插一句" },
    });
    expect(queued.queued).toBe(true);

    // 第一轮吐正文（当片落库）→ 轮末那句排队的落地 → 第二轮起来卡在 replyGate
    firstGate.resolve();
    await waitForRun(app, conversationId, (run) => run.inbox.length === 0);
    // 再让一次节流点过去：回答的首片也要「当片落库」，否则它可能落在收尾那一批里（顺序就被掩盖了）
    await wait(250);

    replyGate.resolve();
    await settle(app, conversationId);

    // 真库读回来的一页（`message.list` 按 `seq` 升序）：排队那句必须排在它引出的回答之前。
    // 它若等到收尾才第一次写，真仓储会给它一个更大的 `seq`，转录就成了
    // 「助手说完 → 助手又说 → 用户冒最后一句」，而且最后那句永远没有回答。
    const page = await callMethod(app, "message.list", { conversationId });
    expect(page.messages.map((message) => [message.role, message.content])).toEqual([
      [AgentNSValue.Role.User, "第一句"],
      [AgentNSValue.Role.Assistant, "先答"],
      [AgentNSValue.Role.User, "跑着的时候插一句"],
      [AgentNSValue.Role.Assistant, "回你插的那句"],
    ]);
    // 落地那条就是回包里那个 id，且只有一条（写两次是覆盖，不是两行）
    expect(
      page.messages.filter((message) => message.id === queued.userMessageId),
    ).toHaveLength(1);
    expect(page.messages.some((message) => message.id === first.userMessageId)).toBe(true);
  });

  it("run.state 的 inbox：入队后 1 条、落地后清空、空闲时为空", async () => {
    const firstGate: Deferred<void> = deferred();
    const secondGate: Deferred<void> = deferred();
    const agent = new FakeAgent([
      { gate: firstGate.promise, deltas: [{ content: "先答" }] },
      // 第二轮卡住，是为了能在「那一条已经落地、这一轮还在跑」那一刻看到 0
      { gate: secondGate.promise, deltas: [{ content: "再答" }] },
    ]);
    const { app, conversationId } = await makeHarness({ createAgent: async () => agent });

    await callMethod(app, "conversation.send", { conversationId, input: { content: "第一句" } });
    // 没排队时就是在跑，也是空（不是「未知」也不是 1 条）
    expect((await callMethod(app, "conversation.state", { conversationId })).state.run.inbox).toEqual([]);

    const queued: ConversationSendResult = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "排队的那句" },
    });
    expect(queued.queued).toBe(true);
    // 入队之后：“已排队 1 条”
    const pending = await callMethod(app, "conversation.state", { conversationId });
    expect(pending.state.run.inbox).toHaveLength(1);
    expect(pending.state.run.status).toBe("running");

    // 放行第一轮 → 那一条在轮末落地 → 第二轮卡着，现场里应当归 0
    firstGate.resolve();
    const afterLanded = await waitForRun(
      app,
      conversationId,
      (run) => run.inbox.length === 0 && run.status === "running",
    );
    expect(afterLanded.inbox).toEqual([]);
    // 而且它真的落地了（不是被当成“已消费”而丢掉）
    expect(agent.messages.map((message) => message.id)).toContain(queued.userMessageId);

    secondGate.resolve();
    await settle(app, conversationId);

    // 空闲：恒为空
    const idle = await callMethod(app, "conversation.state", { conversationId });
    expect(idle.state.run.status).toBe("idle");
    expect(idle.state.run.inbox).toEqual([]);
  });

  it("abort 不丢排队条目：回包的 run 里 inbox 保持 1 条，那一句仍不落库", async () => {
    const gate: Deferred<void> = deferred();
    const agent = new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢慢说" }] }]);
    const { app, conversationId } = await makeHarness({ createAgent: async () => agent });

    await callMethod(app, "conversation.send", { conversationId, input: { content: "第一句" } });
    const queued: ConversationSendResult = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "还没发出去的那句" },
    });
    expect(queued.queued).toBe(true);

    const aborted: ConversationAbortResult = await callMethod(app, "conversation.abort", {
      conversationId,
    });
    expect(aborted.aborted).toBe(true);
    // 口径已变（core 的 `abort()` 不再清空 inbox）：按停只停这一段，排队的那句仍在队列里，
    // 所以回包里的排队条目还是 1 条 —— 等下一次外部驱动才会发出。
    expect(aborted.run.inbox).toHaveLength(1);

    gate.resolve();
    await settle(app, conversationId);

    // 那一句从没落过库
    const page = await callMethod(app, "message.list", { conversationId });
    expect(page.messages.map((message) => message.id)).not.toContain(queued.userMessageId);
  });

  it("排队那一句的附件照旧过线：结局照常回，落地时记下素材关系行", async () => {
    const gate: Deferred<void> = deferred();
    const agent = new FakeAgent([
      { gate: gate.promise, deltas: [{ content: "先看一眼" }] },
      { deltas: [{ content: "你说的那张我也看了" }] },
    ]);
    const { app, conversationId } = await makeHarness({ createAgent: async () => agent });
    const assetId = await uploadAsset(app, conversationId);

    await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "第一句", assetIds: [assetId] },
    });
    const queued: ConversationSendResult = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "再看这张", assetIds: [assetId] },
    });

    // 排队不等于「附件被静默丢掉」：逐条结局照常回（这个模型读不了图 → 退化成文字）
    expect(queued.queued).toBe(true);
    expect(queued.attachments).toHaveLength(1);
    expect(queued.attachments[0]?.assetId).toBe(assetId);
    expect(queued.attachments[0]?.deliveredAs).toBe("text_fallback");

    gate.resolve();
    await settle(app, conversationId);

    // 落地之后，关系行也记上了（`conversation_assets` 只能等消息行真的写下去再记）
    expect(await app.assets.listAssetIdsByMessage(queued.userMessageId)).toEqual([assetId]);
    const page = await callMethod(app, "message.list", { conversationId });
    expect(page.messages.map((message) => message.id)).toContain(queued.userMessageId);
  });

  it("挡着的问题依旧先答再发：排队不是绕道（D23）", async () => {
    const gate: Deferred<void> = deferred();
    const agent = new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢" }] }]);
    const { app, conversationId } = await makeHarness({ createAgent: async () => agent });

    await callMethod(app, "conversation.send", { conversationId, input: { content: "第一句" } });

    // 摆一个挡着这段对话的问题（交接确认那一类）
    await app.questionService.ask({
      conversationId,
      kind: "confirmation",
      prompt: { messageKey: "question.blocking" },
      options: [{ value: "ok", label: { messageKey: "question.blocking" } }],
    });

    // 跑中发送同样要过这道闸：入队不能成为绕着闸门走的通道
    await expect(
      callMethod(app, "conversation.send", { conversationId, input: { content: "想绕过去" } }),
    ).rejects.toSatisfy(
      (error: unknown) => HostError.is(error) && error.code === "question_pending",
    );
    // 那一句没有进 inbox
    expect(agent.inbox).toHaveLength(0);

    gate.resolve();
    await settle(app, conversationId);
  });

  it("没在跑的时候受理一轮：回包里不带 queued（老路径不变）", async () => {
    const { app, conversationId } = await makeHarness();

    const sent: ConversationSendResult = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "就一句" },
    });

    expect(sent.queued).toBeUndefined();
    expect(typeof sent.assistantMessageId).toBe("string");
    await settle(app, conversationId);
  });
});

describe("conversation.abort / conversation.delete", () => {
  it("本来就没在跑时 aborted 为 false，并回一份空闲现场", async () => {
    const { app, conversationId } = await makeHarness();
    const result: ConversationAbortResult = await callMethod(app, "conversation.abort", {
      conversationId,
    });
    expect(result.aborted).toBe(false);
    expect(result.run.status).toBe("idle");
    expect(result.run.conversationId).toBe(conversationId);
  });

  it("删除走服务层，并让运行时丢掉这一轮的现场（R33）", async () => {
    const { app, conversationId } = await makeHarness();
    const assetId = await uploadAsset(app, conversationId);
    const sent: ConversationSendResult = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "说点话", assetIds: [assetId] },
    });
    expect(sent.acceptedAt.length).toBeGreaterThan(0);

    const dryRun: ConversationDeleteResult = await callMethod(app, "conversation.delete", {
      conversationId,
      dryRun: true,
    });
    expect(dryRun.removed).toBe(false);
    expect(dryRun.consequences.messages).toBeGreaterThan(0);

    await settle(app, conversationId);
    const removed = await callMethod(app, "conversation.delete", { conversationId });
    expect(removed.removed).toBe(true);
    expect(app.chatRunner.turn(conversationId)).toBeUndefined();
    // 素材行随对话一起没了
    expect(await app.assetService.get(assetId)).toBeUndefined();
  });
});

describe("conversation.state / conversation.get：客户端拼状态栏要的那几处事实（PRD F-I6）", () => {
  it("每一处事实都在契约里各自有一份，客户端不必再被喂一份拼好的副本", async () => {
    const { app, conversationId, workspaceDir } = await makeHarness();

    const { state } = await callMethod(app, "conversation.state", { conversationId });
    const { conversation: view } = await callMethod(app, "conversation.get", { conversationId });

    // 助手：身份来自对话自己（创建时定死，L7）；名字与可用性来自助手定义那一层
    expect(view.agent).toEqual({ agentId: "default", name: "Test Assistant", available: true });
    expect(view.agent.agentId).toBe(view.agentId);

    // 模型：没换过，来源是助手定义；名字与 id 都在视图这一份里
    expect(view.model.modelId).toBe("test-model");
    expect(view.model.name).toBe("Test Model");
    expect(view.model.source).toBe("agent");

    // 思考档：视图与现场给的是同一份
    expect(view.thinking).toEqual(state.thinking);
    expect(state.thinking).toEqual(view.thinking);

    // 目录事实来自这段对话所属的项目（临时目录刚建出来，存在为真）
    expect(view.folder).toEqual({ cwd: workspaceDir.path, exists: true });

    // 上下文与用量各自一份，谁都不需要从别处推
    expect(state.context.handoffThreshold).toBeGreaterThan(0);
    expect(state.context.usage.prompt_tokens).toBeGreaterThanOrEqual(0);
    expect(state.usage.total.total_tokens).toBeGreaterThanOrEqual(0);

    // 状态栏的块不再是契约面：拼哪几块、按什么顺序摆，归界面（PRD F-I6）
    expect("statusBlocks" in state).toBe(false);
  });

  it("助手被删之后，视图里名字与可用性都是 null（不猜、也不编）", async () => {
    const { app, conversationId } = await makeHarness();

    const before = await callMethod(app, "conversation.get", { conversationId });
    expect(before.conversation.agent.name).toBe("Test Assistant");

    await app.agentService.delete({ agentId: "default" });

    const after = await callMethod(app, "conversation.get", { conversationId });
    // 对话仍记着那个 id（L7），但定义已经没了
    expect(after.conversation.agent).toEqual({ agentId: "default", name: null, available: null });
  });

  it("流式中「还在跑的工具」就在 run.generation 里，客户端照它拼工具块", async () => {
    const toolGate: Deferred<void> = deferred();
    const { app, conversationId } = await makeHarness({
      createAgent: async () =>
        new FakeAgent([
          { deltas: [{ content: "我查一下。" }], toolCalls: [{ id: "call-1", name: "read", arguments: "{}" }], toolGate: toolGate.promise },
          { deltas: [{ content: "查到了。" }] },
        ]),
    });

    await callMethod(app, "conversation.send", { conversationId, input: { content: "看看文件" } });

    // 等这一轮进到「等工具」
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const turn = app.chatRunner.turn(conversationId);
      if (turn?.runState().generation?.phase === "awaiting_tools") break;
      await wait(10);
    }

    const during = await callMethod(app, "conversation.state", { conversationId });
    const generation = during.state.run.generation;
    expect(generation?.phase).toBe("awaiting_tools");
    // 「还在跑的工具」只在等工具那一态才有，取法就这一处（L8）
    const running = generation?.phase === "awaiting_tools" ? generation.runningTools : [];
    expect(running.map((tool) => tool.toolCall.function?.name)).toEqual(["read"]);

    toolGate.resolve();
    await settle(app, conversationId);

    const after = await callMethod(app, "conversation.state", { conversationId });
    expect(after.state.run.generation).toBeNull();
  });
});

describe("conversation.state 的 includeMessages（要不要连消息一起回）", () => {
  it("不传就不带 messages：只要现场的调用方不为消息付费", async () => {
    const { app, conversationId } = await makeHarness();
    await callMethod(app, "conversation.send", { conversationId, input: { content: "说一句" } });
    await settle(app, conversationId);

    const result = await callMethod(app, "conversation.state", { conversationId });
    // 键不出现，而不是空数组 —— 空数组的意思是「这段对话里没有消息」
    expect("messages" in result).toBe(false);
    // 现场照旧完整：用量、上下文都在（只是没有消息本体）
    expect(result.state.usage.total).toBeDefined();
    expect(result.state.context.handoffThreshold).toBeGreaterThanOrEqual(0);
  });

  it("要了就与 message.list 逐条相同：同一份读取，不是又读一遍", async () => {
    const { app, conversationId } = await makeHarness();
    const sent: ConversationSendResult = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "说一句" },
    });
    await settle(app, conversationId);

    const both = await callMethod(app, "conversation.state", {
      conversationId,
      includeMessages: true,
    });
    const listed = await callMethod(app, "message.list", { conversationId });

    expect(both.messages).toEqual(listed.messages);
    expect(both.messages?.map((message) => message.id)).toEqual([
      sent.userMessageId,
      sent.assistantMessageId,
    ]);
  });
});

/** 一轮：先委派一次子 Agent（工具调用 `call-9` / 工具名 `researcher`），拿到结果后再吐一句 */
function delegatingRound(options: { failed?: boolean } = {}): FakeAgent {
  const inner: AgentNS.Message[] = [
    {
      id: "inner-u",
      role: AgentNSValue.Role.User,
      status: AgentNSValue.MessageStatus.Completed,
      content: "查一下这个问题的资料",
    },
    {
      id: "inner-a",
      role: AgentNSValue.Role.Assistant,
      status:
        options.failed === true
          ? AgentNSValue.MessageStatus.Error
          : AgentNSValue.MessageStatus.Completed,
      content: options.failed === true ? "查不下去了" : "查到了",
    },
  ];
  return new FakeAgent([
    {
      deltas: [{ content: "我派一个子 Agent 去查。" }],
      toolCalls: [{ id: "call-9", name: "researcher", arguments: "{}" }],
      subAgent: { name: "researcher", messages: inner },
      // core 在子 Agent 收尾时把这次委派（含孙级）的用量钉在工具结果消息上
      toolSubAgentUsage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    },
    { deltas: [{ content: "它查完了。" }] },
  ]);
}

/**
 * 一段对话重复打开时，库里那批消息能不能把子 Agent 捞回来（F-I7）。
 *
 * 这一组验的是「现场快照的两条路都贴合」：`conversation.state` 与 `conversation.abort` 的
 * 回包里都带 `run`，两处都该看得见历次委派。
 */
describe("空闲现场里的子 Agent（F-I7：重开一段对话，页签不该空）", () => {
  it("跑过子 Agent 的对话重开时，subagents 从库里捞回来（名字 / 状态 / 用量 / 条数）", async () => {
    const { app, conversationId } = await makeHarness({
      createAgent: async () => delegatingRound(),
    });
    await callMethod(app, "conversation.send", { conversationId, input: { content: "派个活" } });
    await settle(app, conversationId);

    const { state } = await callMethod(app, "conversation.state", { conversationId });
    expect(state.run.status).toBe("idle");
    expect(state.run.subagents).toHaveLength(1);

    const snapshot = state.run.subagents[0]!;
    // 关联就是那次委派的工具调用 id（子 Agent 的消息行上 `parentToolCallId` 记着它）
    expect(snapshot.toolCallId).toBe("call-9");
    // 名字只能来自主线上那次工具调用的 `function.name`
    expect(snapshot.name).toBe("researcher");
    // 父工具结果写成了完成 → 这次委派跑完了
    expect(snapshot.status).toBe("done");
    // 条数与库里那段话一致（`message.list` 带 `toolCallId` 读回来的就是它）
    const delegated = await callMethod(app, "message.list", {
      conversationId,
      toolCallId: "call-9",
    });
    expect(snapshot.messageCount).toBe(delegated.messages.length);
    expect(snapshot.messageCount).toBe(2);
    // 用量是 core 钉在父工具结果消息上的那一份（含孙级）
    expect(snapshot.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    // 开始时刻是子 Agent 第一条消息落库的时刻（库里唯一的「开始」事实）
    expect(Number.isNaN(Date.parse(snapshot.startedAt))).toBe(false);
    // 推不出来的两格宁可空着：库里没有「委派结束」的时刻，也没给人话原因
    expect(snapshot.finishedAt).toBeNull();
    expect(snapshot.problem).toBeNull();
  });

  it("从没委派过的对话：subagents 仍是空数组（不凭空造一个）", async () => {
    const { app, conversationId } = await makeHarness();
    await callMethod(app, "conversation.send", { conversationId, input: { content: "聊一句" } });
    await settle(app, conversationId);

    const { state } = await callMethod(app, "conversation.state", { conversationId });
    expect(state.run.subagents).toEqual([]);
  });

  it("子 Agent 自己出过错的那次委派，空闲时推成 error（不瞎说成 done）", async () => {
    const { app, conversationId } = await makeHarness({
      createAgent: async () => delegatingRound({ failed: true }),
    });
    await callMethod(app, "conversation.send", { conversationId, input: { content: "派个活" } });
    await settle(app, conversationId);

    const { state } = await callMethod(app, "conversation.state", { conversationId });
    const snapshot = state.run.subagents[0]!;
    expect(snapshot.status).toBe("error");
    // 状态是「出错」，但原因不在库里能拼成一句人话的那一层：不说，不编
    expect(snapshot.problem).toBeNull();
  });

  it("abort 回包里的空闲现场也带着子 Agent（两条路径同一份事实）", async () => {
    const { app, conversationId } = await makeHarness({
      createAgent: async () => delegatingRound(),
    });
    await callMethod(app, "conversation.send", { conversationId, input: { content: "派个活" } });
    await settle(app, conversationId);

    const result = await callMethod(app, "conversation.abort", { conversationId });
    expect(result.aborted).toBe(false);
    expect(result.run.status).toBe("idle");
    expect(result.run.subagents.map((item) => item.toolCallId)).toEqual(["call-9"]);
  });
});

/**
 * `conversation.list` 的「这段在跑」那一格（F-I3：CLI 的活跃会话列表按它排）。
 *
 * 事实只有一个来源：`RunRegistry`。这里经真接线（`app.ts` → `ConversationRuntimePort`）验，
 * 不是验一个替身。
 */
describe("conversation.list 带「在跑」那一格（F-I3）", () => {
  it("在跑的对话条目带 run（status + startedAt），跑完就回到 null", async () => {
    const gate: Deferred<void> = deferred();
    const { app, conversationId, workspaceId } = await makeHarness({
      createAgent: async () => new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢" }] }]),
    });
    await callMethod(app, "conversation.send", { conversationId, input: { content: "慢慢说" } });

    const during = await callMethod(app, "conversation.list", { workspaceId });
    const running = during.conversations.find((item) => item.id === conversationId);
    expect(running?.run?.status).toBe("running");
    // 开始时刻就是注册表登记这一轮的时刻（不是拉列表的时刻，列表也不会在现场里算时间）
    expect(running?.run?.startedAt).toBe(app.runRegistry.summary(conversationId)?.startedAt);
    // 既有字段的含义不变：`running` 与 `run` 说的是同一件事
    expect(running?.running).toBe(true);

    gate.resolve();
    await settle(app, conversationId);

    const after = await callMethod(app, "conversation.list", { workspaceId });
    const idle = after.conversations.find((item) => item.id === conversationId);
    expect(idle?.run).toBeNull();
    expect(idle?.running).toBe(false);
  });

  it("空闲的对话是 null：不是缺这一格，也不是 status idle", async () => {
    const { app, workspaceId } = await makeHarness();

    const listed = await callMethod(app, "conversation.list", { workspaceId });
    expect(listed.conversations).toHaveLength(1);
    const entry = listed.conversations[0]!;
    // 键在（客户端不用分辨「没这个字段」与「没在跑」），值是 null
    expect("run" in entry).toBe(true);
    expect(entry.run).toBeNull();
  });
});
