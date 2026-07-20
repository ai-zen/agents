/**
 * MCP 真实服务器端到端测试。
 *
 * 测试 SDK 对真实 MCP 服务器（stdio + sse）的连接、工具发现、工具调用能力。
 *
 * stdio 测试自动运行（无需额外启动）。
 * SSE 测试需要先启动 SSE 服务器：cd packages/test-project && node mcp-servers/sse-server.mjs
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { McpConnectionManager } from "../src/runtime/McpConnectionManager.js";
import type { McpServerConfig } from "../src/types/index.js";

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------
const PROJECT_DIR = join(__dirname, "..", "..", "test-project");
const STDIO_SERVER = join(PROJECT_DIR, "mcp-servers", "stdio-server.mjs");

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const stdioConfig: McpServerConfig = {
  id: "test-stdio",
  transport: "stdio",
  command: "node",
  args: [STDIO_SERVER],
};

const sseConfig: McpServerConfig = {
  id: "test-sse",
  transport: "sse",
  url: "http://127.0.0.1:9876/sse",
};

// 检查 SSE 服务器是否可用
let sseAvailable = false;

async function checkSseAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch("http://127.0.0.1:9876/sse", {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("MCP 真实服务器 — stdio", () => {
  let manager: McpConnectionManager;

  beforeAll(() => {
    manager = new McpConnectionManager();
  });

  afterAll(async () => {
    await manager.disconnectAll();
  });

  it("连接 stdio 服务器并发现工具", async () => {
    const manifest = await manager.connect("test-stdio", stdioConfig);

    expect(manager.getState("test-stdio")).toBe("connected");
    expect(manifest.tools.length).toBeGreaterThanOrEqual(2);

    const toolNames = manifest.tools.map((t) => t.name);
    expect(toolNames).toContain("greet");
    expect(toolNames).toContain("multiply");
  });

  it("调用 greet 工具", async () => {
    const client = manager.getClient("test-stdio");
    expect(client).toBeDefined();

    const result = await client!.callTool({
      name: "greet",
      arguments: { name: "测试" },
    });

    const content = (result as any).content ?? [];
    const text = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    expect(text).toBe("你好，测试！");
  });

  it("调用 multiply 工具", async () => {
    const client = manager.getClient("test-stdio");
    expect(client).toBeDefined();

    const result = await client!.callTool({
      name: "multiply",
      arguments: { a: 6, b: 7 },
    });

    const content = (result as any).content ?? [];
    const text = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    expect(text).toBe("42");
  });

  it("重复连接已连接的 server 返回同一清单", async () => {
    const manifest1 = await manager.connect("test-stdio", stdioConfig);
    const manifest2 = await manager.connect("test-stdio", stdioConfig);
    expect(manifest1).toBe(manifest2);
  });

  it("断开后可重新连接", async () => {
    await manager.disconnect("test-stdio");
    expect(manager.getState("test-stdio")).toBe("disconnected");

    const manifest = await manager.connect("test-stdio", stdioConfig);
    expect(manager.getState("test-stdio")).toBe("connected");
    expect(manifest.tools.length).toBeGreaterThanOrEqual(2);
  });
});

describe("MCP 真实服务器 — SSE", () => {
  let manager: McpConnectionManager;

  beforeAll(async () => {
    sseAvailable = await checkSseAvailable();
    if (sseAvailable) {
      manager = new McpConnectionManager();
    }
  });

  afterAll(async () => {
    await manager?.disconnectAll();
  });

  it("连接 SSE 服务器并发现工具", { timeout: 15000 }, async () => {
    if (!sseAvailable) return;
    const manifest = await manager!.connect("test-sse", sseConfig);

    expect(manager!.getState("test-sse")).toBe("connected");
    expect(manifest.tools.length).toBeGreaterThanOrEqual(2);

    const toolNames = manifest.tools.map((t) => t.name);
    expect(toolNames).toContain("echo");
    expect(toolNames).toContain("add");
  });

  it("调用 echo 工具", { timeout: 10000 }, async () => {
    if (!sseAvailable) return;
    const client = manager!.getClient("test-sse");
    expect(client).toBeDefined();

    const result = await client!.callTool({
      name: "echo",
      arguments: { message: "Hello SSE!" },
    });

    const content = (result as any).content ?? [];
    const text = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    expect(text).toBe("ECHO: Hello SSE!");
  });

  it("调用 add 工具", { timeout: 10000 }, async () => {
    if (!sseAvailable) return;
    const client = manager!.getClient("test-sse");
    expect(client).toBeDefined();

    const result = await client!.callTool({
      name: "add",
      arguments: { a: 123, b: 456 },
    });

    const content = (result as any).content ?? [];
    const text = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    expect(text).toBe("579");
  });

  it("断开后可重新连接", { timeout: 15000 }, async () => {
    if (!sseAvailable) return;
    await manager!.disconnect("test-sse");
    expect(manager!.getState("test-sse")).toBe("disconnected");

    const manifest = await manager!.connect("test-sse", sseConfig);
    expect(manager!.getState("test-sse")).toBe("connected");
    expect(manifest.tools.length).toBeGreaterThanOrEqual(2);
  });
});
