#!/usr/bin/env node

/**
 * 用官方 server SDK 的**基本写法**（`new McpServer` + `new StdioServerTransport`）搭的
 * elicitation 服务器（测试夹具）。
 *
 * 它只服务 2025 那一档：这条写法没有 `serveStdio` 那层「按开场消息定年款」的入口，Server
 * 也就没被装上 `server/discover` 处理器 —— 客户端来探版本会收到 Method not found，据此判回
 * 2025 那一档。而这一档恰恰是今天绝大多数真服务器的样子。
 *
 * 工具用 `inputRequired` / `inputResponse` 写一遍：2025 那一档 SDK 会把它变成一条
 * 「调用中途中发出去」的 `elicitation/create` 请求。
 *
 * 用法：node official-legacy-elicit-server.mjs
 */

import {
  McpServer,
  acceptedContent,
  fromJsonSchema,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const FORM_SCHEMA = {
  type: "object",
  properties: {
    confirm: { type: "boolean" },
    note: { type: "string" },
  },
  required: ["confirm"],
};

const server = new McpServer({ name: "official-legacy-elicit", version: "1.0.0" });

server.registerTool(
  "deploy",
  {
    description: "部署前先问一句",
    inputSchema: fromJsonSchema({
      type: "object",
      properties: { env: { type: "string" } },
      required: ["env"],
    }),
  },
  async (args, ctx) => {
    const round = inputResponse(ctx.mcpReq.inputResponses, "confirm");
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
    if (round.kind === "elicit" && round.action !== "accept") {
      return { content: [{ type: "text", text: `action=${round.action}` }] };
    }
    const accepted = acceptedContent(ctx.mcpReq.inputResponses, "confirm");
    return {
      content: [
        { type: "text", text: `action=accept content=${JSON.stringify(accepted ?? null)}` },
      ],
    };
  },
);

server.registerTool(
  "quiet",
  { description: "什么都不问", inputSchema: fromJsonSchema({ type: "object", properties: {} }) },
  async () => ({ content: [{ type: "text", text: "nothing asked" }] }),
);

await server.connect(new StdioServerTransport());
