#!/usr/bin/env node

/**
 * 用官方 server SDK 搭的一台会 elicitation 的 stdio 服务器（测试夹具）。
 *
 * 与 `test-project/mcp-servers/elicit-server.mjs`（手写 JSON-RPC）分工不同：
 *
 * - 这一台走官网给的正路 `serveStdio`：**开场的那条消息决定年款**，同一个工厂给两种年款各
 *   发一个实例，2025 那一档的连接就按 2025 服务、2026 那一档按 2026 服务；
 * - 工具只用 `inputRequired` / `inputResponse` 写一遍，两种年款都问得成 —— 这一条正是官方
 *   这套 builder 的用意（2025 那一档它替你在调用中途中发请求）。
 *
 * 用法：node official-elicit-server.mjs
 */

import {
  McpServer,
  acceptedContent,
  fromJsonSchema,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const FORM_SCHEMA = {
  type: "object",
  properties: {
    confirm: { type: "boolean" },
    note: { type: "string" },
  },
  required: ["confirm"],
};

serveStdio(() => {
  const server = new McpServer({ name: "official-elicit", version: "1.0.0" });

  server.registerTool(
    "deploy",
    {
      description: "部署前先问一句（官方 builder 写一遍，两种年款都问得成）",
      inputSchema: fromJsonSchema({
        type: "object",
        properties: { env: { type: "string" } },
        required: ["env"],
      }),
    },
    async (args, ctx) => {
      const round = inputResponse(ctx.mcpReq.inputResponses, "confirm");
      // 还没问过：把那张表装进 input_required 交回去（2025 那一档由 SDK 替你变成一条请求）
      if (round.kind === "missing") {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              mode: "form",
              message: `deploy to ${args.env}?`,
              requestedSchema: FORM_SCHEMA,
            }),
          },
          requestState: "round-1",
        });
      }
      // 问过了但人没答应：到此为止，不再追问
      if (round.kind === "elicit" && round.action !== "accept") {
        return { content: [{ type: "text", text: `action=${round.action}` }] };
      }
      const accepted = acceptedContent(ctx.mcpReq.inputResponses, "confirm");
      return {
        content: [
          {
            type: "text",
            text: `action=accept content=${JSON.stringify(accepted ?? null)}`,
          },
        ],
      };
    },
  );

  return server;
});
