import { describe, it, expect } from "vitest";
import { createAgent } from "../src/runtime/factory";
import type { AgentDefinition, AppConfig } from "../src/types";

const config: AppConfig = {
  defaultModel: "gpt4",
  endpoints: [
    { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: "sk-xxx" },
  ],
  models: [
    { id: "gpt4", name: "GPT-4", endpointId: "openai", maxContextChars: 500000 },
  ],
};

const agentDef: AgentDefinition = {
  id: "my-agent",
  name: "My Agent",
  messages: [
    { role: "system", content: "你是一个专业的代码助手。" },
  ],
  permissions: {
    tools: { allow: ["readFile", "exec", "glob", "findText"] },
    skills: { allow: ["code-review"] },
    mcps: { deny: ["*"] },
    subagents: { allow: ["general_assistant"] },
  },
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

describe("集成：端到端 Agent 组装", () => {
  it("完整链路：配置 + 定义 + 候选 → 可运行的 Agent", () => {
    const resolved = createAgent({
      definition: agentDef,
      config,
      builtinTools: ["readFile", "exec", "rm", "glob", "findText", "writeFile"],
      subagents: ["general_assistant", "code-reviewer"],
      skills: [
        { id: "code-review", description: "代码审查" },
        { id: "deploy", description: "部署" },
      ],
      mcps: [
        { id: "github", description: "GitHub API" },
      ],
    });

    // 模型解析
    expect(resolved.model.id).toBe("gpt4");
    expect(resolved.model.maxContextChars).toBe(500000);

    // System prompt
    expect(resolved.systemPrompt).toBe("你是一个专业的代码助手。");

    // 工具：allow 白名单生效
    expect(resolved.capabilities.tools).toContain("readFile");
    expect(resolved.capabilities.tools).toContain("exec");
    expect(resolved.capabilities.tools).toContain("glob");
    expect(resolved.capabilities.tools).toContain("findText");
    expect(resolved.capabilities.tools).not.toContain("rm"); // 不在 allow
    expect(resolved.capabilities.tools).not.toContain("writeFile"); // 不在 allow

    // 动态加载工具也在 tools 中（tools 维度全开）
    // load_mcp 应在（tools allow 没拒绝），但 mcps deny: ['*'] → 无枚举
    expect(resolved.capabilities.mcpParam.enum).toBeUndefined();
    expect(resolved.capabilities.mcpParam.description).toContain("当前没有可用的 MCP 服务器");

    // skills: allow: ["code-review"] — deploy 被过滤
    expect(resolved.capabilities.skillParam.enum).toEqual(["code-review"]);

    // subagents: allow: ["general_assistant"] — code-reviewer 被过滤
    expect(resolved.capabilities.subagents).toEqual(["general_assistant"]);
  });
});
