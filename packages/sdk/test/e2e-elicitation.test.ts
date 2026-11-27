/**
 * MCP elicitation 的端到端：真子进程、真 stdio 报文，两种协议年款各走一遭。
 *
 * 两台夹具都用官方 server SDK 搭，差别只在入口 —— 而入口恰好决定年款：
 *
 * - `fixtures/official-elicit-server.mjs`（`serveStdio`）：年款由开场那条消息定，所以它会跟
 *   本仓一起谈到 2026-07-28，工具回 `input_required`、客户端带 `inputResponses` 重发；
 * - `fixtures/official-legacy-elicit-server.mjs`（`new McpServer` + `new StdioServerTransport`）：
 *   这条基本写法没有「按开场消息定年款」那层，只服务 2025 那一档，客户端把版本探回 2025，
 *   工具跑到中途中由 SDK 反过来发一条 `elicitation/create` 请求。
 *
 * 两台的工具都只用 `inputRequired`/`inputResponse` 写一遍 —— 官方这套 builder 的用意就是
 * 「写一遍，两种年款都能问」。
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

/** 两种年款各一台夹具，路径即入口 */
const SERVERS: Record<"modern" | "legacy", string> = {
  modern: join(__dirname, "fixtures", "official-elicit-server.mjs"),
  legacy: join(__dirname, "fixtures", "official-legacy-elicit-server.mjs"),
};

/** 服务器问的那张表（两台夹具共用同一张） */
const FORM_SCHEMA = {
  type: "object",
  properties: {
    confirm: { type: "boolean" },
    note: { type: "string" },
  },
  required: ["confirm"],
};

const env: ToolEnv = { cwd: "/tmp", config: {} as AppConfig, deps: {} };

function definitionOf(era: keyof typeof SERVERS): McpServerDefinition {
  return {
    id: SERVER_ID,
    transport: "stdio",
    command: process.execPath,
    args: [SERVERS[era]],
  };
}

/** 一场：真连上那台服务器，手上拿着 `call_mcp_tool` 与「人」那一侧 */
async function setup(
  era: keyof typeof SERVERS,
  answer: (request: ElicitRequest) => Promise<ElicitAnswer | undefined>,
) {
  const asked: ElicitRequest[] = [];
  const manager = new McpConnectionManager();
  await manager.connect(SERVER_ID, definitionOf(era));

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
    era: () => manager.getClient(SERVER_ID)!.getProtocolEra?.(),
    version: () => manager.getClient(SERVER_ID)!.getNegotiatedProtocolVersion?.(),
    close: async () => {
      await manager.disconnectAll();
    },
  };
}

describe("MCP elicitation：服务 2026-07-28 那一档的服务器（serveStdio）", () => {
  it("谈成 2026-07-28：题到手、答回去、服务器拿到的是用户填的内容", async () => {
    const h = await setup("modern", async () => ({
      action: "accept",
      content: { confirm: true, note: "ok" },
    }));
    try {
      expect(h.era()).toBe("modern");
      expect(h.version()).toBe("2026-07-28");

      const text = await h.call("deploy", {});

      expect(h.asked).toEqual([{ message: "deploy to prod?", requestedSchema: FORM_SCHEMA }]);
      expect(text).toContain("action=accept");
      expect(text).toContain(JSON.stringify({ confirm: true, note: "ok" }));
    } finally {
      await h.close();
    }
  });

  it("人没答应就到此为止：服务器不再追问第二遍", async () => {
    const h = await setup("modern", async () => ({ action: "decline" }));
    try {
      const text = await h.call("deploy", {});
      expect(h.asked).toHaveLength(1);
      expect(text).toContain("action=decline");
    } finally {
      await h.close();
    }
  });

  it("没有答题通道：服务器收到 cancel，调用不挂在半路", async () => {
    const h = await setup("modern", async () => ({ action: "accept", content: { confirm: true } }));
    try {
      const text = await h.call("deploy");
      expect(h.asked).toEqual([]);
      expect(text).toContain("action=cancel");
    } finally {
      await h.close();
    }
  });
});

describe("MCP elicitation：只服务 2025 那一档的服务器（基本写法）", () => {
  it("版本探回 2025：中途中发来的题也能答，答案照样到服务器", async () => {
    const h = await setup("legacy", async () => ({
      action: "accept",
      content: { confirm: true, note: "ok" },
    }));
    try {
      expect(h.era()).toBe("legacy");
      expect(h.version()).toBe("2025-11-25");

      const text = await h.call("deploy", {});

      expect(h.asked).toEqual([{ message: "deploy to prod?", requestedSchema: FORM_SCHEMA }]);
      expect(text).toContain("action=accept");
      expect(text).toContain(JSON.stringify({ confirm: true, note: "ok" }));
    } finally {
      await h.close();
    }
  });

  it("什么都不问的工具照常跑（谈判没把普通调用带坏）", async () => {
    const h = await setup("legacy", async () => ({ action: "accept" }));
    try {
      expect(await h.call("quiet", {})).toContain("nothing asked");
      expect(h.asked).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
