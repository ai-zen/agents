/**
 * `host.*` 的验收：版本与能力清单报的是事实、收尾请求走单根。
 *
 * `host.hello` / `host.setLanguage` 由接线层接管（语言是连接状态），不在这里验。
 * `host.usage` 已从契约面删除（裁定 2026-11-13，F-I5 的落点是 `conversation.state`），
 * 它的用例也一起删了。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHost } from "../app.js";
import type { ExitFacts, HostApp } from "../app.js";
import type { ConnectionInfo } from "../net/index.js";
import { makeTempDir, wait, type TempDir } from "../net/TestSupport.js";
import { FakeAgent } from "../runtime/TestSupport.js";
import { METHOD_NAMES, PROTOCOL_VERSION } from "../wire/index.js";
import type {
  ConversationView,
  MethodName,
  MethodParams,
  MethodResult,
} from "../wire/index.js";

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
  app: HostApp;
  workspaceDir: TempDir;
  workspaceId: string;
  conversationId: string;
  exits: ExitFacts[];
}

const temps: TempDir[] = [];
const apps: HostApp[] = [];

async function makeTemp(prefix: string): Promise<TempDir> {
  const dir = await makeTempDir(prefix);
  temps.push(dir);
  return dir;
}

async function makeHarness(): Promise<Harness> {
  const dataRoot = await makeTemp("ai-zen-host-handlers-");
  await fs.mkdir(join(dataRoot.path, "agents"), { recursive: true });
  await fs.writeFile(join(dataRoot.path, "config.json"), CONFIG, "utf8");
  await fs.writeFile(join(dataRoot.path, "agents", "default.json"), AGENT, "utf8");
  const workspaceDir = await makeTemp("ai-zen-host-handlers-cwd-");
  const exits: ExitFacts[] = [];

  const app = await createHost({
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
  const conversation = await seedConversation(app, workspace.id);
  return {
    app,
    workspaceDir,
    workspaceId: workspace.id,
    conversationId: conversation.id,
    exits,
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

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop("requested").catch(() => undefined);
  for (const temp of temps.splice(0)) await temp.remove();
});

describe("host.version / host.capabilities", () => {
  it("报的是进程事实，不是猜的", async () => {
    const { app } = await makeHarness();
    const version = await callMethod(app, "host.version");
    expect(version.version).toBe(app.version);
    expect(version.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(version.startedAt).toBe(app.startedAt);
    expect(version.pid).toBe(process.pid);

    // 能力清单是真的那一份：契约里每个方法一条，带 PRD 编号与本地化好的标题（F-E5 / R6）
    const capabilities = await callMethod(app, "host.capabilities");
    expect(capabilities.capabilities.length).toBe(METHOD_NAMES.length);
    const send = capabilities.capabilities.find((item) => item.method === "conversation.send");
    expect(send).toMatchObject({ id: "F-C2", blocking: true, destructive: false });
    expect(send?.title.message.length).toBeGreaterThan(0);
  });
});

describe("host.shutdown", () => {
  it("先回「受理了」，再把收尾交给单根（L4）", async () => {
    const { app, exits } = await makeHarness();

    const accepted = await callMethod(app, "host.shutdown");
    expect(accepted.accepted).toBe(true);
    // 收尾排在下一轮事件循环：回包先写完
    await wait(50);

    expect(exits).toHaveLength(1);
    expect(exits[0]?.reason).toBe("requested");
    expect(app.running).toBe(false);
  });
});
