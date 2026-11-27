#!/usr/bin/env node

/**
 * 会 elicitation 的 MCP stdio 测试服务器：一台服务器，两种协议年款。
 *
 * 用法：
 *   node mcp-servers/elicit-server.mjs --era modern   （缺省）
 *   node mcp-servers/elicit-server.mjs --era legacy
 *
 * 两边的问法不一样，这正是这个文件存在的理由：
 *
 * - `modern`（2026-07-28）：先答 `server/discover` 把版本谈上去；工具第一次被调用时**不返回结果**，
 *   而是回一个 `resultType: "input_required"` 的应答，把「要问的那张表」装在 `inputRequests` 里。
 *   客户端拿齐答案后会带着 `inputResponses` 与回显的 `requestState` 再发一次 —— 那时候才出结果，
 *   且结果必须带 `resultType: "complete"`。
 * - `legacy`（2025-11-25）：没有 discover，也没有 input_required；工具在跑的中途**反过来发一条请求**
 *   给客户端（`elicitation/create`），等它回包再继续。
 *
 * 工具（两边同名同参数）：
 *   deploy { env: string }             问一张表：confirm（布尔，必填）、note（字符串，选填）
 *   authorize                          问一张 url 档的表（要人去外部页面填凭据）
 *   quiet                              什么都不问，用来对照
 *
 * 这里手写 JSON-RPC 而不用官方 server SDK：官方那份也能双年款（`serveStdio` 按开场那条消息定
 * 年款、`inputRequired`/`inputResponse` 一套 builder 两种年款通用，见 `fixtures/official-elicit-server.mjs`），
 * 但它按规矩办事 —— 谈成哪一档由客户端说了算，造不出「非要 `--era legacy`」这种对照，也不会
 * 发 url 档那种我们没声明的问法。这台是给「客户端在两种年款下、以及边角问法下该怎么接」用的。
 */

import readline from "node:readline";

const eraArgIndex = process.argv.indexOf("--era");
const ERA = eraArgIndex === -1 ? "modern" : process.argv[eraArgIndex + 1];
if (ERA !== "modern" && ERA !== "legacy") {
  process.stderr.write(`elicit-server: --era 只认 modern / legacy，收到 ${ERA}\n`);
  process.exit(2);
}

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-11-25";

/** 问的那张表：与宿主的 `FormRequest.requestedSchema` 同一形状 */
const CONFIRM_SCHEMA = {
  type: "object",
  properties: {
    confirm: { type: "boolean", description: "确认部署" },
    note: { type: "string", description: "备注" },
  },
  required: ["confirm"],
};

const TOOLS = [
  {
    name: "deploy",
    description: "部署前先问一句",
    inputSchema: {
      type: "object",
      properties: { env: { type: "string", description: "目标环境" } },
      required: ["env"],
    },
  },
  {
    name: "authorize",
    description: "要一段凭据（url 档的问法）",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "quiet",
    description: "什么都不问",
    inputSchema: { type: "object", properties: {} },
  },
];

// ---------------------------------------------------------------------------
// 收发
// ---------------------------------------------------------------------------

/** 我们自己发出去的请求（legacy 那一档要用）：id → 等回包的那一格 */
const pending = new Map();
let nextRequestId = 1;

function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function respond(id, result) {
  // 2026-07-28 那一档：每个结果都要自带 `resultType`，缺了客户端会按「这不是个结果」拒掉
  // （`input_required` 那个分支自己写，不走这里）
  write({ id, result: ERA === "modern" ? { resultType: "complete", ...result } : result });
}

function respondError(id, code, message) {
  write({ id, error: { code, message } });
}

/** 反过来问客户端（legacy 档）：发一条请求，等它的回包 */
function askClient(params) {
  const id = `elicit-${nextRequestId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    write({ id, method: "elicitation/create", params });
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  handle(message);
});

async function handle(message) {
  // 回包（我们发出去的 elicit 的答案）：没有 method，只有 id + result/error
  if (message.method === undefined) {
    const waiting = pending.get(message.id);
    if (waiting === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
    return;
  }

  const { id, method, params } = message;
  // 通知一律不理（`notifications/initialized` 之类）
  if (id === undefined) return;

  if (method === "server/discover") {
    if (ERA !== "modern") {
      respondError(id, -32601, "Method not found");
      return;
    }
    respond(id, {
      supportedVersions: [MODERN_VERSION, LEGACY_VERSION],
      serverInfo: { name: "test-elicit-server", version: "1.0.0" },
      capabilities: { tools: { listChanged: false } },
    });
    return;
  }

  if (method === "initialize") {
    respond(id, {
      protocolVersion: ERA === "modern" ? MODERN_VERSION : LEGACY_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "test-elicit-server", version: "1.0.0" },
    });
    return;
  }

  if (method === "tools/list") {
    // 2026-07-28 那一档：可缓存的结果要自带缓存提示（这里就是「不许缓存」）
    respond(
      id,
      ERA === "modern" ? { ttlMs: 0, cacheScope: "private", tools: TOOLS } : { tools: TOOLS },
    );
    return;
  }

  if (method === "tools/call") {
    try {
      await callTool(id, params);
    } catch (error) {
      respondError(id, -32603, String(error?.message ?? error));
    }
    return;
  }

  if (method === "ping") {
    respond(id, {});
    return;
  }

  respondError(id, -32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

async function callTool(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};

  if (name === "quiet") {
    complete(id, [{ type: "text", text: "nothing asked" }]);
    return;
  }

  if (name === "authorize") {
    const urlParams = {
      mode: "url",
      message: "去这个页面填密钥",
      url: "https://example.invalid/authorize",
      elicitationId: "auth-1",
    };
    if (ERA === "modern") {
      await askModern(id, params, urlParams);
      return;
    }
    const answer = await askClient(urlParams);
    complete(id, [{ type: "text", text: `action=${answer.action}` }]);
    return;
  }

  const elicitParams = {
    mode: "form",
    message: `deploy to ${args.env}?`,
    requestedSchema: CONFIRM_SCHEMA,
  };

  if (ERA === "modern") {
    await askModern(id, params, elicitParams);
    return;
  }

  const answer = await askClient(elicitParams);
  complete(id, [
    {
      type: "text",
      text: `action=${answer.action} content=${JSON.stringify(answer.content ?? null)}`,
    },
  ]);
}

/**
 * modern 那一档：要么请客户端去问人（`input_required`），要么这次调用已经带着答案了。
 *
 * `requestState` 是本服务器自己的不透明状态，客户端原样回显；这里只借它数一下第几轮。
 */
async function askModern(id, params, elicitParams) {
  const responses = params?.inputResponses;
  if (responses === undefined) {
    write({
      id,
      result: {
        resultType: "input_required",
        inputRequests: { answer: { method: "elicitation/create", params: elicitParams } },
        requestState: "round-1",
      },
    });
    return;
  }

  const entry = responses.answer ?? {};
  complete(id, [
    {
      type: "text",
      text: `action=${entry.action ?? "missing"} content=${JSON.stringify(entry.content ?? null)} state=${params?.requestState ?? ""}`,
    },
  ]);
}

/** 一次工具调用的正常收尾 */
function complete(id, content) {
  respond(id, { content });
}
