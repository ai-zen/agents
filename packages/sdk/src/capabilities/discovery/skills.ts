import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DisclosureItem } from "../disclosure";

// ---- 类型 ----

export interface Frontmatter {
  name?: string;
  description?: string;
  subAgent?: boolean;
}

export interface SkillInfo extends DisclosureItem {
  name: string;
  subAgent: boolean;
  content: string;
}

// ---- 发现（轻量，用于枚举披露）----

/**
 * 扫描目录中发现的所有 Skill（含 SKILL.md 的子目录）。
 * 解析 YAML frontmatter 中的 name 和 description。
 */
export function discoverSkills(dir: string): DisclosureItem[] {
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const items: DisclosureItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;

    try {
      const raw = readFileSync(skillMdPath, "utf-8");
      const fm = parseFrontmatter(raw);
      if (fm.name) {
        items.push({ id: entry.name, description: fm.description ?? "" });
      }
    } catch {
      // 跳过解析失败的文件
    }
  }

  return items;
}

// ---- 完整读取（用于加载 Skill 正文和子 Agent 判断）----

/**
 * 读取单个 Skill 的完整内容与元数据。
 * 返回 null 如果 skill 不存在或 SKILL.md 不可读。
 */
export function readSkill(skillsDir: string, skillId: string): SkillInfo | null {
  const skillMdPath = join(skillsDir, skillId, "SKILL.md");
  if (!existsSync(skillMdPath)) return null;

  try {
    const content = readFileSync(skillMdPath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm.name) return null;

    return {
      id: skillId,
      name: fm.name,
      description: fm.description ?? "",
      subAgent: fm.subAgent ?? false,
      content,
    };
  } catch {
    return null;
  }
}

// ---- 解析 ----

/**
 * 解析 SKILL.md 的 YAML frontmatter。
 * 支持的字段：name、description、sub-agent
 */
export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Frontmatter = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\S+):\s*(.+)/);
    if (kv) {
      if (kv[1] === "name") result.name = kv[2].trim();
      if (kv[1] === "description") result.description = kv[2].trim();
      if (kv[1] === "sub-agent") result.subAgent = kv[2].trim() === "true";
    }
  }
  return result;
}
