import { describe, it, expect, vi } from "vitest";
import { Agent, AgentNS, Message, ToolCallContext } from "@ai-zen/agents-core";
import { createSubAgentTool } from "./subAgentTools.js";
import type { Scope } from "../../Scope.js";
import type { AgentDefinition } from "../../../types/index.js";

// 不需要 mock `runtime/createModel.js`：`buildAgent` 是惰性的，构造阶段不会真的建模型；
// 而模块级 mock 在 `isolate: false` 下会因模块缓存共享而时灵时不灵。

function mockScope(): Scope {
  return {
    config: {
      endpoints: [
        { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
      ],
      models: [
        {
          id: "gpt4",
          name: "GPT-4",
          endpointId: "openai",
          modelName: "gpt-4",
          tokenThresholds: { handoff: 128000, guard: 192000 },
        },
      ],
    },
    filter: vi.fn(() => ({ tools: [], subagents: [], skills: [], mcps: [] })),
    instantiate: vi.fn(() => []),
  } as unknown as Scope;
}

function sampleDef(id: string, functionName: string): AgentDefinition {
  return {
    id,
    name: id,
    messages: [Message.System("You are a sub-agent."), Message.User("{{task}}")],
    function: {
      name: functionName,
      description: `Sub-agent ${functionName}`,
      parameters: { type: "object", properties: {}, required: [] },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("createSubAgentTool", () => {
  it("返回 AgentToolLazy 实例", () => {
    const tool = createSubAgentTool(sampleDef("sa1", "agent_one"), mockScope());
    expect(tool).toBeDefined();
    expect(tool.function.name).toBe("agent_one");
    expect(tool.function.description).toContain("Sub-agent agent_one");
  });

  it("Agent 没有 function 字段时抛出错误", () => {
    const def = sampleDef("no-func", "no_func");
    delete def.function;
    expect(() => createSubAgentTool(def, mockScope())).toThrow("has no function field");
  });

  it("SubAgent 有独立 modelId 时使用独立模型", () => {
    const scope = mockScope();
    const def = sampleDef("sa1", "agent_one");
    def.modelId = "gpt4";

    const tool = createSubAgentTool(def, scope);
    expect(tool.function.name).toBe("agent_one");
    // modelId 指定了，会通过 createModel(scope, def.modelId) 构建独立模型
  });

  it("SubAgent 无 modelId 时复用父 Agent 模型", () => {
    const scope = mockScope();

    const tool = createSubAgentTool(sampleDef("sa1", "agent_one"), scope);
    expect(tool.function.name).toBe("agent_one");
  });

  it("permissions 为空时仍能创建工具", () => {
    const scope = mockScope();

    const def = sampleDef("sa1", "agent_one");
    const tool = createSubAgentTool(def, scope);
    expect(tool).toBeDefined();
    expect(tool.function.name).toBe("agent_one");
  });

  it("buildAgent 造出来的子 Agent 是「一次性」的，且注入的 user 消息带 source", async () => {
    // 委派 = 燃料 + 一把钥匙（CORE.md §9）：`buildAgent` 只能造一次性 agent，
    // 否则它既没人 stop、又会把「结果靠事件回来」的能力错配给一个用完就扔的节点。
    const scope = mockScope();
    const def = sampleDef("sa1", "agent_one");
    def.modelId = "gpt4"; // 有独立模型 → 不必碰父 agent 的 client

    const tool = createSubAgentTool(def, scope);
    const host = new Agent({ client: {} as never, model: "parent-model", tools: [tool] });

    let captured: Agent | undefined;
    host.use({
      onSubAgentStart: ({ subAgent }) => {
        captured = subAgent;
        // 拒掉这次委派：本用例只关心「造出来的是什么」，不想真跑请求
        return "denied by test";
      },
    });

    const result = await tool.exec(
      new ToolCallContext({
        agent: host,
        tool_call: {
          id: "1",
          type: "function",
          function: { name: "agent_one", arguments: JSON.stringify({ task: "do it" }) },
        },
        resultMessage: Message.Tool({ id: "r1", function: { name: "agent_one" } }),
      }),
    );

    expect(result).toBe("denied by test");
    expect(captured).toBeDefined();
    expect(captured!.lifetime).toBe("one-shot");
    // 模板里那条 user 消息没有 source（定义文件是 JSON，不带这个概念）：委派工具补
    const userMessage = captured!.messages.find((m) => m.role === AgentNS.Role.User)!;
    expect(userMessage.source).toEqual({ kind: "agent", label: "agent_one" });
    expect(userMessage.content).toBe("do it");
  });
});
