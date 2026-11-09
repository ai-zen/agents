/**
 * 配置处理器 —— 直接调方法表，不建 socket。
 *
 * 为什么不用真 socket（`sessionHandlers.test.ts` 用了）：那边要证明的东西是「事件能从
 * 服务端推过连接」，非走 socket 不可；而这一层只做「校验 + 转调」，帧的事已经由
 * `Daemon.test.ts` 覆盖过了。这里要钉的是三件事：
 *
 *   1. 线上 `unknown` 被按形状验过（缺字段/类型不对 → `bad-params`）；
 *   2. 验过之后原样进了服务层（不丢字段、不多加默认值）；
 *   3. 「坏文件」是**结果**不是**异常**（编辑屏要靠它显示原因）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "@ai-zen/agents-sdk";
import type { Connection, MethodHandler } from "./Daemon.js";
import { createConfigHandlers } from "./configHandlers.js";
import { ConfigService } from "../service/config/ConfigService.js";
import { CONFIG_METHODS } from "../protocol/config.js";
import { ensureWorkspace } from "../service/workspace/workspace.js";

let root: string;
let workspacesRoot: string;
let service: ConfigService;
let handlers: Record<string, MethodHandler>;

/** 配置面不用连接（没有事件），给一个空实现满足签名 */
const connection: Connection = {
  id: 1,
  send: () => {},
  close: () => {},
  onClose: () => () => {},
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aiz-config-handlers-"));
  workspacesRoot = join(root, "workspaces");
  service = new ConfigService({
    configFile: join(root, "config.json"),
    agentsDir: join(root, "agents"),
    subAgentsDir: join(root, "sub-agents"),
    globalMcpFile: join(root, "mcp.json"),
    workspacesRoot,
  });
  handlers = createConfigHandlers({ config: service });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 调一个方法（把「方法必须在表里」这件事也一起断言掉） */
async function call(method: string, params?: unknown): Promise<unknown> {
  const handler = handlers[method];
  expect(handler, `method not registered: ${method}`).toBeTypeOf("function");
  return await handler(params, connection);
}

describe("config.get / config.save", () => {
  it("config.get 回出厂默认配置", async () => {
    const result = (await call(CONFIG_METHODS.get)) as { config: AppConfig };
    expect(result.config.models.length).toBeGreaterThan(0);
  });

  it("config.save 落盘后 config.get 读得回来", async () => {
    const current = ((await call(CONFIG_METHODS.get)) as { config: AppConfig }).config;

    await expect(
      call(CONFIG_METHODS.save, { config: { ...current, maxToolOutput: 777 } }),
    ).resolves.toEqual({ saved: true });

    const after = ((await call(CONFIG_METHODS.get)) as { config: AppConfig }).config;
    expect(after.maxToolOutput).toBe(777);
    expect(() => statSync(join(root, "config.json"))).not.toThrow();
  });

  it("config.save 缺 config / 传数组或字符串 → bad-params", async () => {
    await expect(call(CONFIG_METHODS.save, {})).rejects.toMatchObject({ code: "bad-params" });
    await expect(call(CONFIG_METHODS.save, { config: [] })).rejects.toMatchObject({
      code: "bad-params",
    });
    await expect(call(CONFIG_METHODS.save, { config: "{}" })).rejects.toMatchObject({
      code: "bad-params",
    });
    // 没写出任何文件
    expect(() => statSync(join(root, "config.json"))).toThrow();
  });
});

describe("config.reasoningPresets", () => {
  it("回出厂策略表", async () => {
    const result = (await call(CONFIG_METHODS.reasoningPresets)) as { presets: object };
    expect(Object.keys(result.presets)).toContain("openai");
  });
});

describe("config.defaultAgent.set", () => {
  it("只改 defaultAgent：其余字段原样保留，回写入后的 id", async () => {
    const current = ((await call(CONFIG_METHODS.get)) as { config: AppConfig }).config;
    const before = {
      models: current.models,
      endpoints: current.endpoints,
      maxToolOutput: current.maxToolOutput,
    };

    await expect(call(CONFIG_METHODS.defaultAgentSet, { agentId: "coder" })).resolves.toEqual({
      agentId: "coder",
    });

    const after = ((await call(CONFIG_METHODS.get)) as { config: AppConfig }).config;
    expect(after.defaultAgent).toBe("coder");
    // 窄方法的全部意义：别的字段一个都不动（整份写回会抹掉并发修改）
    expect({ models: after.models, endpoints: after.endpoints }).toEqual({
      models: before.models,
      endpoints: before.endpoints,
    });
  });

  it("缺 agentId / 空串 → bad-params", async () => {
    await expect(call(CONFIG_METHODS.defaultAgentSet, {})).rejects.toMatchObject({
      code: "bad-params",
    });
    await expect(call(CONFIG_METHODS.defaultAgentSet, { agentId: "" })).rejects.toMatchObject({
      code: "bad-params",
    });
  });
});

describe("config.mcp.get / config.mcp.save", () => {
  it("缺 scope 或取值不认识 → bad-params（不替客户端猜 global）", async () => {
    await expect(call(CONFIG_METHODS.mcpGet, {})).rejects.toMatchObject({ code: "bad-params" });
    await expect(call(CONFIG_METHODS.mcpGet, { scope: "workspace" })).rejects.toMatchObject({
      code: "bad-params",
    });
    await expect(call(CONFIG_METHODS.mcpSave, { scope: "global" })).rejects.toMatchObject({
      code: "bad-params",
    });
  });

  it("project 作用域缺 workspaceId → 服务层的 workspace-required 原样上来（本层只验形状）", async () => {
    await expect(call(CONFIG_METHODS.mcpGet, { scope: "project" })).rejects.toMatchObject({
      code: "workspace-required",
    });
  });

  it("坏文件是结果不是异常：ok:false 帧交给编辑屏", async () => {
    writeFileSync(join(root, "mcp.json"), "{oops", "utf-8");

    const result = (await call(CONFIG_METHODS.mcpGet, { scope: "global" })) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error?.length).toBeGreaterThan(0);
  });

  it("global 往返", async () => {
    const config = { mcpServers: { pty: { command: "npx" } } };

    await expect(call(CONFIG_METHODS.mcpSave, { scope: "global", config })).resolves.toEqual({
      saved: true,
    });
    await expect(call(CONFIG_METHODS.mcpGet, { scope: "global" })).resolves.toEqual({
      ok: true,
      config,
    });
  });

  it("project 往返：workspaceId 原样透传，文件落在工作区里", async () => {
    const projectPath = join(root, "proj-a");
    mkdirSync(projectPath, { recursive: true });
    const workspace = await ensureWorkspace({ workspacesRoot, path: projectPath });
    const config = { mcpServers: { local: { command: "node" } } };

    await call(CONFIG_METHODS.mcpSave, {
      scope: "project",
      workspaceId: workspace.id,
      config,
    });

    expect(() => statSync(join(projectPath, ".ai-zen", "mcp.json"))).not.toThrow();
    await expect(
      call(CONFIG_METHODS.mcpGet, { scope: "project", workspaceId: workspace.id }),
    ).resolves.toEqual({ ok: true, config });
  });
});
