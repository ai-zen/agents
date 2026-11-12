/**
 * `server.*` 的验收：版本与能力清单报的是事实、三个范围的用量口径、收尾请求走单根。
 *
 * `server.hello` / `server.setLanguage` 由接线层接管（语言是连接状态），不在这里验。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../app.js";
import type { ExitFacts, ServerApp } from "../app.js";
import type { ConnectionInfo } from "../net/index.js";
import { makeTempDir, wait, type TempDir } from "../net/TestSupport.js";
import { FakeAgent } from "../runtime/TestSupport.js";
import { PROTOCOL_VERSION } from "../wire/index.js";
import type { MethodName, MethodParams, MethodResult } from "../wire/index.js";

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

interface Harness {
  app: ServerApp;
  workspaceDir: TempDir;
  workspaceId: string;
  conversationId: string;
  exits: ExitFacts[];
}

const temps: TempDir[] = [];
const apps: ServerApp[] = [];

async function makeTemp(prefix: string): Promise<TempDir> {
  const dir = await makeTempDir(prefix);
  temps.push(dir);
  return dir;
}

async function makeHarness(): Promise<Harness> {
  const dataRoot = await makeTemp("ai-zen-server-handlers-");
  await fs.mkdir(join(dataRoot.path, "agents"), { recursive: true });
  await fs.writeFile(join(dataRoot.path, "config.json"), CONFIG, "utf8");
  await fs.writeFile(join(dataRoot.path, "agents", "default.json"), AGENT, "utf8");
  const workspaceDir = await makeTemp("ai-zen-server-handlers-cwd-");
  const exits: ExitFacts[] = [];

  const app = await createServer({
    aiZenDir: dataRoot.path,
    port: 0,
    local: true,
    createAgent: async () =>
      new FakeAgent([
        { deltas: [{ content: "好。" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ]),
    exit: (facts) => {
      exits.push(facts);
    },
    logger: { warn: () => undefined, error: () => undefined },
  });
  await app.start();
  apps.push(app);

  const { workspace } = await callMethod(app, "workspace.create", { cwd: workspaceDir.path });
  const { conversation } = await callMethod(app, "conversation.create", {
    workspaceId: workspace.id,
    agentId: "default",
    modelId: "test-model",
  });
  return {
    app,
    workspaceDir,
    workspaceId: workspace.id,
    conversationId: conversation.id,
    exits,
  };
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

/** 跑一轮，让库里真的有用量可求和 */
async function runOnce(app: ServerApp, conversationId: string): Promise<void> {
  await callMethod(app, "conversation.send", { conversationId, input: { content: "你好" } });
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

describe("server.version / server.capabilities", () => {
  it("报的是进程事实，不是猜的", async () => {
    const { app } = await makeHarness();
    const version = await callMethod(app, "server.version");
    expect(version.version).toBe(app.version);
    expect(version.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(version.startedAt).toBe(app.startedAt);
    expect(version.pid).toBe(process.pid);

    const capabilities = await callMethod(app, "server.capabilities");
    expect(capabilities.capabilities).toEqual([]);
  });
});

describe("server.usage", () => {
  it("三个范围各算各的：对话 / 项目 / 整机（F-I5）", async () => {
    const { app, conversationId, workspaceId } = await makeHarness();

    // 还没有消息：三个范围都是零值，不是错误
    const empty = await callMethod(app, "server.usage", { conversationId });
    expect(empty.scope).toBe("conversation");
    expect(empty.usage.total.total_tokens).toBe(0);

    await runOnce(app, conversationId);

    const byConversation = await callMethod(app, "server.usage", { conversationId });
    expect(byConversation.usage.total.total_tokens).toBe(15);

    const byWorkspace = await callMethod(app, "server.usage", { workspaceId });
    expect(byWorkspace.scope).toBe("workspace");
    expect(byWorkspace.usage.total.total_tokens).toBe(15);

    const whole = await callMethod(app, "server.usage");
    expect(whole.scope).toBe("server");
    expect(whole.usage.total.total_tokens).toBe(15);
  });
});

describe("server.shutdown", () => {
  it("先回「受理了」，再把收尾交给单根（L4）", async () => {
    const { app, exits } = await makeHarness();

    const accepted = await callMethod(app, "server.shutdown");
    expect(accepted.accepted).toBe(true);
    // 收尾排在下一轮事件循环：回包先写完
    await wait(50);

    expect(exits).toHaveLength(1);
    expect(exits[0]?.reason).toBe("requested");
    expect(app.running).toBe(false);
  });
});
