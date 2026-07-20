#!/usr/bin/env node

/**
 * 极简 MCP stdio 测试服务器。
 *
 * 通过 stdio 传输层实现 MCP 协议，暴露 greet 和 multiply 工具。
 * 用法：node mcp-servers/stdio-server.mjs
 */

import { readFileSync } from "node:fs";

// 使用 readline 从 stdin 读取 JSON-RPC 消息
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    handleMessage(msg);
  } catch {
    // 忽略解析失败
  }
});

function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    sendResponse(id, {
      protocolVersion: "2025-11-25",
      capabilities: {
        tools: {},
        resources: {},
      },
      serverInfo: {
        name: "test-stdio-server",
        version: "1.0.0",
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    sendResponse(id, {
      tools: [
        {
          name: "greet",
          description: "向某人打招呼",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "姓名" },
            },
            required: ["name"],
          },
        },
        {
          name: "multiply",
          description: "两个数相乘",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "number", description: "第一个因数" },
              b: { type: "number", description: "第二个因数" },
            },
            required: ["a", "b"],
          },
        },
      ],
    });
    return;
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params;

    if (name === "greet") {
      sendResponse(id, {
        content: [{ type: "text", text: `你好，${args.name}！` }],
      });
      return;
    }

    if (name === "multiply") {
      const product = (args.a ?? 0) * (args.b ?? 0);
      sendResponse(id, {
        content: [{ type: "text", text: `${product}` }],
      });
      return;
    }

    sendResponse(id, {
      isError: true,
      content: [{ type: "text", text: `未知工具: ${name}` }],
    });
    return;
  }

  if (method === "resources/list") {
    sendResponse(id, { resources: [] });
    return;
  }

  if (method === "prompts/list") {
    sendResponse(id, { prompts: [] });
    return;
  }

  if (method === "ping") {
    sendResponse(id, {});
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}
