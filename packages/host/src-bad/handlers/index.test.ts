/**
 * `createHandlers` 的验收：整张表长什么样、哪些方法还没注册、两个「只转发」的域接得对不对。
 *
 * 这里走的是单根造出来的真服务（真库、真服务层），只是省掉网络这一层直接调 handler 表；
 * 需要看「未注册的方法回什么」时才开一条真 WebSocket —— 那个答案由接线层给。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHost } from "../app.js";
import type { HostApp } from "../app.js";
import type { ConnectionInfo } from "../net/index.js";
import { isError, makeTempDir, TestClient, type TempDir } from "../net/TestSupport.js";
import { METHOD_NAMES } from "../wire/index.js";
import type { SessionView, MethodName, MethodParams, MethodResult } from "../wire/index.js";
import { BRIDGED_METHODS, createHandlers } from "./index.js";

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
const apps: HostApp[] = [];
const clients: TestClient[] = [];

async function makeTemp(prefix: string): Promise<TempDir> {
  const dir = await makeTempDir(prefix);
  temps.push(dir);
  return dir;
}

async function startApp(): Promise<{ app: HostApp; workspaceDir: TempDir }> {
  const dataRoot = await makeTemp("ai-zen-handlers-");
  await fs.mkdir(join(dataRoot.path, "agents"), { recursive: true });
  await fs.writeFile(join(dataRoot.path, "config.json"), CONFIG, "utf8");
  await fs.writeFile(join(dataRoot.path, "agents", "default.json"), AGENT, "utf8");
  const workspaceDir = await makeTemp("ai-zen-handlers-cwd-");
  const app = await createHost({
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

/**
 * 建一段会话并让它落库（R56：`session.create` 只发 id，首次 `send` 才写 `sessions` 行）。
 *
 * 这里的用例要看的是别的东西（列表、搜索结果、项目删除），所以直接把草稿落成真行。
 */
async function seedSession(app: HostApp, workspaceId: string): Promise<SessionView> {
  const created = await callMethod(app, "session.create", {
    workspaceId,
    agentId: "default",
    modelId: "test-model",
  });
  if (!created.session) throw new Error("session.create 没有建出会话");
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
    for (const method of BRIDGED_METHODS) {
      expect(app.handlers[method]).toBeUndefined();
    }
    // 名单就是那四条，不多不少
    expect([...BRIDGED_METHODS].sort()).toEqual([
      "asset.begin",
      "asset.end",
      "host.hello",
      "host.setLanguage",
    ]);
  });

  /**
   * 契约全表覆盖：`MethodMap` 里的每个方法名都必须有归宿。
   *
   * 归宿只有两种：在这张 handler 表里，或者在接线层代管的那四条名单里。
   * 漏一个就红 —— 这条用例是为了防「加了契约忘了实现」：那种情况下客户端拿到的是
   * `unsupported`，而那是「这个宿主没这个功能」的意思，不该用来掩盖「没接上」。
   */
  it("契约里的每个方法要么在 handler 表里，要么在桥接名单里", async () => {
    const { app } = await startApp();
    const registered = new Set(Object.keys(app.handlers));

    const homeless = METHOD_NAMES.filter(
      (method) => !registered.has(method) && !BRIDGED_METHODS.includes(method),
    );
    expect(homeless).toEqual([]);

    // 反过来也要成立：桥接名单里的方法不该又在这张表里注册一份（那样就有两处实现）
    for (const method of BRIDGED_METHODS) expect(registered.has(method)).toBe(false);
    // 表里不能有契约之外的名字
    for (const method of registered) expect(METHOD_NAMES).toContain(method);
  });

  it("契约之外的方法名才是 unsupported（R11）", async () => {
    const { app } = await startApp();
    const target = app.address;
    const client = await TestClient.connect(`ws://127.0.0.1:${target?.port ?? 0}/`);
    clients.push(client);
    const token = (await fs.readFile(app.paths.tokenFile, "utf8")).trim();
    await client.hello(token);

    for (const method of ["nope.nothing", "session.explode"]) {
      client.request(method, {});
      const frame = await client.queue.next();
      expect(isError(frame)).toBe(true);
      if (isError(frame)) {
        expect(frame.error.data.code).toBe("unsupported");
        expect(frame.error.data.detail).toMatchObject({ reason: "unknown_method" });
      }
    }
  });
});

describe("只转发的两个域", () => {
  it("message.list / search.* 都接到服务层", async () => {
    const { app, workspaceDir } = await startApp();
    const { workspace } = await callMethod(app, "workspace.create", { cwd: workspaceDir.path });
    const session = await seedSession(app, workspace.id);

    const page = await callMethod(app, "message.list", { sessionId: session.id });
    expect(page.messages).toEqual([]);
    expect(page.anchor).toBeNull();

    const searched = await callMethod(app, "search.sessions", {
      query: session.name,
    });
    expect(searched.hits.map((hit) => hit.session.id)).toContain(session.id);

    const fullText = await callMethod(app, "search.messages", { query: "没有这段话" });
    expect(fullText.hits).toEqual([]);
    expect(fullText.total).toBe(0);
  });
});
