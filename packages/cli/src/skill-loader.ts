/**
 * Skill 加载器
 *
 * Skill = Markdown 提示词文件，告诉 AI 如何完成一系列任务。
 *
 * 设计原则：
 *   - 文件系统即索引：扫描 skills/ 目录下的 .md 文件即为可用 Skill 列表
 *   - 按需动态加载：启动时只注册 "load_skill" 工具，AI 需要时才加载具体内容
 *   - 加载后注入为 system message：Skill 的 Markdown 内容附加到对话中
 *
 * 目录结构：
 *   ~/.ai-zen/skills/           ← 全局 Skill
 *   ./.ai-zen/skills/           ← 项目级 Skill（同名覆盖全局）
 */

import chalk from "chalk";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { SKILLS_DIR } from "./config.js";

// ==================== 常量 ====================

/** 项目级 Skill 目录 */
const PROJECT_SKILLS_DIR = join(process.cwd(), ".ai-zen", "skills");

// ==================== 类型 ====================

export interface SkillInfo {
  /** Skill 文件名（不含 .md 后缀） */
  id: string;
  /** Skill 文件路径 */
  filePath: string;
  /** 来源：全局或项目级 */
  source: "global" | "project";
}

// ==================== 扫描与发现 ====================

/**
 * 扫描所有 Skill 目录，返回 Skill 列表
 * 项目级同名 Skill 覆盖全局
 */
export function scanSkills(): SkillInfo[] {
  const skillMap = new Map<string, SkillInfo>();

  // 1. 全局 Skill（优先级低）
  if (existsSync(SKILLS_DIR)) {
    const files = readdirSync(SKILLS_DIR);
    for (const file of files) {
      if (file.endsWith(".md")) {
        const id = file.slice(0, -3); // 去掉 .md 后缀
        skillMap.set(id, {
          id,
          filePath: join(SKILLS_DIR, file),
          source: "global",
        });
      }
    }
  }

  // 2. 项目级 Skill（优先级高，覆盖全局同名）
  if (existsSync(PROJECT_SKILLS_DIR)) {
    const files = readdirSync(PROJECT_SKILLS_DIR);
    for (const file of files) {
      if (file.endsWith(".md")) {
        const id = file.slice(0, -3);
        skillMap.set(id, {
          id,
          filePath: join(PROJECT_SKILLS_DIR, file),
          source: "project",
        });
      }
    }
  }

  return Array.from(skillMap.values());
}

/**
 * 获取所有可用的 Skill ID 列表
 */
export function getSkillIdList(): string[] {
  return scanSkills().map((s) => s.id);
}

// ==================== 加载 ====================

/**
 * 加载指定 Skill 的 Markdown 内容
 */
export function loadSkillContent(skillId: string): string | null {
  const skills = scanSkills();
  const skill = skills.find((s) => s.id === skillId);
  if (!skill) return null;

  try {
    return readFileSync(skill.filePath, "utf-8");
  } catch {
    return null;
  }
}

// ==================== 构建 load_skill 工具定义 ====================

/**
 * 构建 "load_skill" 工具的 function 定义
 * enum 部分由实际扫描结果动态生成
 *
 * 注意：enum 在创建工具时固定，但用户可能在对话中新增 Skill 文件。
 * 因此 description 中提醒 AI：可用列表可能已更新，不在列表中的也可尝试。
 */
export function buildLoadSkillFunction(): {
  name: string;
  description: string;
  parameters: Record<string, any>;
} {
  const skillIds = getSkillIdList();

  return {
    name: "load_skill",
    description: [
      "加载一个 Skill（技能包），获取完成特定任务的步骤指导。",
      "Skill 是 Markdown 格式的文档，包含完成特定类型任务的详细步骤。",
      "加载后 Skill 的内容会附加到当前对话中，帮助你更好地完成任务。",
      "",
      "可用 Skill（列表可能已更新，不在下列的也可尝试加载）：",
      ...(skillIds.length > 0
        ? skillIds.map((id) => `  - ${id}`)
        : ["  （暂无）"]),
      "",
      "提示：同一 Skill 只需加载一次，重复加载不会增加额外效果。",
      "如果 file not found，说明该 Skill 文件已被删除。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        skill_id: {
          type: "string",
          description: [
            "要加载的 Skill 名称（不含 .md 后缀）。",
            `当前可用: ${skillIds.length > 0 ? skillIds.join(", ") : "暂无"}`,
            "你也可以尝试加载不在列表中的 Skill，只要文件存在即可。",
          ].join(" "),
        },
      },
      required: ["skill_id"],
      additionalProperties: false,
    },
  };
}
