/**
 * MCP elicitation 的真协议往返：一台真的 `McpServer`，一条管理器自己造的 `Client`，
 * 中间用 in-memory 传输接起来。
 *
 * 为什么还要这一层：`McpConnectionManager.test.ts` 那一组把注册进来的处理器掏出来直接调，
 * 验的是「注册进来的处理器拿到账之后怎么答」；它验不到的另一半在这边 —— 服务器真把
 * `elicitation/create` 发出来的时候，这条请求会不会走到处理器上、答案会不会被服务器
 * 那一侧的 `elicitInput()` 收到、账本空着的时候真的是 cancel 而不是把调用挂在那里，
 * 以及工具最终拿到的文本里是不是真带着用户填的东西。
 *
 * 用 in-memory 传输而不是子进程：这一套跑在默认套件里，不起端口、不 spawn、不出网。但它得
 * 再套一层 JSON 往返（见 `jsonTransport`）才对得上真线的行为。
 */
import { describe, it, expect } from "vitest";
import {
  InMemoryTransport,
  type ElicitRequestFormParams,
  type Transport,
} from "@modelcontextprotocol/client";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";

import { McpConnectionManager } from "./McpConnectionManager.js";
import { volunteerElicitation, type ElicitAnswer, type ElicitRequest } from "./elicitation.js";
import { createCallMcpTool } from "./mcpTools.js";
import type { AppConfig, McpServerDefinition, ToolEnv } from "../../../types/index.js";

const SERVER_ID = "elicit-demo";

/** 服务器要问的那张表（与宿主 `FormRequest.requestedSchema` 同一形状） */
const FORM_SCHEMA: ElicitRequestFormParams["requestedSchema"] = {
  type: "object",
  properties: {
    confirm: { type: "boolean" },
    note: { type: "string" },
  },
  required: ["confirm"],
};

/**
 * 工具的入参 schema。
 *
 * sdk 这一侧没有 zod 依赖，为一条用例往包里加一个不值当；`registerTool` 要的是能把 schema
 * 摊成 JSON Schema 的那一档（工具清单要发出去），所以直接给 JSON Schema 再包一层。
 */
function emptyArgsSchema(): any {
  return fromJsonSchema({ type: "object", properties: {}, additionalProperties: true });
}

/**
 * 把 in-memory 传输包成「只过 JSON」的样子。
 *
 * 真线上每条报文都是一段 JSON；in-memory 这一对是把对象直接递过去的，于是 `undefined` 这类
 * 只在内存里存在的东西会漏过去 —— 实测 `tools/list` 的结果就因此过不了 SDK 自己的
 * 「必须是 JSON 值」校验，任务会话（`McpTaskBridge`）一建就炸，而真连服务器时不会。
 */
function jsonTransport(inner: Transport): Transport {
  const toWire = (value: unknown) => JSON.parse(JSON.stringify(value));
  const wrapper: Transport = {
    start: () => inner.start(),
    close: () => inner.close(),
    send: (message) => inner.send(toWire(message)),
  };
  inner.onmessage = (message) => wrapper.onmessage?.(toWire(message));
  inner.onclose = () => wrapper.onclose?.();
  inner.onerror = (error) => wrapper.onerror?.(error);
  return wrapper;
}

const env: ToolEnv = { cwd: "/tmp", config: {} as AppConfig, deps: {} };

const definition: McpServerDefinition = {
  id: SERVER_ID,
  transport: "stdio",
  command: "node",
};

/** 这一场的地基：一台真服务器、一条真连接、一个真的 `call_mcp_tool` */
interface Harness {
  /**
   * 走 `call_mcp_tool` 跑一次工具，回它给模型的那段文本。
   *
   * 传了 `agent` 就给这个 Agent 装答题通道 —— 宿主建会话时干的就是这件事
   * （`McpElicitationPlugin`）；不传就是「手上没有题板的一次性 Agent」，账本压不进去。
   */
  call: (options?: { tool?: string; agent?: object }) => Promise<string>;
  /** 服务器问过来的题都落在这儿 */
  asked: ElicitRequest[];
  close: () => Promise<void>;
}

/**
 * 起一场。
 *
 * `answer` 是「人」那一侧：服务器问过来时交什么；回 `undefined` 表示那一段会话已经没了。
 */
async function setup(
  answer: (request: ElicitRequest) => Promise<ElicitAnswer | undefined>,
): Promise<Harness> {
  const asked: ElicitRequest[] = [];
  const server = new McpServer({ name: SERVER_ID, version: "0.0.0" });

  server.registerTool(
    "deploy",
    { description: "问一句再部署", inputSchema: emptyArgsSchema() },
    async (args: any) => {
      const result = await server.server.elicitInput({
        mode: "form",
        message: `deploy to ${args.env}?`,
        requestedSchema: FORM_SCHEMA,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `action=${result.action} content=${JSON.stringify(result.content ?? null)}`,
          },
        ],
      };
    },
  );

  // 同一台服务器上再挂一个「要人去外部页面填凭据」的那种问法
  server.registerTool(
    "authorize",
    { description: "要一段凭据", inputSchema: emptyArgsSchema() },
    async () => {
      const result = await server.server.elicitInput({
        mode: "url",
        message: "去这个页面填密钥",
        url: "https://example.dev/authorize",
        elicitationId: "el-1",
      });
      return { content: [{ type: "text" as const, text: `action=${result.action}` }] };
    },
  );

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);

  const manager = new McpConnectionManager(() => jsonTransport(clientSide));
  await manager.connect(SERVER_ID, definition);

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
    call: async ({ tool: toolName = "deploy", agent }: { tool?: string; agent?: object } = {}) => {
      if (agent !== undefined) volunteerElicitation(agent as any, owner);
      return await tool.callback(
        { server: SERVER_ID, tool: toolName, arguments: JSON.stringify({ env: "prod" }) },
        agent === undefined ? {} : { agent },
      );
    },
    close: async () => {
      await manager.disconnectAll();
      await server.close();
    },
  };
}

describe("MCP elicitation：真协议往返", () => {
  it("服务器在工具调用中途问，答的内容原样回到服务器", async () => {
    const h = await setup(async () => ({
      action: "accept",
      content: { confirm: true, note: "ok" },
    }));
    try {
      const text = await h.call({ agent: {} });

      // 题到了人这一侧，形状一格里都没少
      expect(h.asked).toEqual([{ message: "deploy to prod?", requestedSchema: FORM_SCHEMA }]);
      // 服务器真的收到了 accept 与那两格内容（这段文本是它在工具里拼出来的）
      expect(text).toContain("action=accept");
      expect(text).toContain(JSON.stringify({ confirm: true, note: "ok" }));
    } finally {
      await h.close();
    }
  });

  it("人拒了 / 关了：服务器分别收到 decline、cancel", async () => {
    const declined = await setup(async () => ({ action: "decline" }));
    try {
      expect(await declined.call({ agent: {} })).toContain("action=decline");
    } finally {
      await declined.close();
    }

    const cancelled = await setup(async () => ({ action: "cancel" }));
    try {
      expect(await cancelled.call({ agent: {} })).toContain("action=cancel");
    } finally {
      await cancelled.close();
    }
  });

  it("没人能答（一次性 Agent 手上没有题板）：服务器收到 cancel，调用不挂在半路", async () => {
    const h = await setup(async () => ({ action: "accept", content: { confirm: true } }));
    try {
      const text = await h.call();

      // 人这一侧一次都没被问到（账本是空的）
      expect(h.asked).toEqual([]);
      expect(text).toContain("action=cancel");
    } finally {
      await h.close();
    }
  });

  it("会话没了（ask 回 undefined）：服务器收到 cancel", async () => {
    const h = await setup(async () => undefined);
    try {
      const text = await h.call({ agent: {} });
      expect(h.asked).toHaveLength(1);
      expect(text).toContain("action=cancel");
    } finally {
      await h.close();
    }
  });

  it("url 那一档：我们声明里没有它，服务器在发请求之前就挡住了，没人被问到", async () => {
    const h = await setup(async () => ({ action: "accept" }));
    try {
      const text = await h.call({ tool: "authorize", agent: {} });

      // 建连时只声明了 `elicitation.form`，服务器那一侧的 SDK 就不肯发这条请求；
      // 工具以失败收场，但人这一侧从头到尾没被问过（也没有一个假答案流回服务器）
      expect(h.asked).toEqual([]);
      expect(text).toMatch(/url elicitation/);
    } finally {
      await h.close();
    }
  });
});
