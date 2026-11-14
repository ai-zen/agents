/**
 * `conversation.*` 的验收：受理、素材挂接、按连接语言重渲染、忙即拒、中止、删除时的现场丢弃。
 *
 * 一轮里「真正属于 core 的那部分」在用例里照原样跑（`FakeAgent` 走同一个 `applyChunk`），
 * 只有「流从哪来」换成了脚本 —— 所以这里验的是接线，不是模型。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
    expect(sent.assistantMessageId.length).toBeGreaterThan(0);
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

  it("同一段对话正在跑一轮时，第二次受理被拒（D14：忙就拒）", async () => {
    const gate: Deferred<void> = deferred();
    const { app, conversationId } = await makeHarness({
      createAgent: async () => new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢" }] }]),
    });

    const first = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "第一句" },
    });
    expect(first.userMessageId.length).toBeGreaterThan(0);

    await expect(
      callMethod(app, "conversation.send", { conversationId, input: { content: "第二句" } }),
    ).rejects.toSatisfy((error: unknown) => HostError.is(error) && error.code === "busy");

    gate.resolve();
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
