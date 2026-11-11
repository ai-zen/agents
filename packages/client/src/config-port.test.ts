/**
 * `ConfigPort`（客户端唯一的实现：配置的真相源在服务端）。
 *
 * 验的是「客户端不碰磁盘也能拿到同一份事实」：真 Daemon + 真 socket + 服务端自己的临时目录。
 * 目录作为 `aiZenDir` 注入 Daemon，所以全程不碰 `AI_ZEN_DIR` 这个进程级全局
 * （那个全局是本包刻意不读的，见 `config-port.ts` 的 `RemoteConfigPortDeps.aiZenDir`）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigService,
  Daemon,
  FileSessionStore,
  SessionAgentFactory,
  SessionManager,
  createAgentHandlers,
  createConfigHandlers,
  createSessionHandlers,
  type AgentLike,
  type ServerEvent,
} from "@ai-zen/agents-server";
import type { AgentDefinition } from "@ai-zen/agents-sdk";
import { createRemoteConfigPort } from "./config-port.js";
import { SocketServerClient } from "./socket-server-client.js";
import type { ClientInfo, ServerClient } from "./types.js";

const NOW = "2026-01-01T00:00:00.000Z";

function definitionOf(id: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    name: id,
    messages: [],
    modelId: "some-old-model",
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

// ==================================================================
// 客户端模式：真 Daemon + 真 socket + 服务端自己的临时目录
// ==================================================================

const clientInfo: ClientInfo = { name: "@ai-zen/agents-client", version: "0.0.0-test" };

let dir: string;
let daemon: Daemon | null = null;
let manager: SessionManager | null = null;
let connection: SocketServerClient | null = null;

/**
 * 配置面一个会话都不开，`SessionManager` 只是 `createSessionHandlers` 的必填依赖
 * （`workspace.resolve` 归那个 handler 管）。真被调用到就说明用例跑偏了，所以直接报错。
 */
function unusedAgent(): AgentLike {
  throw new Error("config-port 的用例不该拉起 Agent");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-config-port-remote-"));
  manager = new SessionManager({
    createAgent: async () => unusedAgent(),
    nextSessionId: () => "chat_test",
    storeFor: (workspaceId) =>
      new FileSessionStore({ rootDir: join(dir, "workspaces", workspaceId) }),
  });
});

afterEach(async () => {
  connection?.close();
  connection = null;
  manager?.dispose();
  manager = null;
  if (daemon) {
    await daemon.stop("test teardown");
    daemon = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 造一份最小配置与 Agent 定义。
 *
 * 两个模型：`test-model` 是定义里原本在用的，`alt-model` 是 `setModel` 的目标 ——
 * 只有一个模型就断言不了「modelId 变了」。
 */
function seed(): void {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      endpoints: [{ id: "e", name: "E", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" }],
      models: [
        {
          id: "test-model",
          name: "Test",
          endpointId: "e",
          tokenThresholds: { handoff: 1, guard: 2 },
          custom: true,
        },
        {
          id: "alt-model",
          name: "Alt",
          endpointId: "e",
          tokenThresholds: { handoff: 1, guard: 2 },
          custom: true,
        },
      ],
      defaultAgent: "default",
      version: 4,
    }),
  );
  writeFileSync(
    join(dir, "agents", "default.json"),
    JSON.stringify({
      id: "default",
      name: "默认",
      modelId: "test-model",
      // 换模型要清掉的正是它
      modelParams: { thinking: { type: "disabled" } },
      messages: [],
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

async function start(): Promise<void> {
  seed();
  const factory = new SessionAgentFactory({ aiZenDir: dir, homeDir: dir });
  const configService = new ConfigService({
    configFile: join(dir, "config.json"),
    agentsDir: join(dir, "agents"),
    subAgentsDir: join(dir, "sub-agents"),
    globalMcpFile: join(dir, "mcp.json"),
    workspacesRoot: join(dir, "workspaces"),
  });

  daemon = new Daemon({
    aiZenDir: dir,
    port: 0,
    version: "0.0.0-test",
    handlers: {
      ...createSessionHandlers({
        manager: manager!,
        workspacesRoot: join(dir, "workspaces"),
        // 客户端**不给** path 时服务端落在这个目录上：项目作用域的 mcp.json 就在它下面
        defaultWorkspacePath: dir,
      }),
      ...createAgentHandlers({ factory, config: configService }),
      ...createConfigHandlers({ config: configService }),
    },
  });
  await daemon.start();
  connection = await SocketServerClient.connect({
    address: { host: "127.0.0.1", port: daemon.port },
    client: clientInfo,
  });
}

describe("createRemoteConfigPort：客户端模式（配置落在服务端）", () => {
  it("readConfig / saveConfig：改一个字段写回，读回来是新的", async () => {
    await start();
    const port = createRemoteConfigPort({ client: connection! });

    const before = await port.readConfig();
    expect(before.models.map((model) => model.id)).toEqual(["test-model", "alt-model"]);

    await port.saveConfig({ ...before, maxToolOutput: 4242 });

    expect((await port.readConfig()).maxToolOutput).toBe(4242);
    // 落盘发生在**服务端**那个目录里（客户端进程一个字节都没写）
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")) as {
      maxToolOutput?: number;
    };
    expect(onDisk.maxToolOutput).toBe(4242);
  });

  it("readMcpConfig / writeMcpConfig（project）：工作区由服务端解析，文件落在工作区里", async () => {
    await start();
    // 项目作用域的路径来源：生产里是「本地就取客户端 cwd」，这里指到临时目录
    // （不然这用例会往真实工作区写 mcp.json）
    const port = createRemoteConfigPort({ client: connection!, workspacePath: () => dir });

    // 没有文件时是空配置；project 作用域要的 workspaceId 由服务端按这个路径解析。
    // 结果里的 `path` 是**服务端**认的那个文件（编辑屏要印它，客户端算不出来）
    expect(await port.readMcpConfig("project")).toEqual({
      ok: true,
      config: { mcpServers: {} },
      path: join(dir, ".ai-zen", "mcp.json"),
    });

    const mcpConfig = { mcpServers: { demo: { command: "echo", args: ["hi"] } } };
    await port.writeMcpConfig(mcpConfig, "project");
    expect(await port.readMcpConfig("project")).toEqual({
      ok: true,
      config: mcpConfig,
      path: join(dir, ".ai-zen", "mcp.json"),
    });

    // 项目级 mcp.json 的位置是 `<工作区>/.ai-zen/mcp.json`，而工作区 = 服务端的目录
    expect(existsSync(join(dir, ".ai-zen", "mcp.json"))).toBe(true);
  });

  it("readAgentStore / save：定义真的写进了服务端的定义目录", async () => {
    await start();
    const port = createRemoteConfigPort({ client: connection! });

    const store = await port.readAgentStore();
    expect(store.agents.map((def) => def.id)).toEqual(["default"]);
    expect(store.subAgents).toEqual([]);

    await store.save("agent", definitionOf("remote-agent", { name: "Remote Agent" }));

    expect(existsSync(join(dir, "agents", "remote-agent.json"))).toBe(true);
    // 快照重新从服务端读：列表不是上一次 list 的残留
    expect((await port.readAgentStore()).agents.map((def) => def.id).sort()).toEqual([
      "default",
      "remote-agent",
    ]);
  });

  it("setDefaultModel：只写 config.json 的 defaultModel，模型清单一个不动", async () => {
    await start();
    const port = createRemoteConfigPort({ client: connection! });
    const before = await port.readConfig();

    await port.setDefaultModel("alt-model");

    const after = await port.readConfig();
    expect(after.defaultModel).toBe("alt-model");
    // 窄方法的意义：模型 / 端点这些字段不被「整份写回」碰一遍
    expect(after.models).toEqual(before.models);
    expect(after.endpoints).toEqual(before.endpoints);
    // 写的是服务端那份 config.json（客户端的磁盘一个字都没改）
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")) as {
      defaultModel?: string;
    };
    expect(onDisk.defaultModel).toBe("alt-model");
  });

  it("setModel：modelId 变了，modelParams 被清空（换模型即重置思考强度的回归保护）", async () => {
    await start();
    const port = createRemoteConfigPort({ client: connection! });

    await port.setModel("default", "alt-model");

    // 从服务端重新读一遍定义（不是拿本地拼的那份）
    const def = (await port.readAgentStore()).agents.find((item) => item.id === "default")!;
    expect(def.modelId).toBe("alt-model");
    expect(def).not.toHaveProperty("modelParams");

    // 盘上那份也是：换模型写的是 Agent 定义，不是会话
    const onDisk = JSON.parse(readFileSync(join(dir, "agents", "default.json"), "utf-8")) as {
      modelId?: string;
      modelParams?: unknown;
    };
    expect(onDisk.modelId).toBe("alt-model");
    expect(onDisk.modelParams).toBeUndefined();
  });
});

// ==================================================================
// 连接策略：懒连接、复用、断后重建、项目作用域不带路径
// ==================================================================

/** 一条记下「调了什么」的假连接：验的是端口的连接策略，不是服务端 */
interface RecordedCall {
  method: string;
  params?: unknown;
}

function fakeClient(calls: RecordedCall[]): ServerClient & { closed: boolean } {
  const client = {
    address: { host: "127.0.0.1", port: 0 },
    closed: false,
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      switch (method) {
        case "config.get":
          return { config: { endpoints: [], models: [] } } as T;
        case "config.reasoningPresets":
          return { presets: {} } as T;
        case "config.mcp.get":
          return { ok: true, config: { mcpServers: {} } } as T;
        case "workspace.resolve":
          return { workspaceId: "ws_fake", path: "/srv/proj" } as T;
        case "agent.list":
          return { agents: [], subAgents: [] } as T;
        default:
          return { saved: true } as T;
      }
    },
    on<E extends ServerEvent["event"]>(
      _event: E,
      _listener: (payload: Extract<ServerEvent, { event: E }>) => void,
    ): () => void {
      return () => {};
    },
    close(): void {
      client.closed = true;
    },
    onClose(): () => void {
      // 配置面不用断开通知；给了是为了满足端口（真要重连由会话层负责）
      return () => {};
    },
  };
  return client;
}

describe("createRemoteConfigPort：连接的懒建与重建（注入假连接）", () => {
  it("构造时不连；第一次调用才建，之后复用同一条", async () => {
    const calls: RecordedCall[] = [];
    let connects = 0;
    const port = createRemoteConfigPort({
      connect: async () => {
        connects += 1;
        return fakeClient(calls);
      },
    });

    // 构造完一个连接都还没建：配置面可能在会话之前就要用，那时也不该白连一条
    expect(connects).toBe(0);

    const config = await port.readConfig();
    expect(connects).toBe(1);
    await port.saveConfig(config);
    await port.setModel("default", "m");
    await port.setDefaultModel("m");
    await port.readAgentStore();

    expect(connects).toBe(1);
    // 两档模型写入各走各的线上方法名：定义级 `agent.model.set`、全局兜底
    // `config.defaultModel.set`（字面量只有协议里那一份，这里顺带钉住）。
    // 会话级那一档（`session.model.set`）**不在这个门面上** —— 它的作用对象是一段会话，
    // 归 `RemoteSessions.modelSet`。
    expect(calls.map((call) => call.method)).toEqual([
      "config.get",
      "config.save",
      "agent.model.set",
      "config.defaultModel.set",
      "agent.list",
    ]);
    expect(calls[3]!.params).toEqual({ modelId: "m" });
  });

  it("连接已关闭 → 下一次调用重建一条（服务端可以随时重启）", async () => {
    const first: RecordedCall[] = [];
    const second: RecordedCall[] = [];
    const clients: Array<ServerClient & { closed: boolean }> = [];
    let connects = 0;
    const port = createRemoteConfigPort({
      connect: async () => {
        connects += 1;
        const client = fakeClient(connects === 1 ? first : second);
        clients.push(client);
        return client;
      },
    });

    await port.readConfig();
    expect(connects).toBe(1);

    clients[0]!.closed = true;
    await port.readConfig();

    expect(connects).toBe(2);
    expect(second.map((call) => call.method)).toEqual(["config.get"]);
  });

  it("project 作用域：把客户端 cwd 递给服务端，问一次就缓存", async () => {
    const calls: RecordedCall[] = [];
    const port = createRemoteConfigPort({
      connect: async () => fakeClient(calls),
      workspacePath: () => "/work/proj",
    });

    await port.readMcpConfig("project");
    await port.writeMcpConfig({ mcpServers: {} }, "project");

    const resolves = calls.filter((call) => call.method === "workspace.resolve");
    expect(resolves).toHaveLength(1);
    // 与开会话同一套判据：本地就把 cwd 递上去，远端才不说（见 `local-host.ts`）
    expect(resolves[0]!.params).toEqual({ path: "/work/proj" });

    expect(calls.filter((call) => call.method === "config.mcp.get")[0]!.params).toEqual({
      scope: "project",
      workspaceId: "ws_fake",
    });
    expect(calls.filter((call) => call.method === "config.mcp.save")[0]!.params).toMatchObject({
      scope: "project",
      workspaceId: "ws_fake",
    });
  });

  it("global 作用域不问工作区（多一次往返，也多一个会漂的答案）", async () => {
    const calls: RecordedCall[] = [];
    const port = createRemoteConfigPort({
      connect: async () => fakeClient(calls),
    });

    await port.readMcpConfig("global");

    expect(calls.map((call) => call.method)).toEqual(["config.mcp.get"]);
    expect(calls[0]!.params).toEqual({ scope: "global" });
  });
});
