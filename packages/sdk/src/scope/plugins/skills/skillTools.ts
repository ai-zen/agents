import { CallbackTool, Agent, AgentToolLazy, Message, type ToolCallContext } from "@ai-zen/agents-core";
import type { SkillInfo } from "./discover.js";
import { createDisclosureParam } from "../../disclosure.js";
import { readSkill } from "./discover.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";

const EMPTY_HINT = "(No Skills are currently available, please ask the user to add one)";

/**
 * 创建 load_skill 工具。
 * 枚举所有允许的 skill（不限是否支持子 Agent），由 filteredSkills 提供完整信息。
 */
export function createLoadSkillTool(
  skillDirs: string[],
  filteredSkills: SkillInfo[],
): CallbackTool {
  const ids = filteredSkills.map((s) => s.id);
  const param = createDisclosureParam(ids, "Select a Skill", EMPTY_HINT);

  // 拼接各 skill 的描述供 LLM 参考
  const skillDescriptions = filteredSkills
    .map((s) => `  - ${s.id}: ${s.description || "No description"}`)
    .join("\n");
  const skillIdDescription = `${param.description}\n\nSkill descriptions:\n${skillDescriptions || "  No Skills available"}`;

  return new CallbackTool({
    function: {
      name: "load_skill",
      description: "Load the full guidance document of a Skill. A Skill is pre-authored expert guidance that is expanded into the context once loaded.",
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
        return `❌ Skill "${skillId}" not found, please verify the name`;
      }

      // 扫描 skill 目录下的文件列表
      let fileList = "";
      try {
        const entries = await fs.readdir(skill.dirPath, { withFileTypes: true });
        const files = entries.map((e) => {
          const suffix = e.isDirectory() ? "/" : "";
          return `  - ${e.name}${suffix}`;
        });
        fileList = `\n\nSkill directory files:\n${files.join("\n")}`;
      } catch {
        fileList = "";
      }

      return [
        `Skill "${skillId}" loaded:`,
        ``,
        `Skill directory path: ${skill.dirPath}`,
        fileList,
        ``,
        `--- Skill content starts ---`,
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
  const param = createDisclosureParam(ids, "Select a Skill that supports SubAgent mode", EMPTY_HINT);

  // 拼接各 skill 的描述供 LLM 参考
  const skillDescriptions = subAgentSkills
    .map((s) => `  - ${s.id}: ${s.description || "No description"}`)
    .join("\n");
  const skillIdDescription = `${param.description}\n\nSkill descriptions:\n${skillDescriptions || "  No Skills available"}`;

  return new AgentToolLazy({
    function: {
      name: "call_skill_sub_agent",
      description: "Delegate a task to the specified Skill SubAgent, which completes it independently and returns the result.",
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
            description: "Task description to delegate to the SubAgent",
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
        throw new Error(`❌ Skill "${skillId}" not found, please verify the name`);
      }
      if (!skill.subAgent) {
        throw new Error(
          `Skill "${skillId}" does not support SubAgent mode, use load_skill to load its guidance and handle the task yourself`,
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
