#!/usr/bin/env node

/**
 * 极简 MCP SSE 测试服务器。
 *
 * 实现了 MCP 协议的基础初始化流程，暴露 echo 和 add 工具。
 *
 * 传输层：SSE（Server-Sent Events）。
 * - GET /sse → 建立 SSE 流
 * - POST /sse → 发送 JSON-RPC 请求，返回 JSON 响应（同步模式）
 *   同时通过 SSE 流推送响应（异步模式兼容）
 */

import http from "node:http";

const PORT = parseInt(process.env.PORT || "9876", 10);
const HOST = process.env.HOST || "127.0.0.1";

const sessions = new Map();

function createServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/sse") {
      // GET → SSE 流
      if (req.method === "GET") {
        const sessionId = Math.random().toString(36).slice(2);

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);

        sessions.set(sessionId, { res, id: sessionId });

        req.on("close", () => sessions.delete(sessionId));
        return;
      }

      // POST → 处理 JSON-RPC 消息
      if (req.method === "POST") {
        handlePost(req, res);
        return;
      }

      res.writeHead(405);
      res.end("Method Not Allowed");
      return;
    }

    // /message 端点（兼容旧版）
    if (url.pathname === "/message" && req.method === "POST") {
      handlePost(req, res);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  return server;
}

function handlePost(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("sessionId") || req.headers["mcp-session-id"];
  const session = sessionId ? sessions.get(sessionId) : sessions.values().next().value;

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const msg = JSON.parse(body);
      const result = getResponse(msg);

      // 通过 SSE 流推送响应
      if (session && result) {
        session.res.write(`data: ${JSON.stringify(result)}\n\n`);
      }

      // HTTP 响应直接返回 JSON（客户端期望同步返回）
      if (result) {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(result));
      } else {
        // notification，无需响应
        res.writeHead(202, {
          "Access-Control-Allow-Origin": "*",
        });
        res.end("accepted");
      }
    } catch (err) {
      res.writeHead(400);
      res.end("Invalid JSON");
    }
  });
}

function getResponse(msg) {
  const { id, method, params } = msg;

  // notifications 无响应
  if (id === undefined || id === null) return null;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "test-sse-server", version: "1.0.0" },
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "echo",
              description: "回显输入",
              inputSchema: {
                type: "object",
                properties: {
                  message: { type: "string", description: "要回显的消息" },
                },
                required: ["message"],
              },
            },
            {
              name: "add",
              description: "两个数相加",
              inputSchema: {
                type: "object",
                properties: {
                  a: { type: "number", description: "第一个数" },
                  b: { type: "number", description: "第二个数" },
                },
                required: ["a", "b"],
              },
            },
          ],
        },
      };

    case "tools/call": {
      const { name, arguments: args } = params;
      if (name === "echo") {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `ECHO: ${args.message}` }] },
        };
      }
      if (name === "add") {
        const sum = (args.a ?? 0) + (args.b ?? 0);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `${sum}` }] },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      };
    }

    case "resources/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: [
            { uri: "sse-test://welcome", name: "Welcome", description: "欢迎消息", mimeType: "text/plain" },
          ],
        },
      };

    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

const server = createServer();
server.listen(PORT, HOST, () => {
  console.error(`MCP SSE 测试服务器已启动: http://${HOST}:${PORT}/sse`);
});

process.on("SIGINT", () => server.close() || process.exit(0));
process.on("SIGTERM", () => server.close() || process.exit(0));
