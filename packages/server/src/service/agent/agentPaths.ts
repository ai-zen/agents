/**
 * 一个工作区里「能力发现」要看哪些路径。
 *
 * 纯路径计算：`aiZenDir` / `workspacePath` / `homeDir` 全由调用方给，本模块不读任何
 * 进程级全局（那道 grep 闸门管着）。因此在同一个进程里可以同时服务多个工作区 ——
 * 这是把装配搬进服务端的前提。
 *
 * **顺序就是优先级**（高 → 低），不是随便排的：
 *   - 项目级覆盖用户级（`<ws>/.ai-zen/skills` 先于 `~/.ai-zen/skills`）；
 *   - 自家目录优先于业界通用的 `.agents`（同层）；
 *   - MCP 配置里 `<ws>/.mcp.json` 最高（Cline / Cursor 认这个位置，用户改它不该输给别处）。
 */

import { join } from "node:path";

export interface AgentPathsInput {
  /** 配置根（`~/.ai-zen`） */
  aiZenDir: string;
  /** 工作区根（Agent 的 cwd：项目级配置、工具、相对路径都以它为基准） */
  workspacePath: string;
  /** 用户主目录（业界通用规范 `~/.agents` 的位置） */
  homeDir: string;
}

export interface AgentPaths {
  /** `<aiZenDir>/config.json` */
  configFile: string;
  /**
   * 工作区根 —— **Agent 的 cwd**（工具相对路径的基准）。
   *
   * 它必须从这里递出去：`Scope` 的 `cwd` 缺省取**进程的当前目录**，而服务端进程的 cwd
   * 是守护进程**被拉起时**的目录，与调用方要跑的那个工作区毫无关系。少传这一层的后果
   * 很安静：`@` 补全列的是工作区 B 的文件，`exec pwd` 与 `read src/x.ts` 却落在目录 A。
   */
  workspacePath: string;
  /** Agent 定义目录（`<aiZenDir>/agents`） */
  agentsDir: string;
  /** 子 Agent 目录，高 → 低 */
  subAgentsDirs: string[];
  /** Skill 目录，高 → 低 */
  skillsDirs: string[];
  /** 用户工具目录，高 → 低 */
  toolsDirs: string[];
  /** MCP 配置文件，高 → 低 */
  mcpConfigs: string[];
}

export function agentPaths(input: AgentPathsInput): AgentPaths {
  const project = join(input.workspacePath, ".ai-zen");
  const projectAgents = join(input.workspacePath, ".agents");
  const userAgents = join(input.homeDir, ".agents");
  const global = globalAgentPaths(input);

  return {
    ...global,
    workspacePath: input.workspacePath,
    subAgentsDirs: [join(project, "sub-agents"), join(input.aiZenDir, "sub-agents")],
    skillsDirs: [
      join(project, "skills"),
      join(projectAgents, "skills"),
      join(input.aiZenDir, "skills"),
      join(userAgents, "skills"),
    ],
    toolsDirs: [join(project, "tools"), join(input.aiZenDir, "tools")],
    mcpConfigs: [
      join(input.workspacePath, ".mcp.json"),
      join(project, "mcp.json"),
      join(projectAgents, "mcp.json"),
      join(input.aiZenDir, "mcp.json"),
      join(userAgents, "mcp.json"),
    ],
  };
}

/**
 * 与工作区无关的那几项：配置与 Agent 定义。
 *
 * 单独抽出来是因为改 Agent 定义（`/model` 写 `modelId`）不需要工作区 —— 它改的是
 * 全局的那份定义，影响的是所有用这个 Agent 的会话。
 */
export function globalAgentPaths(input: { aiZenDir: string; homeDir: string }): {
  configFile: string;
  agentsDir: string;
} {
  return {
    configFile: join(input.aiZenDir, "config.json"),
    agentsDir: join(input.aiZenDir, "agents"),
  };
}
