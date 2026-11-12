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

import { createServer } from "../app.js";
import type { ServerApp } from "../app.js";
import { render } from "../i18n/index.js";
import type { ConnectionInfo } from "../net/index.js";
import { makeTempDir, wait, type TempDir } from "../net/TestSupport.js";
import type { AgentFactory } from "../runtime/index.js";
import { deferred, FakeAgent, type Deferred } from "../runtime/TestSupport.js";
import { ServerError } from "../wire/index.js";
import { STATUS_BLOCK_IDS } from "../wire/index.js";
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
const apps: ServerApp[] = [];

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
  app: ServerApp;
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

  const app = await createServer({
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
async function seedConversation(app: ServerApp, workspaceId: string): Promise<ConversationView> {
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
  app: ServerApp,
  method: M,
  params: MethodParams<M> = {} as MethodParams<M>,
): Promise<MethodResult<M>> {
  const handler = app.handlers[method];
  if (!handler) throw new Error(`方法未注册：${method}`);
  return await handler({ method, params, connection: CONNECTION });
}

/** 按指定语言调一个方法（`attachments[].problem` 的重渲染要换语言才看得出来） */
async function callInLanguage<M extends MethodName>(
  app: ServerApp,
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
async function uploadAsset(app: ServerApp, conversationId: string): Promise<string> {
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
async function settle(app: ServerApp, conversationId: string): Promise<void> {
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
  it("受理即回两个 id，并把素材挂到落库后的那条用户消息上（L6 / D5）", async () => {
    const { app, conversationId } = await makeHarness();
    const assetId = await uploadAsset(app, conversationId);

    const sent = await callMethod(app, "conversation.send", {
      conversationId,
      input: { content: "看图", assetIds: [assetId] },
    });

    expect(sent.userMessageId.length).toBeGreaterThan(0);
    expect(sent.assistantMessageId.length).toBeGreaterThan(0);
    // 上传早于消息落库：受理之后素材行挂到用户消息上
    const record = await app.assetService.get(assetId);
    expect(record?.messageId).toBe(sent.userMessageId);

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
    ).rejects.toSatisfy((error: unknown) => ServerError.is(error) && error.code === "busy");

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

describe("conversation.state 的状态栏块（PRD F-I6 / 裁定 R65）", () => {
  it("八块按 STATUS_BLOCK_IDS 的顺序给出，事实都来自已有字段", async () => {
    const { app, conversationId, workspaceDir } = await makeHarness();

    const { state } = await callMethod(app, "conversation.state", { conversationId });
    expect(state.statusBlocks.map((block) => block.id)).toEqual([...STATUS_BLOCK_IDS]);

    const view = (await callMethod(app, "conversation.get", { conversationId })).conversation;
    const agent = state.statusBlocks.find((block) => block.id === "agent");
    // 身份来自对话自己（创建时定死，L7）；名字与可用性来自助手定义那一层（`AgentService.describe`）
    expect(agent?.id === "agent" && agent.facts.agentId).toBe(view.agentId);
    expect(agent?.id === "agent" && agent.facts.name).toBe("Test Assistant");
    expect(agent?.id === "agent" && agent.facts.available).toBe(true);

    const model = state.statusBlocks.find((block) => block.id === "model");
    expect(model?.id === "model" && model.facts.modelId).toBe(view.model.modelId);
    // 没换过模型：它来自助手定义
    expect(model?.id === "model" && model.facts.source).toBe("agent");

    const thinking = state.statusBlocks.find((block) => block.id === "thinking");
    expect(thinking?.id === "thinking" && thinking.facts).toEqual(view.thinking);

    const context = state.statusBlocks.find((block) => block.id === "context");
    expect(context?.id === "context" && context.facts).toEqual(state.context);

    const usage = state.statusBlocks.find((block) => block.id === "usage");
    expect(usage?.id === "usage" && usage.facts).toEqual(state.usage);

    // 目录事实来自这段对话所属的项目（目录存在为真：临时目录刚建出来）
    const cwd = state.statusBlocks.find((block) => block.id === "cwd");
    expect(cwd?.id === "cwd" && cwd.facts.cwd).toBe(workspaceDir.path);
    expect(cwd?.id === "cwd" && cwd.facts.exists).toBe(true);

    const tools = state.statusBlocks.find((block) => block.id === "tools");
    expect(tools?.id === "tools" && tools.facts.running).toEqual([]);

    const subagents = state.statusBlocks.find((block) => block.id === "subagents");
    expect(subagents?.id === "subagents" && subagents.facts.items).toEqual(state.run.subagents);

    // 标签按连接语言给（D8）
    const labels = state.statusBlocks.map((block) => block.label.message);
    expect(labels[0]).toBe(render("en", "label.agent"));
  });

  it("助手被删之后，助手块回 null（名字与可用性都没有可报的事实）", async () => {
    const { app, conversationId } = await makeHarness();

    const before = await callMethod(app, "conversation.state", { conversationId });
    const beforeAgent = before.state.statusBlocks.find((block) => block.id === "agent");
    expect(beforeAgent?.id === "agent" && beforeAgent.facts.name).toBe("Test Assistant");

    await app.agentService.delete({ agentId: "default" });

    const after = await callMethod(app, "conversation.state", { conversationId });
    const afterAgent = after.state.statusBlocks.find((block) => block.id === "agent");
    // 对话仍记着那个 id（L7），但定义已经没了：不猜名字，也不编一个可用性
    expect(afterAgent?.id === "agent" && afterAgent.facts.agentId).toBe("default");
    expect(afterAgent?.id === "agent" && afterAgent.facts.name).toBeNull();
    expect(afterAgent?.id === "agent" && afterAgent.facts.available).toBeNull();
  });

  it("流式中 tools 块跟着 run.generation 里还在跑的工具变", async () => {
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
    const toolsDuring = during.state.statusBlocks.find((block) => block.id === "tools");
    expect(toolsDuring?.id === "tools" && toolsDuring.facts.running.map((tool) => tool.toolCall.function?.name)).toEqual(["read"]);
    // 六态的事实只有一处（run.generation），块里装的就是它
    expect(during.state.run.generation?.phase).toBe("awaiting_tools");

    toolGate.resolve();
    await settle(app, conversationId);

    const after = await callMethod(app, "conversation.state", { conversationId });
    const toolsAfter = after.state.statusBlocks.find((block) => block.id === "tools");
    expect(toolsAfter?.id === "tools" && toolsAfter.facts.running).toEqual([]);
  });
});
