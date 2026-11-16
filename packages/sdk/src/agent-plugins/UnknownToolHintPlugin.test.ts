import { describe, it, expect, vi } from "vitest";
import { UnknownToolHintPlugin } from "./UnknownToolHintPlugin.js";
import { Agent, ToolCallContext } from "@ai-zen/agents-core";
import type { AgentNS, Tool, ToolHookContext } from "@ai-zen/agents-core";
import { sendRound } from "../test-support/agent-round.js";
import { Scope } from "../scope/Scope.js";
import { McpScopePlugin } from "../scope/plugins/mcp/McpScopePlugin.js";
import type { AppConfig } from "../types/index.js";

const MIN_CONFIG: AppConfig = { endpoints: [], models: [] };

/** 一段文本回答的流 */
function textStream(text: string): any[] {
  return [
    {
      id: "c1",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    },
    {
      id: "c2",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
}

/** 一段「模型要求调工具」的流（每个调用单独一片，与厂商真实形状一致） */
function toolCallStream(calls: Array<{ id: string; name: string; args?: string }>): any[] {
  return [
    ...calls.map((call, index) => ({
      id: `c-${index}`,
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.args ?? "{}" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })),
    {
      id: "c-end",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}

/** 每一轮返回一份固定的 chunk 数组 */
function createMockClient(rounds: any[][]) {
  let callCount = 0;
  const create = vi.fn(async () => {
    const data = rounds[callCount] ?? [];
    callCount++;
    return {
      async *[Symbol.asyncIterator]() {
        for (const chunk of data) yield chunk;
      },
    };
  });
  return { chat: { completions: { create } } } as any;
}

/** 构造带（或不带）MCP 插件的 Scope */
function mockScope(opts?: { mcpPaths?: string[] }): Scope {
  const scope = new Scope({ getConfig: () => MIN_CONFIG, agentsDir: "" });
  if (opts?.mcpPaths?.length) {
    scope.use(new McpScopePlugin({ paths: opts.mcpPaths }));
  }
  return scope;
}

function availableTool(name: string): Tool {
  return {
    type: "function",
    function: { name, description: "", parameters: { type: "object", properties: {} } },
  } as Tool;
}

/**
 * 造一次「未知工具」的 `onToolStart` ctx。
 *
 * 新 core 没有单独的未知工具钩子了：未知工具也走 `onToolStart`，只是
 * `ctx.toolCall.tool === undefined`（没匹配到已注册的实现）—— 这正是本插件的判据。
 */
function unknownToolCtx(toolName: string, availableTools: string[]): ToolHookContext {
  const agent = { tools: availableTools.map(availableTool) } as unknown as Agent;
  const toolCall = new ToolCallContext({
    agent,
    tool_call: { id: "1", type: "function", function: { name: toolName, arguments: "{}" } },
    resultMessage: { id: "r1" } as any,
  });
  return { agent, toolCall };
}

/** 造一次「已知工具」的 ctx：本插件必须让行 */
function knownToolCtx(): ToolHookContext {
  const read = availableTool("read");
  const agent = { tools: [read] } as unknown as Agent;
  const toolCall = new ToolCallContext({
    agent,
    tool_call: { id: "1", type: "function", function: { name: "read", arguments: "{}" } },
    tool: read,
    resultMessage: { id: "r1" } as any,
  });
  return { agent, toolCall };
}

describe("UnknownToolHintPlugin", () => {
  it("无 MCP 配置时提示工具不存在", () => {
    const plugin = new UnknownToolHintPlugin({ scope: mockScope() });
    const result = plugin.onToolStart(unknownToolCtx("foo", []));
    expect(result).toBe('Tool "foo" does not exist.');
  });

  it("有 MCP 配置但 call_mcp_tool 不可用时提示权限问题", () => {
    const plugin = new UnknownToolHintPlugin({
      scope: mockScope({ mcpPaths: ["/tmp/mcp.json"] }),
    });
    const result = plugin.onToolStart(unknownToolCtx("foo", ["read"]));
    expect(result).toContain("call_mcp_tool permission is disabled");
  });

  it("有 MCP 配置且 call_mcp_tool 可用时提示使用 call_mcp_tool", () => {
    const plugin = new UnknownToolHintPlugin({
      scope: mockScope({ mcpPaths: ["/tmp/mcp.json"] }),
    });
    const result = plugin.onToolStart(unknownToolCtx("foo", ["call_mcp_tool"]));
    expect(result).toContain("use call_mcp_tool");
  });

  it("无 MCP 配置时不提示 MCP 相关内容", () => {
    const plugin = new UnknownToolHintPlugin({ scope: mockScope() });
    const result = plugin.onToolStart(unknownToolCtx("unknownFn", ["call_mcp_tool"]));
    expect(result).toContain("unknownFn");
    expect(result).not.toContain("MCP");
    expect(result).not.toContain("call_mcp_tool");
  });

  it("已知工具一律放行（别抢别的工具的活）", () => {
    const plugin = new UnknownToolHintPlugin({ scope: mockScope() });
    expect(plugin.onToolStart(knownToolCtx())).toBeUndefined();
  });

  it("真跑一轮：模型调不存在的工具时，那条 tool 消息的正文就是本插件的提示", async () => {
    // 这条用例验的是决策本身：`onUnknownTool` 并入 `onToolStart` 之后，未知工具仍然
    // 能被提示插件接管，且提示真的落到了回给模型的那条 tool 消息里。
    const agent = new Agent({
      client: createMockClient([
        toolCallStream([{ id: "1", name: "foo", args: "{}" }]),
        textStream("done"),
      ]),
      model: "test-model",
    });
    agent.use(new UnknownToolHintPlugin({ scope: mockScope({ mcpPaths: ["/tmp/mcp.json"] }) }));

    const messages = await sendRound(agent, "hi");

    const toolMessage = messages.find((m) => m.role === "tool")!;
    expect(String(toolMessage.content)).toContain("call_mcp_tool permission is disabled");
  });
});
