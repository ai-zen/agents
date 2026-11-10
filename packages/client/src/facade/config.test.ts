/**
 * `RemoteConfig` 的端到端用例：真 socket + 真 Daemon + 服务端自己的临时目录。
 *
 * ## 为什么这一组值得存在（而不是"覆盖到了就行"）
 *
 * 门面不全的病根是「前端裸调协议」：补齐方法只是第一步，还得证明它们**真的**
 * 打到服务端对应的 handler 上。方法名写错、参数拼错在类型层面是查不出来的（`call` 的
 * 参数是 `unknown`），而在运行期就是一个「看起来成功、其实什么也没改」的失败 —— 所以每条
 * 都验「服务端侧真的变了」。
 *
 * 目录作为 `aiZenDir` 注入 Daemon：全程不碰 `AI_ZEN_DIR` 这个进程级全局（本包刻意不读它）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssetService,
  ConfigService,
  Daemon,
  FileSessionStore,
  SessionAgentFactory,
  SessionManager,
  createAgentHandlers,
  createAssetHandlers,
  createConfigHandlers,
  createSessionHandlers,
  type AgentLike,
} from "@ai-zen/agents-server";
import type { AgentDefinition } from "@ai-zen/agents-sdk";
import { SocketServerClient } from "../socket-server-client.js";
import type { ClientInfo } from "../types.js";
import { RemoteConfig } from "./config.js";

const clientInfo: ClientInfo = { name: "@ai-zen/agents-client", version: "0.0.0-test" };
const NOW = "2026-01-01T00:00:00.000Z";

function definitionOf(id: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    name: id,
    messages: [],
    modelId: "test-model",
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

let dir: string;
let daemon: Daemon | null = null;
let manager: SessionManager | null = null;
let connection: SocketServerClient | null = null;
let config: RemoteConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-remote-config-"));
  mkdirSync(join(dir, "proj"), { recursive: true });
  manager = new SessionManager({
    // 配置面的用例一段会话都不开（`registerHolder` 之类不参与）
    createAgent: async () => {
      throw new Error("RemoteConfig 的用例不该拉起 Agent");
    },
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

/** 造一份最小配置 + 一个 Agent 定义（换模型要清掉的思考参数就写在里面） */
function seed(): void {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      endpoints: [{ id: "e", name: "E", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" }],
      models: [
        { id: "test-model", name: "Test", endpointId: "e", custom: true },
        { id: "alt-model", name: "Alt", endpointId: "e", custom: true },
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
        defaultWorkspacePath: join(dir, "proj"),
      }),
      ...createAgentHandlers({
        factory: new SessionAgentFactory({ aiZenDir: dir, homeDir: dir }),
        config: configService,
      }),
      ...createConfigHandlers({ config: configService }),
      ...createAssetHandlers({
        service: new AssetService({
          aiZenDir: dir,
          homeDir: dir,
          workspacesRoot: join(dir, "workspaces"),
        }),
      }),
    },
  });
  await daemon.start();
  connection = await SocketServerClient.connect({
    address: { host: "127.0.0.1", port: daemon.port },
    client: clientInfo,
  });
  config = new RemoteConfig(connection);
}

describe("RemoteConfig：全局配置（config.*）", () => {
  it("get 带回配置与它**在服务端**的路径；save 整份写回", async () => {
    await start();

    const read = await config.get();
    expect((read.config as { defaultAgent?: string }).defaultAgent).toBe("default");
    // 路径是服务端的磁盘事实：客户端那份 `~/.ai-zen/config.json` 与它不是一个文件
    expect(read.path).toBe(join(dir, "config.json"));

    await config.save({ ...(read.config as object), maxToolOutput: 4242 });
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")) as {
      maxToolOutput?: number;
    };
    expect(onDisk.maxToolOutput).toBe(4242);
  });

  it("reasoningPresets 走服务端（文件缺失时由 SDK 回落出厂种子，不是空对象）", async () => {
    await start();

    const presets = (await config.reasoningPresets()).presets as Record<string, unknown>;
    expect(Object.keys(presets).length).toBeGreaterThan(0);
  });

  it("defaultAgentSet / defaultModelSet：两个窄方法各只写一个字段", async () => {
    await start();

    await config.defaultAgentSet("writer");
    await config.defaultModelSet("alt-model");

    const after = (await config.get()).config as {
      defaultAgent?: string;
      defaultModel?: string;
      models: unknown[];
    };
    expect(after.defaultAgent).toBe("writer");
    expect(after.defaultModel).toBe("alt-model");
    // 窄方法的意义：模型 / 端点这些字段不被「整份写回」碰一遍
    expect(after.models).toHaveLength(2);
  });

  it("mcpGet / mcpSave：global 不带工作区，project 必须带（漏参数是 `workspace-required`）", async () => {
    await start();
    const workspace = await config.get(); // 顺手确认这条连接是通的
    expect(workspace.path).toBe(join(dir, "config.json"));

    expect(await config.mcpGet({ scope: "global" })).toEqual({
      ok: true,
      config: { mcpServers: {} },
      path: join(dir, "mcp.json"),
    });

    const mcpConfig = { mcpServers: { demo: { command: "echo", args: ["hi"] } } };
    await config.mcpSave({ scope: "global", config: mcpConfig });
    expect(await config.mcpGet({ scope: "global" })).toMatchObject({ ok: true, config: mcpConfig });
    expect(existsSync(join(dir, "mcp.json"))).toBe(true);

    // project 作用域要 workspaceId：门面只搬参数，「当前工作区」由调用方解析
    await expect(config.mcpGet({ scope: "project" })).rejects.toThrow(/workspace-required/);
  });
});

describe("RemoteConfig：Agent 定义（agent.*）", () => {
  it("agentList / agentGet / agentSave / agentRemove", async () => {
    await start();

    expect((await config.agentList()).agents.map((agent) => (agent as { id: string }).id)).toEqual([
      "default",
    ]);
    expect(((await config.agentGet({ id: "default" })).agent as { id?: string }).id).toBe(
      "default",
    );
    // 不存在回 `null`，不是错误（客户端要能区分「没这个 Agent」与「读失败」）
    expect((await config.agentGet({ id: "nope" })).agent).toBeNull();

    await config.agentSave({ kind: "agent", definition: definitionOf("writer") });
    expect(existsSync(join(dir, "agents", "writer.json"))).toBe(true);
    expect((await config.agentList()).agents).toHaveLength(2);

    expect(await config.agentRemove({ kind: "agent", id: "writer" })).toEqual({ removed: true });
    // 幂等：本来就没有
    expect(await config.agentRemove({ kind: "agent", id: "writer" })).toEqual({ removed: false });
  });

  it("agentSetModel：modelId 变了、思考参数被清空（换模型即重置思考强度的回归保护）", async () => {
    await start();

    expect(await config.agentSetModel("default", "alt-model")).toEqual({
      agentId: "default",
      modelId: "alt-model",
    });

    const onDisk = JSON.parse(readFileSync(join(dir, "agents", "default.json"), "utf-8")) as {
      modelId?: string;
      modelParams?: unknown;
    };
    expect(onDisk.modelId).toBe("alt-model");
    expect(onDisk.modelParams).toBeUndefined();
  });
});

describe("RemoteConfig：资产（asset.*）", () => {
  it("assetList 走服务端的发现逻辑（这一版只读；内容由 SDK 的扫描规则决定）", async () => {
    await start();

    // 没有装任何 skill 时是一份**空清单**，不是错误 —— 这与「方法没接上」的区别是后者会抛
    expect(await config.assetList({ kind: "skill" })).toEqual({ assets: [] });
  });
});
