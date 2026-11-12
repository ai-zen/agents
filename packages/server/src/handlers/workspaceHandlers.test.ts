/**
 * `workspace.*` 的验收：四个只转发的方法 + 删项目时的跨层补齐（R43 / R33）。
 *
 * 这里盯的是「删完项目之后，运行时的 Scope 与 assets/ 下的文件有没有跟着走」——
 * 那两件事服务层管不到，只有接线层知道该问谁。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../app.js";
import type { ServerApp } from "../app.js";
import type { ConnectionInfo } from "../net/index.js";
import { makeTempDir, type TempDir } from "../net/TestSupport.js";
import { ServerError } from "../wire/index.js";
import type { ConversationView, MethodName, MethodParams, MethodResult } from "../wire/index.js";

const CONFIG = JSON.stringify(
  {
    endpoints: [
      { id: "fake", name: "Fake", baseUrl: "https://example.invalid/v1", apiKey: "sk-fake" },
    ],
    models: [{ id: "test-model", name: "Test Model", endpointId: "fake", custom: true }],
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

const CONNECTION: ConnectionInfo = {
  id: "test-connection",
  language: "en",
  clientInfo: null,
  credentialId: null,
};

const temps: TempDir[] = [];
const apps: ServerApp[] = [];

async function makeTemp(prefix: string): Promise<TempDir> {
  const dir = await makeTempDir(prefix);
  temps.push(dir);
  return dir;
}

async function startApp(): Promise<ServerApp> {
  const dataRoot = await makeTemp("ai-zen-ws-handlers-");
  await fs.mkdir(join(dataRoot.path, "agents"), { recursive: true });
  await fs.writeFile(join(dataRoot.path, "config.json"), CONFIG, "utf8");
  await fs.writeFile(join(dataRoot.path, "agents", "default.json"), AGENT, "utf8");
  const app = await createServer({
    aiZenDir: dataRoot.path,
    port: 0,
    local: true,
    // 空闲回收调长：要用例看的是「删项目时主动销毁」，不是空闲到点
    scopeIdleTimeoutMs: 10 * 60 * 1000,
    exit: () => undefined,
    logger: { warn: () => undefined, error: () => undefined },
  });
  await app.start();
  apps.push(app);
  return app;
}

/**
 * 建一段对话并让它落库（R56：`create` 只发 id，首次 `send` 才写 `conversations` 行）。
 *
 * 这些用例要看的是「项目被删时名下对话怎么处理」，所以直接把草稿落成真行，不跑一轮。
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

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop("requested").catch(() => undefined);
  for (const temp of temps.splice(0)) await temp.remove();
});

describe("workspace.* 的基本转发", () => {
  it("create / get / list / rename 都是服务层的答案", async () => {
    const app = await startApp();
    const cwd = await makeTemp("ai-zen-ws-handlers-cwd-");

    const { workspace } = await callMethod(app, "workspace.create", {
      cwd: cwd.path,
      name: "临时项目",
    });
    expect(workspace.name).toBe("临时项目");
    expect(workspace.folder.cwd).toBe(cwd.path);

    const got = await callMethod(app, "workspace.get", { workspaceId: workspace.id });
    expect(got.workspace.id).toBe(workspace.id);

    const renamed = await callMethod(app, "workspace.rename", {
      workspaceId: workspace.id,
      name: "改过名",
    });
    expect(renamed.workspace.name).toBe("改过名");
    // id 与 cwd 不可变（D9）
    expect(renamed.workspace.folder.cwd).toBe(cwd.path);

    const listed = await callMethod(app, "workspace.list");
    expect(listed.workspaces.map((item) => item.id)).toContain(workspace.id);
  });

  it("删不存在的项目报 not_found（服务层的码，接线层不改写）", async () => {
    const app = await startApp();
    await expect(
      callMethod(app, "workspace.remove", { workspaceId: "no-such-workspace" }),
    ).rejects.toSatisfy((error: unknown) => ServerError.is(error) && error.code === "not_found");
  });
});

describe("workspace.remove 的跨层补齐", () => {
  it("dryRun 只算代价：Scope 不回收、素材文件不动、对话还在", async () => {
    const app = await startApp();
    const cwd = await makeTemp("ai-zen-ws-handlers-cwd-");
    const { workspace } = await callMethod(app, "workspace.create", { cwd: cwd.path });
    const conversation = await seedConversation(app, workspace.id);
    const assetPath = await seedAsset(app, conversation.id);

    await app.scopeRegistry.acquire(workspace.id);
    app.scopeRegistry.release(workspace.id);
    expect(app.scopeRegistry.size()).toBe(1);

    const dryRun = await callMethod(app, "workspace.remove", {
      workspaceId: workspace.id,
      dryRun: true,
    });
    expect(dryRun.removed).toBe(false);
    expect(dryRun.consequences.conversations).toBe(1);
    expect(dryRun.consequences.assets).toBe(1);
    // 什么都没动
    expect(app.scopeRegistry.size()).toBe(1);
    expect(await exists(assetPath)).toBe(true);
    expect(app.chatRunner.turn(conversation.id)).toBeUndefined();
    const still = await callMethod(app, "conversation.list", { workspaceId: workspace.id });
    expect(still.total).toBe(1);
  });

  it("真删：Scope 被主动回收（R43）、对话一起没、素材文件按引用清（R33）", async () => {
    const app = await startApp();
    const cwd = await makeTemp("ai-zen-ws-handlers-cwd-");
    const { workspace } = await callMethod(app, "workspace.create", { cwd: cwd.path });
    const conversation = await seedConversation(app, workspace.id);
    const assetPath = await seedAsset(app, conversation.id);

    await app.scopeRegistry.acquire(workspace.id);
    app.scopeRegistry.release(workspace.id);
    expect(app.scopeRegistry.size()).toBe(1);

    const removed = await callMethod(app, "workspace.remove", { workspaceId: workspace.id });
    expect(removed.removed).toBe(true);
    expect(removed.consequences.conversations).toBe(1);
    // Scope 销毁 = MCP 连接在这里断开
    expect(app.scopeRegistry.size()).toBe(0);
    expect(await exists(assetPath)).toBe(false);
    const remaining = await callMethod(app, "conversation.list", { workspaceId: workspace.id });
    expect(remaining.total).toBe(0);
    // 项目行本身也没了
    await expect(
      callMethod(app, "workspace.get", { workspaceId: workspace.id }),
    ).rejects.toSatisfy((error: unknown) => ServerError.is(error) && error.code === "not_found");
  });
});

/** 造一条素材行并返回它在磁盘上的绝对路径 */
async function seedAsset(app: ServerApp, conversationId: string): Promise<string> {
  const tempPath = join(app.paths.assetsDir, ".upload-ws.part");
  await fs.writeFile(tempPath, "png-bytes");
  const ref = await app.assetService.finalizeUpload({
    uploadId: "upload-ws",
    tempPath,
    mime: "image/png",
    bytes: 9,
    sha256: "not-checked-here",
    name: "a.png",
    purpose: "message_image",
    conversationId,
  });
  return join(app.paths.dataRoot, "assets", `${ref.assetId}.png`);
}
