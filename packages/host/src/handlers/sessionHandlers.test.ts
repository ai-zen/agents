/**
 * `session.*` 的验收：投递、素材挂接、按连接语言重渲染、中止、四件事与待办、删除时的现场丢弃。
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

import { AgentNS as AgentNSValue, formatContent } from "@ai-zen/agents-core";

import { createHost } from "../app.js";
import type { HostApp } from "../app.js";
import { render } from "../i18n/index.js";
import type { ConnectionInfo } from "../net/index.js";
import { makeTempDir, wait, type TempDir } from "../net/TestSupport.js";
import type { AgentFactory } from "../runtime/index.js";
import { deferred, FakeAgent, type Deferred } from "../runtime/TestSupport.js";
import { HostError, localAssetIdOf } from "../wire/index.js";
import type {
  SessionAbortResult,
  SessionDeleteResult,
  SessionKillResult,
  SessionPauseResult,
  SessionResumeResult,
  SessionSendResult,
  SessionView,
  LocalMessageContentSection,
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
      // 第二个模型：只是为了验「换模型会重建驱动者、改阈值不会」这条对照
      {
        id: "other-model",
        name: "Other Model",
        endpointId: "fake",
        tokenThresholds: { handoff: 1200, guard: 1800 },
        // 带上出厂那张档位表：验「换思考档位」那一手时它要有可调的档
        reasoningPreset: "openai",
        custom: true,
      },
      // 能看图的模型：附件会内联成 `image_url`（data URL），于是「厂商产物进不进库」才有东西可验
      {
        id: "vision-model",
        name: "Vision Model",
        endpointId: "fake",
        vision: true,
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
  dataRoot: TempDir;
  workspaceId: string;
  sessionId: string;
  workspaceDir: TempDir;
}

/** 起一个（真 SQLite、真组装的）宿主；同一个数据根再起一次就是「重启」 */
async function startHost(
  dataRoot: TempDir,
  createAgent?: AgentFactory,
): Promise<HostApp> {
  const app = await createHost({
    aiZenDir: dataRoot.path,
    port: 0,
    local: true,
    createAgent: createAgent ?? (async () => oneRound()),
    exit: () => undefined,
    logger: { warn: () => undefined, error: () => undefined },
  });
  await app.start();
  apps.push(app);
  return app;
}

async function makeHarness(
  options: { createAgent?: AgentFactory; modelId?: string } = {},
): Promise<Harness> {
  const dataRoot = await makeTempDir("ai-zen-conv-handlers-");
  temps.push(dataRoot);
  await fs.mkdir(join(dataRoot.path, "agents"), { recursive: true });
  await fs.writeFile(join(dataRoot.path, "config.json"), CONFIG, "utf8");
  await fs.writeFile(join(dataRoot.path, "agents", "default.json"), AGENT, "utf8");
  const workspaceDir = await makeTempDir("ai-zen-conv-handlers-cwd-");
  temps.push(workspaceDir);

  const app = await startHost(dataRoot, options.createAgent);

  const { workspace } = await callMethod(app, "workspace.create", { cwd: workspaceDir.path });
  const session = await seedSession(app, workspace.id, options.modelId);
  return {
    app,
    dataRoot,
    workspaceId: workspace.id,
    sessionId: session.id,
    workspaceDir,
  };
}

/**
 * 建一段对话并让它落库（R56：`session.create` 只发 id，首次 `send` 才写 `sessions` 行）。
 *
 * 这里的用例要看的是别的东西（列表、四件事、删除），所以直接把草稿落成真行。
 */
async function seedSession(
  app: HostApp,
  workspaceId: string,
  modelId = "test-model",
): Promise<SessionView> {
  const created = await callMethod(app, "session.create", {
    workspaceId,
    agentId: "default",
    modelId,
  });
  if (!created.session) throw new Error("session.create 没有建出对话");
  await app.sessionService.ensurePersisted(created.session.id);
  return created.session;
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
async function uploadAsset(app: HostApp, sessionId: string): Promise<string> {
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
    sessionId,
  });
  return ref.assetId;
}

/**
 * 直接读库里那一行（`message.list` 在对话活着时读的是内存，验「落库」要绕过它）。
 *
 * `content` 列存的是 JSON：解回来就是 core 的 `AgentNS.MessageContent`。
 */
async function persistedContentOf(app: HostApp, messageId: string): Promise<unknown> {
  const row = await app.db.get<{ content: string }>(
    "SELECT content FROM messages WHERE id = ?",
    [messageId],
  );
  if (row === undefined) throw new Error(`库里没有 ${messageId}`);
  return JSON.parse(row.content) as unknown;
}

/**
 * 等库里的 `inbox` 行到几条（`inboxAdded` / `inboxCleared` 是同步事件，写库走自己的链，不能同拍拿到）。
 */
async function waitInboxRows(
  app: HostApp,
  sessionId: string,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await app.inbox.listBySession(sessionId);
    if (rows.length === expected) return;
    await wait(10);
  }
  throw new Error(`库里的 inbox 行没到 ${expected} 条`);
}

/** 库里这段对话的 `messages` 行数（验「杀死不删消息」要绕过内存） */
async function countMessages(app: HostApp, sessionId: string): Promise<number> {
  const row = await app.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM messages WHERE sessionId = ?",
    [sessionId],
  );
  return row?.n ?? 0;
}

/** 等这段对话真的闲下来（那一格是 idle、队里也空了），且写库推进完 */
async function idle(app: HostApp, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const now = app.chatRunner.state(sessionId);
    if (now.status === "idle" && now.inbox.length === 0) return;
    await wait(10);
  }
  throw new Error("这段对话没有闲下来");
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop("requested").catch(() => undefined);
  for (const temp of temps.splice(0)) await temp.remove();
});

describe("session.send", () => {
  it("回执只有 userMessageId 与附件结局，并把素材记成用户消息的引用关系（L6 / D5）", async () => {
    const { app, sessionId } = await makeHarness();
    const assetId = await uploadAsset(app, sessionId);

    const sent = await callMethod(app, "session.send", {
      sessionId,
      input: { content: "看图", assetIds: [assetId] },
    });

    // 回执里没有状态、没有「叫醒了没有」、没有结果
    expect(Object.keys(sent).sort()).toEqual(["attachments", "userMessageId"]);
    expect(sent.userMessageId.length).toBeGreaterThan(0);
    // 消息落库那一刻扫 content 里的 `__asset_id` 写关系行
    await idle(app, sessionId);
    expect(await app.assets.listAssetIdsByMessage(sent.userMessageId)).toEqual([assetId]);
    expect(await app.assets.countSessions(assetId)).toBe(1);
    expect(await app.assetService.get(assetId)).toBeDefined();

    const page = await callMethod(app, "message.list", { sessionId });
    expect(page.messages.map((message) => message.id)).toContain(sent.userMessageId);
    // 回答在库里（回执不再替它报 id：客户端按 `message.added` 认领那条消息）
    expect(page.messages.map((message) => message.role)).toContain(AgentNSValue.Role.Assistant);
  });

  it("附件结局里的句子按这条连接的语言渲染（D8：库里存码不存句子）", async () => {
    const { app, sessionId } = await makeHarness();
    const assetId = await uploadAsset(app, sessionId);

    const english = await callInLanguage(
      app,
      "session.send",
      { sessionId, input: { content: "看图", assetIds: [assetId] } },
      "en",
    );
    await idle(app, sessionId);
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
      "session.send",
      { sessionId, input: { content: "再看", assetIds: [assetId] } },
      "zh",
    );
    await idle(app, sessionId);
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
    const { app, sessionId } = await makeHarness({ createAgent: async () => agent });

    const first: SessionSendResult = await callMethod(app, "session.send", {
      sessionId,
      input: { content: "第一句" },
    });
    const second: SessionSendResult = await callMethod(app, "session.send", {
      sessionId,
      input: { content: "第二句" },
    });

    // 忙不是拒绝的理由：两句都是「收下了」，回执形状一模一样
    expect(second.userMessageId).not.toBe(first.userMessageId);
    expect(Object.keys(second).sort()).toEqual(["attachments", "userMessageId"]);
    // 第二句此刻压在队里（现读的待办）
    expect(app.chatRunner.state(sessionId).inbox.map((item) => item.messageId)).toEqual([
      second.userMessageId,
    ]);

    gate.resolve();
    await idle(app, sessionId);

    // 两句都落了库，id 就是回包里那两个（D5：先画的那条与库里那条是同一条）
    const page = await callMethod(app, "message.list", { sessionId });
    expect(page.messages.map((message) => message.id)).toContain(first.userMessageId);
    expect(page.messages.map((message) => message.id)).toContain(second.userMessageId);
  });

  it("挡着的问题先答再发：投递不是绕道（D23）", async () => {
    const { app, sessionId } = await makeHarness();

    // 摆一个挡着这段对话的问题（交接确认那一类）
    await app.questionService.ask({
      sessionId,
      kind: "confirmation",
      prompt: { messageKey: "question.handoff.prompt", params: { percent: 90 } },
      options: [{ value: "ok", label: { messageKey: "question.handoff.self" } }],
    });

    await expect(
      callMethod(app, "session.send", { sessionId, input: { content: "想绕过去" } }),
    ).rejects.toSatisfy(
      (error: unknown) => HostError.is(error) && error.code === "question_pending",
    );
    // 那一句没有进队
    expect(app.chatRunner.state(sessionId).inbox).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 附件：一条消息只有一份内容（落库照抄发出去的那一份）
// ---------------------------------------------------------------------------

describe("附件的落库形态：按原样持久化（prompt caching 要的是前缀逐字一致）", () => {
  it("带附件的一次投递：库里那条的 content 与内存里那一份逐字相同（含厂商产物与 __asset_id）", async () => {
    const { app, sessionId } = await makeHarness({ modelId: "vision-model" });
    const assetId = await uploadAsset(app, sessionId);

    const sent = await callMethod(app, "session.send", {
      sessionId,
      input: { content: "看图", assetIds: [assetId] },
    });
    // 端点没有 Files API、模型能看图 → 内联成 data URL（厂商产物就是那串 base64）
    expect(sent.attachments[0]?.deliveredAs).toBe("inline");
    await idle(app, sessionId);

    const memory = app.chatRunner
      .messagesOf(sessionId)
      ?.find((message) => message.id === sent.userMessageId)?.content;
    expect(memory).toBeDefined();
    const stored = await persistedContentOf(app, sent.userMessageId);

    // 库里那份 = 内存里那份，一个字都不清理
    expect(JSON.stringify(stored)).toBe(JSON.stringify(memory));

    const sections = stored as LocalMessageContentSection[];
    expect(sections[0]).toEqual({ type: "text", text: "看图" });
    // 厂商产物（内联的 base64 data URL）在库里
    expect(sections[1]?.type).toBe("image_url");
    const url = (sections[1] as { image_url: { url: string } }).image_url.url;
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    // 本地标记也在：客户端靠它回显「这条消息用了哪份素材」
    expect(localAssetIdOf(sections[1] as LocalMessageContentSection)).toBe(assetId);
  });

  it("重启视角：同一个库重新装一遍，读回的那条 content 与投递时逐字相同", async () => {
    const harness = await makeHarness({ modelId: "vision-model" });
    const assetId = await uploadAsset(harness.app, harness.sessionId);

    const sent = await callMethod(harness.app, "session.send", {
      sessionId: harness.sessionId,
      input: { content: "看图", assetIds: [assetId] },
    });
    await idle(harness.app, harness.sessionId);
    const delivered = JSON.stringify(
      harness.app.chatRunner
        .messagesOf(harness.sessionId)
        ?.find((message) => message.id === sent.userMessageId)?.content,
    );

    // 重启：同一个数据根再起一个宿主（内存里的现场全没了，只剩库里那一份）
    await harness.app.stop("requested");
    const restarted = await startHost(harness.dataRoot);

    const page = await callMethod(restarted, "message.list", {
      sessionId: harness.sessionId,
    });
    const readBack = page.messages.find((message) => message.id === sent.userMessageId)?.content;
    expect(JSON.stringify(readBack)).toBe(delivered);

    // 再装配一次（发一句就会把历史装进去）：库里那一行不被改写，前缀不变
    await callMethod(restarted, "session.send", {
      sessionId: harness.sessionId,
      input: { content: "再说一句" },
    });
    await idle(restarted, harness.sessionId);
    expect(JSON.stringify(await persistedContentOf(restarted, sent.userMessageId))).toBe(delivered);

    // 装配时 `resolveHistory` 按当前模型把段重建了一遍（内存里那份不再带本地标记），
    // 但**出网的那一份与落库那一份逐字相同** —— 前缀不变，缓存不 miss
    const assembled = restarted.chatRunner
      .messagesOf(harness.sessionId)
      ?.find((message) => message.id === sent.userMessageId)?.content;
    expect(JSON.stringify(formatContent(assembled ?? ""))).toBe(
      JSON.stringify(formatContent(JSON.parse(delivered) as LocalMessageContentSection[])),
    );
  });
});

describe("session.abort", () => {
  it("本来就没有 agent 时 signalled 为 false（那不是错误）", async () => {
    const { app, sessionId } = await makeHarness();
    const result: SessionAbortResult = await callMethod(app, "session.abort", {
      sessionId,
    });
    expect(Object.keys(result)).toEqual(["signalled"]);
    expect(result.signalled).toBe(false);
  });

  it("在干着活时打到了 agent 上，并把输出闸关上（中断不是杀死）", async () => {
    const gate: Deferred<void> = deferred();
    const agent = new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢慢说" }] }]);
    const { app, sessionId } = await makeHarness({ createAgent: async () => agent });

    await callMethod(app, "session.send", { sessionId, input: { content: "第一句" } });
    const aborted: SessionAbortResult = await callMethod(app, "session.abort", {
      sessionId,
      reason: "用户按了中断",
    });

    expect(aborted.signalled).toBe(true);
    expect(agent.abortCalls).toBe(1);
    // 掐完输出闸是关着的（能继续），而且它还活着 —— 中断不是杀死
    expect(app.chatRunner.state(sessionId).outputPaused).toBe(true);
    expect(app.chatRunner.state(sessionId).alive).toBe(true);

    gate.resolve();
    await wait(20);
  });
});

describe("session.pause / session.resume（只翻输出闸）", () => {
  it("暂停之后输出闸关着、继续之后开着；两份回执都是「打完之后还暂停着吗」", async () => {
    const { app, sessionId } = await makeHarness();
    await callMethod(app, "session.send", { sessionId, input: { content: "说一句" } });
    await idle(app, sessionId);

    const paused: SessionPauseResult = await callMethod(app, "session.pause", {
      sessionId,
    });
    expect(Object.keys(paused)).toEqual(["paused"]);
    expect(paused.paused).toBe(true);
    expect(app.chatRunner.state(sessionId).outputPaused).toBe(true);
    // 关的是输出闸，不是别的：忙闲与死活一格都没动
    expect(app.chatRunner.state(sessionId).status).toBe("idle");
    expect(app.chatRunner.state(sessionId).alive).toBe(true);

    const resumed: SessionResumeResult = await callMethod(app, "session.resume", {
      sessionId,
    });
    expect(resumed).toEqual({ paused: false });
    expect(app.chatRunner.state(sessionId).outputPaused).toBe(false);
  });

  it("没有 agent（死的）→ `{ paused: false }`，不是错误", async () => {
    const { app, sessionId } = await makeHarness();
    expect(await callMethod(app, "session.pause", { sessionId })).toEqual({
      paused: false,
    });
    expect(await callMethod(app, "session.resume", { sessionId })).toEqual({
      paused: false,
    });
  });

  it("交接期间两者都被拒（`busy` / `handoff_in_progress`）", async () => {
    const { app, sessionId } = await makeHarness();
    app.chatRunner.beginHandoff(sessionId);

    await expect(
      callMethod(app, "session.pause", { sessionId }),
    ).rejects.toMatchObject({
      code: "busy",
      detail: { sessionId, reason: "handoff_in_progress" },
    });
    await expect(
      callMethod(app, "session.resume", { sessionId }),
    ).rejects.toMatchObject({
      code: "busy",
      detail: { sessionId, reason: "handoff_in_progress" },
    });

    app.chatRunner.endHandoff(sessionId);
  });
});

describe("session.clearInbox", () => {
  it("清掉这段对话的待办，回清了几条（待办归客户端自己管）", async () => {
    const gate: Deferred<void> = deferred();
    const { app, sessionId } = await makeHarness({
      createAgent: async () => new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢" }] }]),
    });

    // 第一句在跑，后两句排在待办里
    await callMethod(app, "session.send", { sessionId, input: { content: "第一句" } });
    await callMethod(app, "session.send", { sessionId, input: { content: "排一句" } });
    await callMethod(app, "session.send", { sessionId, input: { content: "再排一句" } });
    // 「有几条」客户端本来就能从读数的待办那一格里读到
    expect(app.chatRunner.state(sessionId).inbox).toHaveLength(2);

    const cleared = await callMethod(app, "session.clearInbox", { sessionId });
    expect(cleared).toEqual({ cleared: 2 });
    expect(app.chatRunner.state(sessionId).inbox).toEqual([]);

    gate.resolve();
    await idle(app, sessionId);
  });

  it("没有 agent 就没有待办可清：回 0，不是错误", async () => {
    const { app, sessionId } = await makeHarness();
    expect(await callMethod(app, "session.clearInbox", { sessionId })).toEqual({
      cleared: 0,
    });
  });
});

describe("session.delete", () => {
  it("删除走服务层，并让运行时丢掉这段对话的现场（R33）", async () => {
    const { app, sessionId } = await makeHarness();
    const assetId = await uploadAsset(app, sessionId);
    await callMethod(app, "session.send", {
      sessionId,
      input: { content: "说点话", assetIds: [assetId] },
    });
    await idle(app, sessionId);

    const dryRun: SessionDeleteResult = await callMethod(app, "session.delete", {
      sessionId,
      dryRun: true,
    });
    expect(dryRun.removed).toBe(false);
    expect(dryRun.consequences.messages).toBeGreaterThan(0);

    const removed = await callMethod(app, "session.delete", { sessionId });
    expect(removed.removed).toBe(true);
    // 现场没了：这一段现在没有 agent 了
    expect(app.chatRunner.state(sessionId).alive).toBe(false);
    // 素材行随对话一起没了
    expect(await app.assetService.get(assetId)).toBeUndefined();
  });
});

describe("session.kill（用户按杀死：这不是删除）", () => {
  it("杀掉活着的会话：`{ killed: true }`；待办作废（库里那几行也删），消息与会话行一个字节没动", async () => {
    const gate: Deferred<void> = deferred();
    const { app, sessionId } = await makeHarness({
      createAgent: async () => new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢慢说" }] }]),
    });

    // 第一句被取走、卡在流里，后两句只能排着（各自落一行）
    await callMethod(app, "session.send", { sessionId, input: { content: "第一句" } });
    await callMethod(app, "session.send", { sessionId, input: { content: "排一句" } });
    await callMethod(app, "session.send", { sessionId, input: { content: "再排一句" } });
    await waitInboxRows(app, sessionId, 2);
    const messagesBefore = await countMessages(app, sessionId);
    expect(messagesBefore).toBeGreaterThan(0);
    // 会话行快照：杀死之后它得逐列相同（杀死不是删除）
    const rowBefore = await app.db.get("SELECT * FROM sessions WHERE id = ?", [
      sessionId,
    ]);

    const killed: SessionKillResult = await callMethod(app, "session.kill", {
      sessionId,
    });
    expect(Object.keys(killed)).toEqual(["killed"]);
    expect(killed.killed).toBe(true);

    // 死 = 这一段没有 agent 实例了：`alive: false`、待办空
    expect(app.chatRunner.state(sessionId)).toMatchObject({ alive: false, inbox: [] });
    // 库里那些没被取走的行也没了（先 `agents.kill` 再拆桥，那条 `inboxCleared` 才有人听）
    await waitInboxRows(app, sessionId, 0);

    // 杀死不是删除：消息一条不少、会话行逐列未动、`session.get` 照旧答得出
    expect(await countMessages(app, sessionId)).toBe(messagesBefore);
    expect(await app.db.get("SELECT * FROM sessions WHERE id = ?", [sessionId])).toEqual(
      rowBefore,
    );
    const still = await callMethod(app, "session.get", { sessionId });
    expect(still.session.id).toBe(sessionId);

    gate.resolve();
    await wait(20);
  });

  it("本来就是死的：`{ killed: false }`，不抛错、也不产生任何写", async () => {
    const { app, sessionId } = await makeHarness();

    const killed: SessionKillResult = await callMethod(app, "session.kill", {
      sessionId,
    });
    expect(Object.keys(killed)).toEqual(["killed"]);
    expect(killed.killed).toBe(false);
    // 什么也没动：仍然没有 agent、库里一条待办行也没多出来
    expect(app.chatRunner.state(sessionId).alive).toBe(false);
    expect(await app.inbox.listBySession(sessionId)).toEqual([]);
  });

  it("交接期间拒（`busy` / `handoff_in_progress`）：agent 没被杀掉", async () => {
    const { app, sessionId } = await makeHarness();
    await callMethod(app, "session.send", { sessionId, input: { content: "说一句" } });
    await idle(app, sessionId);
    app.chatRunner.beginHandoff(sessionId);

    await expect(
      callMethod(app, "session.kill", { sessionId }),
    ).rejects.toMatchObject({
      code: "busy",
      detail: { sessionId, reason: "handoff_in_progress" },
    });
    // 一个也没生效：agent 还在
    expect(app.chatRunner.state(sessionId).alive).toBe(true);

    app.chatRunner.endHandoff(sessionId);
  });
});

describe("session.state：四件事 + 待办 + 名册 + 交接态", () => {
  it("形状就是那九样：会话 id、四件事各一格、队里压着什么、子 agent 名册、交接态、读数的时刻", async () => {
    const { app, sessionId } = await makeHarness();

    const { state } = await callMethod(app, "session.state", { sessionId });

    expect(Object.keys(state).sort()).toEqual([
      "alive",
      "at",
      "handoff",
      "inbox",
      "inputPaused",
      "outputPaused",
      "sessionId",
      "status",
      "subAgents",
    ]);
    expect(state.sessionId).toBe(sessionId);
    // 一次都没发过话：没有 agent 对象（死活那一格是 false），两道闸也就没关着
    expect(state.alive).toBe(false);
    expect(state.inputPaused).toBe(false);
    expect(state.outputPaused).toBe(false);
    expect(state.status).toBe("idle");
    expect(state.inbox).toEqual([]);
    // 死了就没有名册（子 agent 的话只在它自己那个对象里），也没在交接
    expect(state.subAgents).toEqual([]);
    expect(state.handoff).toBeNull();
    expect(Number.isNaN(Date.parse(state.at))).toBe(false);
  });

  it("发出去之后报忙，闲下来之后报闲（忙闲只有这两个值）", async () => {
    const gate: Deferred<void> = deferred();
    const { app, sessionId } = await makeHarness({
      createAgent: async () => new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢" }] }]),
    });

    await callMethod(app, "session.send", { sessionId, input: { content: "慢慢说" } });
    const during = await callMethod(app, "session.state", { sessionId });
    expect(during.state.status).toBe("working");
    expect(during.state.alive).toBe(true);

    gate.resolve();
    await idle(app, sessionId);
    const after = await callMethod(app, "session.state", { sessionId });
    expect(after.state.status).toBe("idle");
    expect(after.state.inbox).toEqual([]);
  });

  it("会话不存在（也没有草稿）→ not_found", async () => {
    const { app } = await makeHarness();
    await expect(
      callMethod(app, "session.state", { sessionId: "没有这段" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("session.setThresholds（PRD 1.4 / 4.7：两条阈值有上游默认、会话可覆盖）", () => {
  it("改完 `SessionView` 里读得到：省略不动、显式 `null` 回到跟模型走", async () => {
    const { app, sessionId } = await makeHarness();

    const changed = await callMethod(app, "session.setThresholds", {
      sessionId,
      handoffThreshold: 800,
      guardThreshold: 1200,
    });
    expect(changed.session).toMatchObject({ handoffThreshold: 800, guardThreshold: 1200 });

    // 落库了：另开一次（读库里那一行）拿到的还是这两个数
    const reopened = await callMethod(app, "session.get", { sessionId });
    expect(reopened.session).toMatchObject({ handoffThreshold: 800, guardThreshold: 1200 });

    // 只给一条：另一条一个字都不动
    const onlyGuard = await callMethod(app, "session.setThresholds", {
      sessionId,
      guardThreshold: 1500,
    });
    expect(onlyGuard.session).toMatchObject({ handoffThreshold: 800, guardThreshold: 1500 });

    // 显式 `null`：回到跟模型走（不是 0，也不是省略）
    const cleared = await callMethod(app, "session.setThresholds", {
      sessionId,
      handoffThreshold: null,
    });
    expect(cleared.session.handoffThreshold).toBeNull();
    expect(cleared.session.guardThreshold).toBe(1500);
  });

  it("改阈值不重建驱动者（与 `setModel` 相反：那一条改的是装配事实）", async () => {
    const { app, sessionId } = await makeHarness();
    // 先让它跑一次：这样才有一个活着的驱动者可比
    await callMethod(app, "session.send", { sessionId, input: { content: "先说一句" } });
    await idle(app, sessionId);
    const before = app.agentRegistry.get(sessionId);
    expect(before).toBeDefined();

    const decisions: string[] = [];
    const off = app.agentRegistry.observeLifecycle((event) =>
      decisions.push(`${event.action}:${event.reason}`),
    );
    try {
      await callMethod(app, "session.setThresholds", {
        sessionId,
        handoffThreshold: 800,
        guardThreshold: 1200,
      });
      // 两条阈值不进驱动者的出厂配置：一个生灭决定都没有，手上还是同一个对象
      expect(decisions).toEqual([]);
      expect(app.agentRegistry.get(sessionId)).toBe(before);

      // 对照：换模型改的是装配事实 —— 空闲时改完那个驱动者当场退役，
      // 下一句话按新事实重新装配（不靠投递时发现手里那个不合用）
      await callMethod(app, "session.setModel", { sessionId, modelId: "other-model" });
      expect(decisions).toEqual(["retired:assembly-facts-changed"]);
      expect(app.agentRegistry.get(sessionId)).toBeUndefined();

      await callMethod(app, "session.send", { sessionId, input: { content: "换完再说一句" } });
      await idle(app, sessionId);
      expect(decisions).toEqual([
        "retired:assembly-facts-changed",
        "rebuilt:assembly-facts-changed",
      ]);
      expect(app.agentRegistry.get(sessionId)).not.toBe(before);
    } finally {
      off();
    }
  });
});

describe("session.setModel / setThinking：只允许空闲时改（改完当场让驱动者退役）", () => {
  it("忙时一律拒（`busy` + `working`），会话行一个字节都没写", async () => {
    const gate: Deferred<void> = deferred();
    const { app, sessionId } = await makeHarness({
      createAgent: async () => new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢" }] }]),
    });

    await callMethod(app, "session.send", { sessionId, input: { content: "慢慢说" } });
    expect(app.chatRunner.state(sessionId).status).toBe("working");
    const before = await app.sessions.get(sessionId);
    const driver = app.agentRegistry.get(sessionId);
    expect(driver).toBeDefined();

    // 换模型：拒
    await expect(
      callMethod(app, "session.setModel", { sessionId, modelId: "other-model" }),
    ).rejects.toMatchObject({ code: "busy", detail: { sessionId, reason: "working" } });
    // 换思考档位：拒（这一条先于「这个模型能不能调档」那些校验）
    await expect(
      callMethod(app, "session.setThinking", { sessionId, level: "low" }),
    ).rejects.toMatchObject({ code: "busy", detail: { sessionId, reason: "working" } });

    // 一个字节都没写库：模型、档位、更新时间都还是原样
    const after = await app.sessions.get(sessionId);
    expect(after?.modelId).toBe(before?.modelId);
    expect(after?.thinkingLevel).toBe(before?.thinkingLevel);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    // 驱动者也没被动过：它手上那批活还在跑
    expect(app.agentRegistry.get(sessionId)).toBe(driver);

    gate.resolve();
    await idle(app, sessionId);
  });

  it("暂停（`isOutputPaused`）时允许改：它手上没活", async () => {
    const { app, sessionId } = await makeHarness();
    await callMethod(app, "session.send", { sessionId, input: { content: "先说一句" } });
    await idle(app, sessionId);
    // 中断之后输出闸关着，但手上一批活已经完了 —— 这是「闲 + 闸关」，不是忙
    const aborted = await callMethod(app, "session.abort", { sessionId });
    expect(aborted.signalled).toBe(true);
    expect(app.chatRunner.state(sessionId).outputPaused).toBe(true);
    expect(app.chatRunner.state(sessionId).status).toBe("idle");

    const changed = await callMethod(app, "session.setModel", {
      sessionId,
      modelId: "other-model",
    });
    expect(changed.session.modelId).toBe("other-model");
    expect((await app.sessions.get(sessionId))?.modelId).toBe("other-model");
    // 出厂配置变了：那个驱动者当场退役
    expect(app.agentRegistry.get(sessionId)).toBeUndefined();

    // 没有 agent（死的）也一样能改：档位照样落库
    const thinking = await callMethod(app, "session.setThinking", {
      sessionId,
      level: "low",
    });
    expect(thinking.thinking.levels).toContain("low");
    expect((await app.sessions.get(sessionId))?.thinkingLevel).toBe("low");
  });

  it("从来没有 agent 的对话也能改（没有驱动者就没有手上那批活）", async () => {
    const { app, sessionId } = await makeHarness();
    expect(app.chatRunner.state(sessionId).alive).toBe(false);

    const changed = await callMethod(app, "session.setModel", {
      sessionId,
      modelId: "other-model",
    });

    expect(changed.session.modelId).toBe("other-model");
    expect((await app.sessions.get(sessionId))?.modelId).toBe("other-model");
    // 没有 agent 可退役，也就一个生灭决定都没有
    expect(app.agentRegistry.get(sessionId)).toBeUndefined();
  });
});

describe("session.list：侧栏那一格（F-I3）", () => {
  it("四件事与压着几条都是现读的", async () => {
    const gate: Deferred<void> = deferred();
    const { app, sessionId, workspaceId } = await makeHarness({
      createAgent: async () => new FakeAgent([{ gate: gate.promise, deltas: [{ content: "慢" }] }]),
    });

    await callMethod(app, "session.send", { sessionId, input: { content: "慢慢说" } });
    await callMethod(app, "session.send", { sessionId, input: { content: "排一句" } });

    const during = await callMethod(app, "session.list", { workspaceId });
    const entry = during.sessions.find((item) => item.id === sessionId);
    expect(entry?.status).toBe("working");
    expect(entry?.alive).toBe(true);
    expect(entry?.outputPaused).toBe(false);
    expect(entry?.inboxPending).toBe(1);

    gate.resolve();
    await idle(app, sessionId);

    const after = await callMethod(app, "session.list", { workspaceId });
    const settled = after.sessions.find((item) => item.id === sessionId);
    expect(settled?.status).toBe("idle");
    expect(settled?.alive).toBe(true);
    expect(settled?.inboxPending).toBe(0);
  });
});
