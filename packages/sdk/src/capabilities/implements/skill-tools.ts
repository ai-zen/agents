import { CallbackTool, Agent, Message } from "@ai-zen/agents-core";
import type { Tool } from "@ai-zen/agents-core";
import type { DisclosureParam } from "../disclosure";
import { readSkill } from "../discovery/skills";
import { createLogger } from "../../shared/logger";

const log = createLogger();

/**
 * 创建 load_skill 工具。
 * skill_id 枚举来自 skillDisclosure（已在装配时按 permissions.skills 裁剪）。
 */
export function createLoadSkillTool(
  skillDirs: string[],
  skillDisclosure: DisclosureParam,
): CallbackTool {
  return new CallbackTool({
    function: {
      name: "load_skill",
      description: "加载指定 Skill 的完整指导文档。Skill 是预制的专业指导，加载后展开到上下文中。",
      parameters: {
        type: "object",
        properties: {
          skill_id: {
            type: "string",
            description: skillDisclosure.description,
            ...(skillDisclosure.enum ? { enum: skillDisclosure.enum } : {}),
          },
        },
        required: ["skill_id"],
        additionalProperties: false,
      },
    },
    callback: async function (this: any, input): Promise<string> {
      const skillId = input.skill_id as string;
      const skill = readSkill(skillDirs, skillId);
      if (!skill) {
        return `❌ Skill "${skillId}" 不存在，请确认名称是否正确`;
      }

      // 检查是否已加载（去重）
      const alreadyLoaded = this.agent?.messages?.some(
        (m: any) => m.content?.includes(`Skill "${skillId}" 已加载`),
      );
      if (alreadyLoaded) {
        return `Skill "${skillId}" 已加载`;
      }

      // 注入到对话上下文
      if (this.agent) {
        this.agent.messages.push({
          role: "system",
          content: `以下是 Skill "${skillId}" 的内容，请按照其中的指导完成任务：\n\n${skill.content}`,
        } as any);
      }

      return `✅ Skill "${skillId}" 已加载，内容已附加到当前对话中`;
    },
  });
}

/**
 * 创建 call_skill_sub_agent 工具。
 * 回调中直接克隆当前 Core Agent（this.agent），替换 messages 为 skill 正文 + task，
 * 并预过滤掉 call_skill_sub_agent 和 load_skill（防递归）。
 */
export function createCallSkillSubAgentTool(
  skillDirs: string[],
  skillDisclosure: DisclosureParam,
): CallbackTool {
  return new CallbackTool({
    function: {
      name: "call_skill_sub_agent",
      description: "将任务委派给指定的 Skill 子 Agent，由其独立完成并返回结果。",
      parameters: {
        type: "object",
        properties: {
          skill_id: {
            type: "string",
            description: skillDisclosure.description,
            ...(skillDisclosure.enum ? { enum: skillDisclosure.enum } : {}),
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
    async callback(input): Promise<string> {
      const skillId = input.skill_id as string;
      const task = input.task as string;
      const skill = readSkill(skillDirs, skillId);
      if (!skill) {
        return `❌ Skill "${skillId}" 不存在，请确认名称是否正确`;
      }
      if (!skill.subAgent) {
        return `Skill "${skillId}" 不支持子 Agent 模式，请使用 load_skill 加载指导后自行处理`;
      }

      // 克隆当前 Agent，只替换 messages，过滤递归工具
      const subAgent = new Agent({
        model: (this as any).agent.model,
        messages: [
          Message.System(skill.content),
          Message.User(task),
        ],
        tools: (this as any).agent.tools.filter(
          (t: Tool) =>
            t.function.name !== "call_skill_sub_agent" &&
            t.function.name !== "load_skill",
        ),
      });

      await subAgent.run();
      const lastMsg = subAgent.messages.at(-1);
      return typeof lastMsg?.content === "string" ? lastMsg.content : "";
    },
  });
}
