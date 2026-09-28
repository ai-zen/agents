import type { Tool } from "@ai-zen/agents-core";
import { isAbsolute, join } from "node:path";
import type { SkillInfo } from "./discover.js";
import { discoverSkills } from "./discover.js";
import {
  createCallSkillSubAgentTool,
  createLoadSkillTool,
} from "./skillTools.js";
import type { Scope, FilterOutput } from "../../Scope.js";
import type { ScopeCandidates, ScopePlugin } from "../../ScopePlugin.js";

/**
 * Skill 插件 —— 发现 SKILL.md + 装配渐进式披露元工具。
 *
 * 渐进式披露设计原样保留：
 *   - `load_skill`            枚举所有允许的 skill
 *   - `call_skill_sub_agent`  枚举 subAgent: true 的 skill（AgentToolLazy）
 * 两个元工具名恒上报 `tools` 维度（供权限允许/拒绝 → 拒绝即切断披露通道）；
 * 是否真正注册由 `instantiate()` 按允许名 + 候选条件决定。
 */
export class SkillsScopePlugin implements ScopePlugin {
  static readonly ID = "skills";
  readonly id = SkillsScopePlugin.ID;

  private readonly paths: string[];
  private skills: SkillInfo[] = [];
  /** 解析后的 skill 目录（供 instantiate 时传给工具读取正文） */
  private dirs: string[] = [];

  constructor(options?: { paths?: string[] }) {
    this.paths = options?.paths ?? [];
  }

  async discover(
    scope: Scope,
    options?: { silent?: boolean },
  ): Promise<void> {
    this.dirs = this.paths.map((p) => (isAbsolute(p) ? p : join(scope.cwd, p)));
    this.skills = await discoverSkills(this.dirs, options);
  }

  candidates(): ScopeCandidates {
    return {
      skills: this.skills.map((s) => s.id),
      tools: ["load_skill", "call_skill_sub_agent"],
    };
  }

  instantiate(_scope: Scope, filtered: FilterOutput): Tool[] {
    const allow = new Set(filtered.tools);
    const allowedSkills = new Set(filtered.skills);
    const filteredSkills = this.skills.filter((s) => allowedSkills.has(s.id));

    const result: Tool[] = [];
    if (allow.has("load_skill") && filteredSkills.length > 0) {
      result.push(createLoadSkillTool(this.dirs, filteredSkills));
    }
    // call_skill_sub_agent：只要有支持子 Agent 的 skill 就注册
    if (
      allow.has("call_skill_sub_agent") &&
      filteredSkills.some((s) => s.subAgent)
    ) {
      result.push(createCallSkillSubAgentTool(this.dirs, filteredSkills));
    }
    return result;
  }
}
