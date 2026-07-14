import { describe, it, expect } from "vitest";
import { createAgent } from "../src/runtime/factory";
import type { AgentDefinition, AppConfig } from "../src/types";
import { CallbackTool } from "@ai-zen/agents-core";
import type { Tool } from "@ai-zen/agents-core";

function makeTool(name: string): Tool {
  return new CallbackTool({
    function: { name, description: `${name} tool`, parameters: { type: "object", properties: {}, required: [] } },
    callback: async () => name,
  });
}

const config: AppConfig = {
  defaultModel: "gpt4",
  endpoints: [
    { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", apiKey: "sk-xxx" },
  ],
  models: [
    { id: "gpt4", name: "GPT-4", endpointId: "openai", maxContextTokens: 500000 },
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
      builtinTools: ["readFile", "exec", "rm", "glob", "findText", "writeFile"].map(makeTool),
      subagents: [
        {
          id: "ga", name: "ga",
          messages: [{ role: "system", content: "Hi" }, { role: "user", content: "{{task}}" }],
          function: { name: "general_assistant", description: "", parameters: { type: "object", properties: {}, required: [] } },
          createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
        },
        {
          id: "cr", name: "cr",
          messages: [{ role: "system", content: "Hi" }, { role: "user", content: "{{task}}" }],
          function: { name: "code-reviewer", description: "", parameters: { type: "object", properties: {}, required: [] } },
          createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z",
        },
      ],
      skills: [
        { id: "code-review", description: "代码审查" },
        { id: "deploy", description: "部署" },
      ],
      mcps: [
        { id: "github", description: "GitHub API" },
      ],
    });

    expect(resolved.model.id).toBe("gpt4");
    expect(resolved.definition.messages[0].content).toBe("你是一个专业的代码助手。");

    const toolNamesResult = resolved.capabilities.tools.map((t: Tool) => t.function.name);
    expect(toolNamesResult).toContain("readFile");
    expect(toolNamesResult).toContain("exec");
    expect(toolNamesResult).toContain("glob");
    expect(toolNamesResult).toContain("findText");
    expect(toolNamesResult).not.toContain("rm");
    expect(toolNamesResult).not.toContain("writeFile");

    // subagents: allow: ["general_assistant"] — code-reviewer 被过滤
    expect(toolNamesResult).toContain("general_assistant");
    expect(toolNamesResult).not.toContain("code-reviewer");
  });
});
