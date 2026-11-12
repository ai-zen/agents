/**
 * `createHandlers` 的验收：整张表长什么样、哪些方法还没注册、三个「只转发」的域接得对不对。
 *
 * 这里走的是单根造出来的真服务（真库、真服务层），只是省掉网络这一层直接调 handler 表；
 * 需要看「未注册的方法回什么」时才开一条真 WebSocket —— 那个答案由接线层给。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../app.js";
import type { ServerApp } from "../app.js";
import type { ConnectionInfo } from "../net/index.js";
import { isError, makeTempDir, TestClient, type TempDir } from "../net/TestSupport.js";
import { METHOD_NAMES } from "../wire/index.js";
import type { MethodName, MethodParams, MethodResult } from "../wire/index.js";
import { createHandlers } from "./index.js";

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
const clients: TestClient[] = [];

async function makeTemp(prefix: string): Promise<TempDir> {
  const dir = await makeTempDir(prefix);
  temps.push(dir);
  return dir;
}

async function startApp(): Promise<{ app: ServerApp; workspaceDir: TempDir }> {
  const dataRoot = await makeTemp("ai-zen-handlers-");
  await fs.mkdir(join(dataRoot.path, "agents"), { recursive: true });
  await fs.writeFile(join(dataRoot.path, "config.json"), CONFIG, "utf8");
  await fs.writeFile(join(dataRoot.path, "agents", "default.json"), AGENT, "utf8");
  const workspaceDir = await makeTemp("ai-zen-handlers-cwd-");
  const app = await createServer({
    aiZenDir: dataRoot.path,
    port: 0,
    local: true,
    exit: () => undefined,
    logger: { warn: () => undefined, error: () => undefined },
  });
  await app.start();
  apps.push(app);
  return { app, workspaceDir };
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

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const app of apps.splice(0)) await app.stop("requested").catch(() => undefined);
  for (const temp of temps.splice(0)) await temp.remove();
});

describe("handler 表", () => {
  it("表里的方法名都在契约内，且一个方法名只被注册一次", async () => {
    const { app } = await startApp();
    const registered = Object.keys(app.handlers);
    for (const method of registered) expect(METHOD_NAMES).toContain(method);
    expect(new Set(registered).size).toBe(registered.length);
  });

  it("接线层代管的方法不在表里（hello / setLanguage / 上传）", async () => {
    const { app } = await startApp();
    for (const method of ["server.hello", "server.setLanguage", "asset.begin", "asset.end"]) {
      expect(app.handlers[method as MethodName]).toBeUndefined();
    }
  });

  it("没注册的方法经由接线层回 unsupported，而不是别的码（R11）", async () => {
    const { app } = await startApp();
    const target = app.address;
    const client = await TestClient.connect(`ws://127.0.0.1:${target?.port ?? 0}/`);
    clients.push(client);
    const token = (await fs.readFile(app.paths.tokenFile, "utf8")).trim();
    await client.hello(token);

    for (const method of ["agent.list", "config.get", "question.list", "conversation.transient"]) {
      client.request(method, {});
      const frame = await client.queue.next();
      expect(isError(frame)).toBe(true);
      if (isError(frame)) expect(frame.error.data.code).toBe("unsupported");
    }
  });

  it("未实现的域与已实现的域不重叠（表里没有一半实现的半成品）", async () => {
    const { app } = await startApp();
    const registered = new Set(Object.keys(app.handlers));
    for (const method of METHOD_NAMES) {
      if (method.startsWith("asset.")) continue;
      const handler = app.handlers[method];
      // 要么没注册，要么就是一个可调用的实现（没有“注册了但没实现”的占位）
      if (registered.has(method)) expect(typeof handler).toBe("function");
      else expect(handler).toBeUndefined();
    }
  });
});

describe("只转发的三个域", () => {
  it("message.list / search.* / credential.* 都接到服务层", async () => {
    const { app, workspaceDir } = await startApp();
    const { workspace } = await callMethod(app, "workspace.create", { cwd: workspaceDir.path });
    const { conversation } = await callMethod(app, "conversation.create", {
      workspaceId: workspace.id,
      agentId: "default",
      modelId: "test-model",
    });

    const page = await callMethod(app, "message.list", { conversationId: conversation.id });
    expect(page.messages).toEqual([]);
    expect(page.anchor).toBeNull();

    const searched = await callMethod(app, "search.conversations", {
      query: conversation.name,
    });
    expect(searched.hits.map((hit) => hit.conversation.id)).toContain(conversation.id);

    const fullText = await callMethod(app, "search.messages", { query: "没有这段话" });
    expect(fullText.hits).toEqual([]);
    expect(fullText.total).toBe(0);

    const created = await callMethod(app, "credential.create", { note: "另一台设备" });
    expect(created.token.length).toBeGreaterThan(0);
    const listed = await callMethod(app, "credential.list");
    expect(listed.credentials.map((item) => item.id)).toContain(created.credential.id);
    expect(
      (await callMethod(app, "credential.revoke", { credentialId: created.credential.id })).revoked,
    ).toBe(true);
    // 再吊销一次：这次没有真的改动库（R42）
    expect(
      (await callMethod(app, "credential.revoke", { credentialId: created.credential.id })).revoked,
    ).toBe(false);
  });
});
