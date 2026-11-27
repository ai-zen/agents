/**
 * MCP elicitation 的端到端：真子进程、真 stdio 报文，两种协议年款各走一遭。
 *
 * 两台服务器：
 *
 * - `test-project/mcp-servers/elicit-server.mjs`（手写 JSON-RPC，`--era modern|legacy`）：
 *   `modern` 那档先谈版本，工具回 `input_required`，客户端带 `inputResponses` 重发；`legacy`
 *   那档没有 discover，工具跑到中途中反过来发一条 `elicitation/create` 请求。
 * - `test/fixtures/official-elicit-server.mjs`（官方 `serveStdio`）：验与「用官方 SDK 搭出来的
 *   服务器」互通 —— 它的年款由开场那条消息定，工具只用 `inputRequired`/`inputResponse` 写一遍。
 *
 * 这一套起子进程、走真实管道，所以不在默认套件里：`npm run test:e2e`。
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { McpConnectionManager } from "../src/scope/plugins/mcp/McpConnectionManager.js";
import { createCallMcpTool } from "../src/scope/plugins/mcp/mcpTools.js";
import {
  volunteerElicitation,
  type ElicitAnswer,
  type ElicitRequest,
} from "../src/scope/plugins/mcp/elicitation.js";
import type { AppConfig, McpServerDefinition, ToolEnv } from "../src/types/index.js";

const SERVER_ID = "elicit-test";
const SERVER_PATH = join(__dirname, "..", "..", "test-project", "mcp-servers", "elicit-server.mjs");
/** 官方 SDK（`serveStdio`）搭的那一台：年款由开场消息自己定 */
const OFFICIAL_SERVER_PATH = join(__dirname, "fixtures", "official-elicit-server.mjs");

const env: ToolEnv = { cwd: "/tmp", config: {} as AppConfig, deps: {} };

function definitionOf(era: "modern" | "legacy"): McpServerDefinition {
  return {
    id: SERVER_ID,
    transport: "stdio",
    command: process.execPath,
    args: [SERVER_PATH, "--era", era],
  };
}

/** 一场：真连上那台服务器，手上拿着 `call_mcp_tool` 与「人」那一侧 */
async function setup(
  server: { era: "modern" | "legacy" } | "official",
  answer: (request: ElicitRequest) => Promise<ElicitAnswer | undefined>,
) {
  const asked: ElicitRequest[] = [];
  const manager = new McpConnectionManager();
  await manager.connect(
    SERVER_ID,
    server === "official"
      ? {
          id: SERVER_ID,
          transport: "stdio",
          command: process.execPath,
          args: [OFFICIAL_SERVER_PATH],
        }
      : definitionOf(server.era),
  );

  const tool = createCallMcpTool(manager, env, [SERVER_ID]) as any;
  const owner = {
    sessionId: "sess-1",
    ask: async (request: ElicitRequest) => {
      asked.push(request);
      return await answer(request);
    },
  };

  return {
    asked,
    /** 走 `call_mcp_tool`；不给 agent 就是「手上没有题板的一次性 Agent」 */
    call: async (toolName: string, agent?: object) => {
      if (agent !== undefined) volunteerElicitation(agent as any, owner);
      return await tool.callback(
        { server: SERVER_ID, tool: toolName, arguments: JSON.stringify({ env: "prod" }) },
        agent === undefined ? {} : { agent },
      );
    },
    /** 这一次连接谈成的年款（服务器那侧看不到，只能问客户端） */
    era: () => client().getProtocolEra?.(),
    version: () => client().getNegotiatedProtocolVersion?.(),
    close: async () => {
      await manager.disconnectAll();
    },
  };

  function client() {
    return manager.getClient(SERVER_ID)!;
  }
}

describe("MCP elicitation：真 stdio 服务器（modern 2026-07-28）", () => {
  it("谈成 2026-07-28：题到手、答回去、服务器带着回显的 requestState 收尾", async () => {
    const h = await setup({ era: "modern" }, async () => ({
      action: "accept",
      content: { confirm: true, note: "ok" },
    }));
    try {
      expect(h.era()).toBe("modern");
      expect(h.version()).toBe("2026-07-28");

      const text = await h.call("deploy", {});

      expect(h.asked).toEqual([
        {
          message: "deploy to prod?",
          requestedSchema: {
            type: "object",
            properties: {
              confirm: { type: "boolean", description: "确认部署" },
              note: { type: "string", description: "备注" },
            },
            required: ["confirm"],
          },
        },
      ]);
      expect(text).toContain("action=accept");
      expect(text).toContain(JSON.stringify({ confirm: true, note: "ok" }));
      // 服务器交回 `requestState: "round-1"`，客户端原样回显 —— 说明这一趟是「重发」而不是头一次
      expect(text).toContain("state=round-1");
    } finally {
      await h.close();
    }
  });

  it("拒了：服务器收到 decline", async () => {
    const h = await setup({ era: "modern" }, async () => ({ action: "decline" }));
    try {
      expect(await h.call("deploy", {})).toContain("action=decline");
    } finally {
      await h.close();
    }
  });

  it("url 档：不去问人，回 decline", async () => {
    const h = await setup({ era: "modern" }, async () => ({ action: "accept" }));
    try {
      const text = await h.call("authorize", {});
      expect(h.asked).toEqual([]);
      expect(text).toContain("action=decline");
    } finally {
      await h.close();
    }
  });

  it("没有答题通道：服务器收到 decline，调用不挂在半路", async () => {
    const h = await setup({ era: "modern" }, async () => ({
      action: "accept",
      content: { confirm: true },
    }));
    try {
      const text = await h.call("deploy");
      expect(h.asked).toEqual([]);
      expect(text).toContain("action=decline");
    } finally {
      await h.close();
    }
  });
});

describe("MCP elicitation：真 stdio 服务器（legacy 2025-11-25）", () => {
  it("服务器不认识 discover：照样连上（2025 那一档），中途中发来的题也能答", async () => {
    const h = await setup({ era: "legacy" }, async () => ({
      action: "accept",
      content: { confirm: true, note: "ok" },
    }));
    try {
      expect(h.era()).toBe("legacy");
      expect(h.version()).toBe("2025-11-25");

      const text = await h.call("deploy", {});

      expect(h.asked).toHaveLength(1);
      expect(h.asked[0]?.message).toBe("deploy to prod?");
      expect(text).toContain("action=accept");
      expect(text).toContain(JSON.stringify({ confirm: true, note: "ok" }));
    } finally {
      await h.close();
    }
  });

  it("什么都不问的工具照常跑（谈判没把普通调用带坏）", async () => {
    const h = await setup({ era: "legacy" }, async () => ({ action: "accept" }));
    try {
      expect(await h.call("quiet", {})).toContain("nothing asked");
      expect(h.asked).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

/**
 * 与「用官方 SDK 搭出来的服务器」互通。
 *
 * 这一台走的是官网给的正路 `serveStdio`：年款由开场那条消息定，所以它会跟我们一起谈到
 * 2026-07-28；工具侧只用 `inputRequired`/`inputResponse` 写一遍，两种年款通用。
 */
describe("MCP elicitation：官方 serveStdio 搭的服务器", () => {
  it("谈成 2026-07-28，答的内容回到工具", async () => {
    const h = await setup("official", async () => ({
      action: "accept",
      content: { confirm: true, note: "ok" },
    }));
    try {
      expect(h.era()).toBe("modern");
      expect(h.version()).toBe("2026-07-28");

      const text = await h.call("deploy", {});

      expect(h.asked).toHaveLength(1);
      expect(h.asked[0]?.message).toBe("deploy to prod?");
      expect(text).toContain("action=accept");
      expect(text).toContain(JSON.stringify({ confirm: true, note: "ok" }));
    } finally {
      await h.close();
    }
  });

  it("人没答应就到此为止：服务器不再追问第二遍", async () => {
    const h = await setup("official", async () => ({ action: "decline" }));
    try {
      const text = await h.call("deploy", {});
      expect(h.asked).toHaveLength(1);
      expect(text).toContain("action=decline");
    } finally {
      await h.close();
    }
  });
});
