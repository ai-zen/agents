import { describe, it, expect, vi } from "vitest";
import { Agent, AgentNS, CallbackTool, Message, ToolCallContext } from "@ai-zen/agents-core";
import { createSubAgentTool } from "./subAgentTools.js";
import { Scope, type FilterOutput } from "../../Scope.js";
import type { ScopeCandidates, ScopePlugin } from "../../ScopePlugin.js";
import { PeerSessionsScopePlugin } from "../peers/PeerSessionsScopePlugin.js";
import { PEER_SESSION_TOOL_NAMES } from "../peers/peerSessionTools.js";
import { ASYNC_TASK_TOOL_NAMES } from "../builtin/asyncTasks.js";
import type { PeerSessionPort } from "../peers/peerSessionTools.js";
import type { AgentDefinition, AppConfig } from "../../../types/index.js";

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

/** 假端口：本用例只关心工具名单，三个端口方法都不会被调到 */
function fakePeerSessionPort(): PeerSessionPort {
  return {
    async create() {
      return { ok: true, sessionId: "session-1", label: "占位会话" };
    },
    async status() {
      return { found: false, status: null };
    },
    async post() {
      return { ok: true };
    },
  };
}

/**
 * 桩插件：只贡献一个 `ordinary_tool`。
 *
 * 它就是「别的工具」：用来证明剔除只掐掉 PeerSession 那三个名字，普通回调工具照旧进得了 Agent。
 */
function ordinaryToolPlugin(): ScopePlugin {
  return {
    id: "ordinary-tool-test",
    candidates(): ScopeCandidates {
      return { tools: ["ordinary_tool"] };
    },
    instantiate(_scope: Scope, filtered: FilterOutput) {
      if (!filtered.tools.includes("ordinary_tool")) return [];
      return [
        new CallbackTool({
          function: {
            name: "ordinary_tool",
            description: "占位工具",
            parameters: { type: "object", properties: {}, required: [] },
          },
          callback: () => "ok",
        }),
      ];
    },
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

  it("buildAgent 造出来的subagent 是「一次性」的，且注入的 user 消息带 source", async () => {
    // 一次性委派的理由见 `subAgentTools.ts`
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

  it("被派出去的Agent没有平级会话那三个工具与两个后台工具，别的工具还在", async () => {
    // 这里要一个真实的 Scope：`mockScope()` 的 filter 与 instantiate 都是桩，会把 exclude 吃掉，
    // 那样这条用例就证明不了剔除真的发生了。
    const scope = new Scope({
      getConfig: () => ({}) as AppConfig,
      agentsDir: "test-agents-dir",
    }).use(new PeerSessionsScopePlugin(fakePeerSessionPort()), ordinaryToolPlugin());
    await scope.init();

    const def = sampleDef("sa1", "agent_one");
    // 工具维度写全放行：剔除要能与 `allow: ["*"]` 叠加（filter 先按 exclude 剔、再按权限过滤）
    def.permissions = { tools: { allow: ["*"] } };

    const tool = createSubAgentTool(def, scope);
    const host = new Agent({ client: {} as never, model: "parent-model", tools: [tool] });

    let captured: Agent | undefined;
    host.use({
      onSubAgentStart: ({ subAgent }) => {
        captured = subAgent;
        // 拒掉这次委派：本用例只关心造出来的 Agent 手上有什么工具，不跑请求
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
    const subAgentNames = captured!.tools.map((t) => t.function.name);
    for (const name of [...PEER_SESSION_TOOL_NAMES, ...ASYNC_TASK_TOOL_NAMES]) {
      expect(subAgentNames).not.toContain(name);
    }
    // 剔除只掐那几个名字：普通工具照旧在
    expect(subAgentNames).toContain("ordinary_tool");

    // 收窄只发生在被派出去的那一层：同一个定义，父会话那一侧照旧拿得到那三个
    const parentNames = scope.buildTools(def).map((t) => t.function.name);
    for (const name of PEER_SESSION_TOOL_NAMES) {
      expect(parentNames).toContain(name);
    }
  });
});
