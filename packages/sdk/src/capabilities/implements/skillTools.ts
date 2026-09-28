import { CallbackTool, Agent, AgentToolLazy, Message, type ToolCallContext } from "@ai-zen/agents-core";
import type { SkillInfo } from "../discovery/skills.js";
import { createDisclosureParam } from "../disclosure.js";
import { readSkill } from "../discovery/skills.js";
import { getLogger } from "../../shared/logger.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";

const log = getLogger();

const EMPTY_HINT = "（当前没有可用的 Skill，请联系用户添加）";

/**
 * 创建 load_skill 工具。
 * 枚举所有允许的 skill（不限是否支持子 Agent），由 filteredSkills 提供完整信息。
 */
export function createLoadSkillTool(
  skillDirs: string[],
  filteredSkills: SkillInfo[],
): CallbackTool {
  const ids = filteredSkills.map((s) => s.id);
  const param = createDisclosureParam(ids, "选择一个 Skill", EMPTY_HINT);

  // 拼接各 skill 的描述供 LLM 参考
  const skillDescriptions = filteredSkills
    .map((s) => `  - ${s.id}: ${s.description || "无描述"}`)
    .join("\n");
  const skillIdDescription = `${param.description}\n\n各 Skill 说明：\n${skillDescriptions || "  无可用 Skill"}`;

  return new CallbackTool({
    function: {
      name: "load_skill",
      description: "加载指定 Skill 的完整指导文档。Skill 是预制的专业指导，加载后展开到上下文中。",
      parameters: {
        type: "object",
        properties: {
          skill_id: {
            type: "string",
            description: skillIdDescription,
            ...(param.enum ? { enum: param.enum } : {}),
          },
        },
        required: ["skill_id"],
        additionalProperties: false,
      },
    },
    callback: async function (input: Record<string, unknown>): Promise<string> {
      const skillId = input.skill_id as string;
      const skill = await readSkill(skillDirs, skillId);
      if (!skill) {
        return `❌ Skill "${skillId}" 不存在，请确认名称是否正确`;
      }

      // 扫描 skill 目录下的文件列表
      let fileList = "";
      try {
        const entries = await fs.readdir(skill.dirPath, { withFileTypes: true });
        const files = entries.map((e) => {
          const suffix = e.isDirectory() ? "/" : "";
          return `  - ${e.name}${suffix}`;
        });
        fileList = `\n\nSkill 目录文件列表：\n${files.join("\n")}`;
      } catch {
        fileList = "";
      }

      return [
        `Skill "${skillId}" 已加载：`,
        ``,
        `Skill 目录路径: ${skill.dirPath}`,
        fileList,
        ``,
        `--- Skill 内容开始 ---`,
        skill.content,
      ].join("\n");
    },
  });
}

/**
 * 创建 call_skill_sub_agent 工具。
 * 只展示 subAgent: true 的 Skill，枚举中自动排除不支持子 Agent 模式的 skill。
 *
 * 工具由 AgentToolLazy 承载：子 Agent 在 exec 时构建，从而复用统一的委派边界
 * （onSubAgentStart / onSubAgentEnd 钩子与 sub-agent-start / sub-agent-end 事件）。
 * 子 Agent 沿用父 Agent 的工具能力（不做权限过滤），但剔除 call_skill_sub_agent 自身，
 * 避免 skill 链式自递归。
 */
export function createCallSkillSubAgentTool(
  skillDirs: string[],
  filteredSkills: SkillInfo[],
): AgentToolLazy {
  // 只保留支持子 Agent 模式的 skill
  const subAgentSkills = filteredSkills.filter((s) => s.subAgent);
  const ids = subAgentSkills.map((s) => s.id);
  const param = createDisclosureParam(ids, "选择一个 Skill（支持子 Agent）", EMPTY_HINT);

  // 拼接各 skill 的描述供 LLM 参考
  const skillDescriptions = subAgentSkills
    .map((s) => `  - ${s.id}: ${s.description || "无描述"}`)
    .join("\n");
  const skillIdDescription = `${param.description}\n\n各 Skill 说明：\n${skillDescriptions || "  无可用 Skill"}`;

  return new AgentToolLazy({
    function: {
      name: "call_skill_sub_agent",
      description: "将任务委派给指定的 Skill 子 Agent，由其独立完成并返回结果。",
      parameters: {
        type: "object",
        properties: {
          skill_id: {
            type: "string",
            description: skillIdDescription,
            ...(param.enum ? { enum: param.enum } : {}),
          },
          task: {
            type: "string",
            description: "要委派给子 Agent 完成的任务描述",
          },
        },
        required: ["skill_id", "task"],
        additionalProperties: false,
      },
    },
    // 初始消息依赖运行时参数（skill_id → SKILL.md 内容），故不传 messages 模板，
    // 由 buildAgent 读取 SKILL.md 后自行决定；abort 联动与委派边界由 AgentToolLazy 统一处理
    buildAgent: async (
      parsedArgs: Record<string, unknown>,
      ctx: ToolCallContext,
    ): Promise<Agent> => {
      const skillId = parsedArgs.skill_id as string;
      const task = parsedArgs.task as string;
      const skill = await readSkill(skillDirs, skillId);
      if (!skill) {
        throw new Error(`❌ Skill "${skillId}" 不存在，请确认名称是否正确`);
      }
      if (!skill.subAgent) {
        throw new Error(
          `Skill "${skillId}" 不支持子 Agent 模式，请使用 load_skill 加载指导后自行处理`,
        );
      }

      // 沿用父 Agent 的工具能力（不做权限过滤），剔除自身以防自递归
      const parentAgent = ctx.agent;
      const tools = parentAgent.tools.filter(
        (t) => t.function.name !== "call_skill_sub_agent",
      );

      return new Agent({
        client: parentAgent.client,
        model: parentAgent.model,
        modelConfig: parentAgent.modelConfig,
        messages: [Message.System(skill.content), Message.User(task)],
        tools,
      });
    },
  });
}
