import { describe, it, expect, beforeEach, vi } from "vitest";
import { discoverSubAgents, resolveSubAgentTools } from "./sub-agent-loader.js";
import { SubAgentConfig } from "./types.js";

// ==================== Mock 文件系统 ====================

const vol = new Map<string, string>();

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (path.includes("node_modules")) return actual.existsSync(path);
      return vol.has(path);
    }),
    readdirSync: vi.fn((path: string) => {
      const prefix = path.endsWith("/") ? path : path + "/";
      return Array.from(vol.keys())
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    }),
    readFileSync: vi.fn((path: string, encoding?: any) => {
      if (path.includes("node_modules")) return actual.readFileSync(path, encoding);
      if (!vol.has(path)) throw new Error(`ENOENT: ${path}`);
      return vol.get(path)!;
    }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// ==================== Mock config 路径 ====================

vi.mock("./config.js", async () => {
  return {
    SUB_AGENTS_DIR: "/mock/.ai-zen/sub-agents",
  };
});

// ==================== Mock tools ====================

vi.mock("./tools/index.js", async () => {
  const { CallbackTool } = await import("@ai-zen/agents-core");
  return {
    allTools: [
      new CallbackTool({
        function: {
          name: "readFile",
          description: "读取文件",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
        callback: async () => "",
      }),
      new CallbackTool({
        function: {
          name: "exec",
          description: "执行命令",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
        callback: async () => "",
      }),
    ],
  };
});

// ==================== Mock MCP ====================

vi.mock("./mcp-manager.js", async () => {
  const { CallbackTool } = await import("@ai-zen/agents-core");
  return {
    getConnectedMcpTools: () => ({
      "my-db-server": [
        new CallbackTool({
          function: {
            name: "db_query",
            description: "查询数据库",
            parameters: { type: "object", properties: {} },
          },
          callback: async () => "",
        }),
      ],
    }),
  };
});

// ==================== 测试数据 ====================

const validJsonAgent = JSON.stringify({
  id: "test-agent",
  name: "测试助手",
  description: "一个测试用的子 Agent",
  system: "你是测试助手，请完成以下任务。",
  tools: ["readFile", "exec"],
});

const agentWithMessages = JSON.stringify({
  id: "multi-msg",
  name: "多消息 Agent",
  messages: [
    { role: "system", content: "你是专家" },
    { role: "user", content: "帮我做 {{task}}" },
  ],
  function: {
    name: "expert_help",
    description: "专家帮助",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "任务描述" },
      },
      required: ["task"],
    },
  },
});

const agentWithExtraTools = JSON.stringify({
  id: "custom-tools",
  name: "自定义工具 Agent",
  system: "你有自定义工具可用",
  extraTools: [
    {
      name: "my_custom_tool",
      description: "我的自定义工具",
      parameters: { type: "object", properties: { input: { type: "string" } } },
    },
  ],
});

const agentWithMcp = JSON.stringify({
  id: "mcp-agent",
  name: "MCP Agent",
  system: "你可以用 MCP 工具",
  mcpServers: ["my-db-server"],
});

const agentNoTools = JSON.stringify({
  id: "no-tools",
  name: "无工具 Agent",
  system: "你没有任何工具声明",
});

// ==================== 测试 ====================

beforeEach(() => {
  vol.clear();
});

describe("discoverSubAgents", () => {
  it("目录不存在时返回空数组", async () => {
    const agents = await discoverSubAgents();
    expect(agents).toEqual([]);
  });

  it("发现全局目录中的 JSON 子 Agent", async () => {
    vol.set("/mock/.ai-zen/sub-agents/test-agent.json", validJsonAgent);
    vol.set("/mock/.ai-zen/sub-agents", "");

    const agents = await discoverSubAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].id).toBe("test-agent");
    expect(agents[0].name).toBe("测试助手");
  });

  it("从 system 简写自动构建消息列表", async () => {
    vol.set("/mock/.ai-zen/sub-agents/test-agent.json", validJsonAgent);
    vol.set("/mock/.ai-zen/sub-agents", "");

    const agents = await discoverSubAgents();
    expect(agents[0].messages.length).toBe(2);
    expect(agents[0].messages[0].role).toBe("system");
    expect(agents[0].messages[0].content).toBe("你是测试助手，请完成以下任务。");
    expect(agents[0].messages[1].role).toBe("user");
    expect(agents[0].messages[1].content).toBe("{{query}}");
  });

  it("自动生成默认 function 定义", async () => {
    vol.set("/mock/.ai-zen/sub-agents/test-agent.json", validJsonAgent);
    vol.set("/mock/.ai-zen/sub-agents", "");

    const agents = await discoverSubAgents();
    expect(agents[0].function.name).toBe("test_agent");
    expect(agents[0].function.parameters.properties.query).toBeDefined();
    expect(agents[0].function.parameters.required).toContain("query");
  });

  it("使用自定义消息列表和 function", async () => {
    vol.set("/mock/.ai-zen/sub-agents/multi-msg.json", agentWithMessages);
    vol.set("/mock/.ai-zen/sub-agents", "");

    const agents = await discoverSubAgents();
    expect(agents[0].messages.length).toBe(2);
    expect(agents[0].function.name).toBe("expert_help");
    expect(agents[0].function.parameters.properties.task).toBeDefined();
  });

  it("跳过隐藏文件", async () => {
    vol.set("/mock/.ai-zen/sub-agents/.hidden.json", validJsonAgent);
    vol.set("/mock/.ai-zen/sub-agents", "");

    const agents = await discoverSubAgents();
    expect(agents.length).toBe(0);
  });

  it("跳过非 JSON/JS 文件", async () => {
    vol.set("/mock/.ai-zen/sub-agents/readme.txt", "hello");
    vol.set("/mock/.ai-zen/sub-agents", "");

    const agents = await discoverSubAgents();
    expect(agents.length).toBe(0);
  });

  it("损坏的 JSON 文件被跳过", async () => {
    vol.set("/mock/.ai-zen/sub-agents/bad.json", "not json");
    vol.set("/mock/.ai-zen/sub-agents", "");

    const agents = await discoverSubAgents();
    expect(agents.length).toBe(0);
  });

  it("同时发现多个子 Agent", async () => {
    vol.set("/mock/.ai-zen/sub-agents/agent-a.json", JSON.stringify({
      id: "agent-a", name: "Agent A", system: "A",
    }));
    vol.set("/mock/.ai-zen/sub-agents/agent-b.json", JSON.stringify({
      id: "agent-b", name: "Agent B", system: "B",
    }));
    vol.set("/mock/.ai-zen/sub-agents", "");

    const agents = await discoverSubAgents();
    expect(agents.length).toBe(2);
  });
});

describe("resolveSubAgentTools", () => {
  it("按名称解析工具", () => {
    const config: SubAgentConfig = {
      id: "test",
      name: "Test",
      messages: [{ role: "system", content: "test" }],
      function: { name: "test", description: "test", parameters: {} },
      tools: ["readFile", "exec"],
      createdAt: "",
      updatedAt: "",
    };

    const { tools } = resolveSubAgentTools(config);
    expect(tools.length).toBe(2);
    expect(tools[0].function.name).toBe("readFile");
    expect(tools[1].function.name).toBe("exec");
  });

  it("不存在的工具名称被跳过", () => {
    const config: SubAgentConfig = {
      id: "test",
      name: "Test",
      messages: [{ role: "system", content: "test" }],
      function: { name: "test", description: "test", parameters: {} },
      tools: ["non_existent_tool"],
      createdAt: "",
      updatedAt: "",
    };

    const { tools } = resolveSubAgentTools(config);
    expect(tools.length).toBe(0);
  });

  it("内联注册的自定义工具", () => {
    const config: SubAgentConfig = {
      id: "test",
      name: "Test",
      messages: [{ role: "system", content: "test" }],
      function: { name: "test", description: "test", parameters: {} },
      extraTools: [
        {
          name: "custom_tool",
          description: "自定义工具",
          parameters: { type: "object", properties: {} },
        },
      ],
      createdAt: "",
      updatedAt: "",
    };

    const { tools } = resolveSubAgentTools(config);
    expect(tools.length).toBe(1);
    expect(tools[0].function.name).toBe("custom_tool");
  });

  it("引用 MCP 服务器工具", () => {
    const config: SubAgentConfig = {
      id: "test",
      name: "Test",
      messages: [{ role: "system", content: "test" }],
      function: { name: "test", description: "test", parameters: {} },
      mcpServers: ["my-db-server"],
      createdAt: "",
      updatedAt: "",
    };

    const { mcpTools } = resolveSubAgentTools(config);
    expect(mcpTools.length).toBe(1);
    expect(mcpTools[0].function.name).toBe("db_query");
  });

  it("不存在的 MCP 服务器被跳过", () => {
    const config: SubAgentConfig = {
      id: "test",
      name: "Test",
      messages: [{ role: "system", content: "test" }],
      function: { name: "test", description: "test", parameters: {} },
      mcpServers: ["non-existent-server"],
      createdAt: "",
      updatedAt: "",
    };

    const { mcpTools } = resolveSubAgentTools(config);
    expect(mcpTools.length).toBe(0);
  });

  it("同时解析 tools、extraTools 和 mcpServers", () => {
    const config: SubAgentConfig = {
      id: "test",
      name: "Test",
      messages: [{ role: "system", content: "test" }],
      function: { name: "test", description: "test", parameters: {} },
      tools: ["readFile"],
      extraTools: [
        {
          name: "custom_tool",
          description: "自定义",
          parameters: { type: "object", properties: {} },
        },
      ],
      mcpServers: ["my-db-server"],
      createdAt: "",
      updatedAt: "",
    };

    const { tools, mcpTools } = resolveSubAgentTools(config);
    expect(tools.length).toBe(2); // readFile + custom_tool
    expect(mcpTools.length).toBe(1); // db_query
  });

  it("没有声明任何工具时返回空", () => {
    const config: SubAgentConfig = {
      id: "test",
      name: "Test",
      messages: [{ role: "system", content: "test" }],
      function: { name: "test", description: "test", parameters: {} },
      createdAt: "",
      updatedAt: "",
    };

    const { tools, mcpTools } = resolveSubAgentTools(config);
    expect(tools.length).toBe(0);
    expect(mcpTools.length).toBe(0);
  });
});
