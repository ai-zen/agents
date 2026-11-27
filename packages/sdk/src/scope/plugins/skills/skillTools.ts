import {
  CallbackTool,
  Agent,
  AgentToolLazy,
  Message,
  type ToolCallContext,
} from "@ai-zen/agents-core";
import type { SkillInfo } from "./discover.js";
import { createDisclosureParam } from "../../disclosure.js";
import { readSkill } from "./discover.js";
import { withoutOneShotWithheld } from "../oneShotTools.js";
import type { LogSink } from "../../../shared/logger.js";
import { promises as fs } from "node:fs";

const EMPTY_HINT = "(No Skills are currently available, please ask the user to add one)";

/**
 * 创建 load_skill 工具。
 * 枚举所有允许的 skill（不限是否支持 subagent），由 filteredSkills 提供完整信息。
 *
 * @param logger 日志口（可选）：加载时合规校验没过的那几句走它；不注入就不记
 */
export function createLoadSkillTool(
  skillDirs: string[],
  filteredSkills: SkillInfo[],
  logger?: LogSink,
): CallbackTool {
  const ids = filteredSkills.map((s) => s.id);
  const allowedIds = new Set(ids);
  const param = createDisclosureParam(ids, "Select a Skill", EMPTY_HINT);

  // 拼接各 skill 的描述供 LLM 参考
  const skillDescriptions = filteredSkills
    .map((s) => `  - ${s.id}: ${s.description || "No description"}`)
    .join("\n");
  const skillIdDescription = `${param.description}\n\nSkill descriptions:\n${skillDescriptions || "  No Skills available"}`;

  return new CallbackTool({
    function: {
      name: "load_skill",
      description:
        "Load the full guidance document of a Skill. A Skill is pre-authored expert guidance that is expanded into the context once loaded.",
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
      // 权限白名单：`filteredSkills` 才是本 Scope 允许的技能。
      // 只靠枚举 + 描述里列名字不算限制（deny 的技能照样能被点名加载），
      // 顺带堵掉 "../../etc" 这类越出 skillDirs 的 id。
      if (!allowedIds.has(skillId)) {
        return `❌ Skill "${skillId}" is not available here. Available skills: ${ids.join(", ") || "(none)"}`;
      }
      const skill = await readSkill(skillDirs, skillId, { logger });
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
 * 只展示 subAgent: true 的 Skill，枚举中自动排除不支持 subagent 模式的 skill。
 *
 * 工具由 AgentToolLazy 承载：subagent 在 exec 时构建，从而复用统一的委派边界
 * （onSubAgentStart / onSubAgentEnd 钩子与 subAgentStarted / subAgentFinished 事件）。
 */
export function createCallSkillSubAgentTool(
  skillDirs: string[],
  filteredSkills: SkillInfo[],
  logger?: LogSink,
): AgentToolLazy {
  // 只保留支持 subagent 模式的 skill
  const subAgentSkills = filteredSkills.filter((s) => s.subAgent);
  const ids = subAgentSkills.map((s) => s.id);
  const allowedIds = new Set(ids);
  const param = createDisclosureParam(
    ids,
    "Select a Skill that supports SubAgent mode",
    EMPTY_HINT,
  );

  // 拼接各 skill 的描述供 LLM 参考
  const skillDescriptions = subAgentSkills
    .map((s) => `  - ${s.id}: ${s.description || "No description"}`)
    .join("\n");
  const skillIdDescription = `${param.description}\n\nSkill descriptions:\n${skillDescriptions || "  No Skills available"}`;

  return new AgentToolLazy({
    function: {
      name: "call_skill_sub_agent",
      description:
        "Delegate a task to the specified Skill SubAgent, which completes it independently and returns the result.",
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
    // 由 buildAgent 读取 SKILL.md 后自行决定；中断信号与委派边界由 AgentToolLazy 统一处理
    // （父的 `abort` 直接把 signal 交给 subagent 的 `runOnce`）
    buildAgent: async (
      parsedArgs: Record<string, unknown>,
      ctx: ToolCallContext,
    ): Promise<Agent> => {
      const skillId = parsedArgs.skill_id as string;
      const task = parsedArgs.task as string;
      // 与 load_skill 同一白名单口径：被权限过滤掉的技能不能被点名启动
      if (!allowedIds.has(skillId)) {
        throw new Error(
          `❌ Skill "${skillId}" is not available here. Available SubAgent skills: ${ids.join(", ") || "(none)"}`,
        );
      }
      const skill = await readSkill(skillDirs, skillId, { logger });
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
      // 但这一个 Agent 是一次性的（`lifetime` 在下面），父手上那些只有在常驻 Agent 上才成立
      // 的工具就不跟着继承：PeerSession 三件与 `async_*` 都在 `../oneShotTools.js` 那份名单里
      // ── 尤其是后台任务：它的结果由 inbox 在将来某个时刻投回来，而那时 `runOnce()` 已经返回、
      // 这个 Agent 已经 stop 并关收，`send` 直接抛 closed（结果丢掉），`onStop` 上的清点还会把
      // 还没结束的后台命令 kill 掉。这条路上原先只剔 PeerSession 三件，`async_exec` /
      // `async_timeout` 就这么漏了进来。
      const tools = withoutOneShotWithheld(parentAgent.tools).filter(
        (t) => t.function.name !== "call_skill_sub_agent",
      );

      return new Agent({
        client: parentAgent.client,
        model: parentAgent.model,
        modelConfig: parentAgent.modelConfig,
        messages: [Message.System(skill.content), Message.User(task)],
        tools,
        // 一次性委派：跑完即终止，不与父会话共用寿命。
        lifetime: "one-shot",
      });
    },
  });
}
