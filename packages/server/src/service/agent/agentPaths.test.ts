import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { agentPaths } from "./agentPaths.js";

const base = { aiZenDir: "/zen", workspacePath: "/work/proj", homeDir: "/home/u" };

describe("agentPaths", () => {
  it("全局路径挂在配置根下，Agent 定义也在那里", () => {
    const paths = agentPaths(base);
    expect(paths.configFile).toBe(join("/zen", "config.json"));
    expect(paths.agentsDir).toBe(join("/zen", "agents"));
  });

  it("项目级覆盖用户级、经 .ai-zen 优先于业界通用的 .agents（顺序即优先级）", () => {
    const paths = agentPaths(base);
    expect(paths.skillsDirs).toEqual([
      join("/work/proj", ".ai-zen", "skills"),
      join("/work/proj", ".agents", "skills"),
      join("/zen", "skills"),
      join("/home/u", ".agents", "skills"),
    ]);
  });

  it("MCP 配置五层，项目根的 .mcp.json 最高（Cline / Cursor 认这个位置）", () => {
    const paths = agentPaths(base);
    expect(paths.mcpConfigs).toEqual([
      join("/work/proj", ".mcp.json"),
      join("/work/proj", ".ai-zen", "mcp.json"),
      join("/work/proj", ".agents", "mcp.json"),
      join("/zen", "mcp.json"),
      join("/home/u", ".agents", "mcp.json"),
    ]);
  });

  it("子 Agent 与工具：项目级在前", () => {
    const paths = agentPaths(base);
    expect(paths.subAgentsDirs).toEqual([join("/work/proj", ".ai-zen", "sub-agents"), join("/zen", "sub-agents")]);
    expect(paths.toolsDirs).toEqual([join("/work/proj", ".ai-zen", "tools"), join("/zen", "tools")]);
  });

  it("换个工作区就换一套项目级路径，全局那几层不变", () => {
    const a = agentPaths(base);
    const b = agentPaths({ ...base, workspacePath: "/work/other" });
    expect(a.skillsDirs[0]).not.toBe(b.skillsDirs[0]);
    expect(a.skillsDirs[2]).toBe(b.skillsDirs[2]); // ~/.ai-zen/skills 相同
    expect(a.configFile).toBe(b.configFile);
  });
});
