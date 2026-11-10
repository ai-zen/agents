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
 *
 * 技能与工具的目录按**层**（项目 / 全局）由 `assetDirs` 一处给出：发现用的是它的合并
 * 顺序，`asset.list` 的 `source` 标注与「只看某一层」也读同一份。分开写两份，就会出现
 * 「Agent 装的是这些、清单里列的是另一些」那种只差一个目录的慢性病。
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
  const assets = assetDirs({
    aiZenDir: input.aiZenDir,
    homeDir: input.homeDir,
    workspacePath: input.workspacePath,
  });

  return {
    ...global,
    workspacePath: input.workspacePath,
    subAgentsDirs: [join(project, "sub-agents"), join(input.aiZenDir, "sub-agents")],
    // 技能与工具目录由 `assetDirs` 给（它就是「哪一层扫哪些目录」的唯一定义处）：
    // 发现用的顺序 = “项目层在前、全局层在后”，与资产清单里的 `source` 同源
    skillsDirs: assets.skillsDirs,
    toolsDirs: assets.toolsDirs,
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
 * 一层资产（技能 + 用户工具）的目录表。
 *
 * 为什么要分「层」而不是只给一个合并后的列表：`asset.list` 需要告诉客户端每条资产
 * **来自哪一层**（`global` / `project`），而「哪一层扫哪些目录」必须只有一处定义 ——
 * 在这里再分一份，就会出现「Agent 装的是这些、清单里列的是另一些」那种只差一个目录的
 * 慢性病。所以：分层的真相在这里，合并的顺序也在这里（项目层在前 = 优先级高）。
 *
 * `workspacePath: null` = 不问项目层（纯全局调用，例如 `asset.list {scope:"global"}`）。
 */
export function assetDirs(input: {
  aiZenDir: string;
  homeDir: string;
  workspacePath: string | null;
}): {
  /** 项目层（`null` workspacePath 时两项都是空表） */
  project: { skillsDirs: string[]; toolsDirs: string[] };
  /** 全局层 */
  global: { skillsDirs: string[]; toolsDirs: string[] };
  /** 发现用的合并顺序：项目层在前（同名时项目覆盖全局） */
  skillsDirs: string[];
  toolsDirs: string[];
} {
  const project = {
    skillsDirs: input.workspacePath ? projectSkillsDirs(input.workspacePath) : [],
    toolsDirs: input.workspacePath ? projectToolsDirs(input.workspacePath) : [],
  };
  const global = {
    skillsDirs: globalSkillsDirs(input),
    toolsDirs: globalToolsDirs(input),
  };
  return {
    project,
    global,
    skillsDirs: [...project.skillsDirs, ...global.skillsDirs],
    toolsDirs: [...project.toolsDirs, ...global.toolsDirs],
  };
}

/** 项目级技能目录：挂在工作区路径下（`<ws>/.ai-zen` 优先于 `<ws>/.agents`） */
export function projectSkillsDirs(workspacePath: string): string[] {
  return [join(workspacePath, ".ai-zen", "skills"), join(workspacePath, ".agents", "skills")];
}

/** 全局技能目录（用户主目录那层 `~/.agents` 是业界通用位置，排在自家目录之后） */
export function globalSkillsDirs(input: { aiZenDir: string; homeDir: string }): string[] {
  return [join(input.aiZenDir, "skills"), join(input.homeDir, ".agents", "skills")];
}

/** 项目级用户工具目录 */
export function projectToolsDirs(workspacePath: string): string[] {
  return [join(workspacePath, ".ai-zen", "tools")];
}

/** 全局用户工具目录 */
export function globalToolsDirs(input: { aiZenDir: string }): string[] {
  return [join(input.aiZenDir, "tools")];
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
