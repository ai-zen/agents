import { join } from "node:path";

import {
  discoverSkills,
  discoverSubAgents,
  discoverUserToolFiles,
  type AgentDefinition,
  type SkillInfo,
  type UserToolFile,
} from "@ai-zen/agents-sdk";

export interface DiscoveryDeps {
  /** 数据根：`config.json` 所在目录 */
  readonly dataRoot: string;
  /** 用户主目录：`~/.agents/...` 那几层在它下面 */
  readonly homeDir: string;
}

/**
 * 三种能力各自的目录列表交给 SDK 的发现函数，本类只算「去哪几个目录找」。
 *
 * 工具的发现会 `import()` 用户写的脚本：这条路执行用户代码，这是工具的定义方式 —— 不求值就不知道
 * 这个工具叫什么名字、接受哪些参数。
 *
 * 一种能力一次把各层目录全交给 SDK，不逐层调回来自己合并：「同名以近的为准」在 SDK 里已经有一份
 * 实现，在这里再写一遍就是同一条规则的第二份。三种能力对「近层那份读不出来时算不算占住了这个
 * 名字」并不一致（工具是先占名字再加载，Skill 与 subagent 是读成功才占），这个差异也留在 SDK 里，
 * 不在这里抹平。
 *
 * 读不出来的目录与文件不进返回值：界面要的是「现在能用什么」。列一条带原因的坏条目，客户端还得
 * 自己判一次这一条能不能用，那份判断迟早会长出第二个版本。
 *
 * 不接日志口：那几个发现函数不给 `logger` 就什么都不记。等 `config/` 下有了统一的日志口再接，
 * 现在加可选字段等于留一个永远不填的参数。
 */
export class Discovery {
  constructor(private readonly deps: DiscoveryDeps) {}

  /**
   * 返回 SDK 发现出来的整份 `SkillInfo`（带着 SKILL.md 正文），不在这里投影成几格。这一层现在没有
   * 消费者，投影出来的字段只是猜的；有消费者时按它真正读的那几格再定。
   */
  skills(cwd: string): Promise<SkillInfo[]> {
    return discoverSkills(this.skillDirs(cwd));
  }

  tools(cwd: string): Promise<UserToolFile[]> {
    return discoverUserToolFiles(this.toolDirs(cwd));
  }

  subagents(cwd: string): Promise<AgentDefinition[]> {
    return discoverSubAgents(this.subAgentDirs(cwd));
  }

  /**
   * 近的在前。项目里的 `.ai-zen/skills` 排在同一个项目下的 `.agents/skills` 前面：前者是宿主自己的
   * 目录，后者与别的工具共用，同名时以宿主那一份为准。
   */
  private skillDirs(cwd: string): string[] {
    return [
      join(cwd, ".ai-zen", "skills"),
      join(cwd, ".agents", "skills"),
      join(this.deps.dataRoot, "skills"),
      join(this.deps.homeDir, ".agents", "skills"),
    ];
  }

  /** 项目里的 `tools/` 只在 `.agents/` 下：与 Skill 不同，这一层没有 `.ai-zen/tools` */
  private toolDirs(cwd: string): string[] {
    return [join(cwd, ".agents", "tools"), join(this.deps.dataRoot, "tools")];
  }

  /**
   * 项目里的 `sub-agents/` 同样只在 `.agents/` 下。数据根下的顶层助手定义在 `agents/`，与
   * `sub-agents/` 分开放：那一个目录不是 subagent 的来源，不要顺手加进这张列表。
   */
  private subAgentDirs(cwd: string): string[] {
    return [join(cwd, ".agents", "sub-agents"), join(this.deps.dataRoot, "sub-agents")];
  }
}
