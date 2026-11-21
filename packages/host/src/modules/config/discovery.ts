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
 * 一种能力。值就是它在各层目录下的子目录名：目录名与 SDK 选项名对不上的只有 subagent 那一种
 * （`sub-agents` 对着 `subAgentsPaths`），那个对不上的地方只在 {@link Discovery.abilityPaths} 里写一次。
 */
type Ability = "skills" | "tools" | "sub-agents";

/**
 * 三种能力的来源目录，键名就是 `allInOne` 的选项名：这份值直接交给它，中间不再转一次。
 *
 * 没有 `mcpPaths`：MCP 要的是五个配置文件路径，而 `McpConfig` 合并出来的是一份清单，两者
 * 怎么接还没定。不传这一格，运行期一个 MCP 服务器都连不上。
 */
export interface AbilityPaths {
  readonly skillsPaths: string[];
  readonly toolsPaths: string[];
  readonly subAgentsPaths: string[];
}

/** 一层来源：根目录、根下放能力的目录，以及这一层有哪些能力 */
interface Layer {
  readonly root: string;
  /** `""` 表示能力的子目录直接挂在根下 */
  readonly base: string;
  readonly abilities: readonly Ability[];
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
 * 层表只有 {@link layers} 一份，四种用途都从它投影：层序、各层有哪些能力都只写在那里。按能力各写
 * 一份目录拼接的话，「`sub-agents` 只在 `.agents` 下」这类差别就会有四处要改。
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
   * 喂给 `allInOne` 的那三格。近的在前。
   *
   * `agentsDir` 不在这里：助手定义只有数据根下一处，与项目无关，`Scope` 自己收它。
   */
  abilityPaths(cwd: string): AbilityPaths {
    return {
      skillsPaths: this.dirs(cwd, "skills"),
      toolsPaths: this.dirs(cwd, "tools"),
      subAgentsPaths: this.dirs(cwd, "sub-agents"),
    };
  }

  /**
   * 返回 SDK 发现出来的整份 `SkillInfo`（带着 SKILL.md 正文），不在这里投影成几格。这一层现在没有
   * 消费者，投影出来的字段只是猜的；有消费者时按它真正读的那几格再定。
   */
  skills(cwd: string): Promise<SkillInfo[]> {
    return discoverSkills(this.dirs(cwd, "skills"));
  }

  tools(cwd: string): Promise<UserToolFile[]> {
    return discoverUserToolFiles(this.dirs(cwd, "tools"));
  }

  subagents(cwd: string): Promise<AgentDefinition[]> {
    return discoverSubAgents(this.dirs(cwd, "sub-agents"));
  }

  /**
   * 由近及远。项目里宿主自己的目录 `.ai-zen` 只放 Skill：用户工具与 subagent 的约定目录都在
   * `.agents` 下，数据根那一层同理 —— 顶层助手定义在 `agents/`，而那个目录不是 subagent 的来源。
   *
   * `.ai-zen/skills` 排在同一个项目下 `.agents/skills` 前面：前者是宿主自己的目录，后者与别的
   * 工具共用，同名时以宿主那一份为准。
   */
  private layers(cwd: string): readonly Layer[] {
    return [
      { root: cwd, base: ".ai-zen", abilities: ["skills"] },
      { root: cwd, base: ".agents", abilities: ["skills", "tools", "sub-agents"] },
      { root: this.deps.dataRoot, base: "", abilities: ["skills", "tools", "sub-agents"] },
      { root: this.deps.homeDir, base: ".agents", abilities: ["skills"] },
    ];
  }

  private dirs(cwd: string, ability: Ability): string[] {
    return this.layers(cwd)
      .filter((layer) => layer.abilities.includes(ability))
      .map((layer) => join(layer.root, layer.base, ability));
  }
}
