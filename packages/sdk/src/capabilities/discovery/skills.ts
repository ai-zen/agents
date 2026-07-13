import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DisclosureItem } from "../disclosure";
import { createLogger } from "../../shared/logger";

const log = createLogger();

// ---- 类型 ----

export interface Frontmatter {
  // ---- 规范字段 (agentskills.io) ----
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];

  // ---- 扩展字段（非规范）----
  /** @extension Claude Code 启发：声明此 Skill 可作为子 Agent 运行 */
  subAgent?: boolean;
}

export interface SkillValidationError {
  skillId: string;
  field: string;
  message: string;
}

export interface SkillInfo extends DisclosureItem {
  name: string;
  subAgent: boolean;
  content: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
}

// ---- 发现（轻量，用于枚举披露）----

/**
 * 扫描目录中发现的所有 Skill（含 SKILL.md 的子目录）。
 * 解析 YAML frontmatter 中的 name 和 description。
 * 同时进行规范合规校验，警告通过 logger 输出。
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

      // 规范合规校验
      const errors = validateSkill(entry.name, fm);
      for (const err of errors) {
        log.warn(`[skills] ${err.skillId}: ${err.field} — ${err.message}`);
      }

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

    // 规范合规校验
    const errors = validateSkill(skillId, fm);
    for (const err of errors) {
      log.warn(`[skills] ${err.skillId}: ${err.field} — ${err.message}`);
    }

    return {
      id: skillId,
      name: fm.name,
      description: fm.description ?? "",
      subAgent: fm.subAgent ?? false,
      content,
      license: fm.license,
      compatibility: fm.compatibility,
      metadata: fm.metadata,
      allowedTools: fm.allowedTools,
    };
  } catch {
    return null;
  }
}

// ---- 解析 ----

/**
 * 解析 SKILL.md 的 YAML frontmatter。
 *
 * 支持的字段：
 * - 规范字段：name / description / license / compatibility / metadata / allowed-tools
 * - 扩展字段：sub-agent（Claude Code 启发，声明可作为子 Agent 运行）
 */
export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Frontmatter = {};
  const lines = match[1].split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // metadata: 嵌套段
    const metaHeader = line.match(/^metadata:\s*$/);
    if (metaHeader) {
      const metadata: Record<string, string> = {};
      i++;
      while (i < lines.length) {
        const subMatch = lines[i].match(/^  (\S+):\s*(.*)/);
        if (!subMatch) break;
        metadata[subMatch[1]] = stripQuotes(subMatch[2].trim());
        i++;
      }
      if (Object.keys(metadata).length > 0) {
        result.metadata = metadata;
      }
      continue;
    }

    // 普通 key: value
    const kv = line.match(/^(\S+):\s*(.*)/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      switch (key) {
        case "name":
          result.name = val;
          break;
        case "description":
          result.description = val;
          break;
        case "sub-agent":
          result.subAgent = val === "true";
          break;
        case "license":
          result.license = val;
          break;
        case "compatibility":
          result.compatibility = val;
          break;
        case "allowed-tools":
          result.allowedTools = val ? val.split(/\s+/).filter(Boolean) : [];
          break;
      }
    }
    i++;
  }

  return result;
}

// ---- 辅助 ----

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---- 校验 ----

/** name 字段：仅允许小写字母、数字、连字符 */
const VALID_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * 按 Agent Skills 规范校验 frontmatter。
 * 返回警告列表（不阻塞加载）。
 */
export function validateSkill(skillId: string, fm: Frontmatter): SkillValidationError[] {
  const errors: SkillValidationError[] = [];

  // name
  if (!fm.name || fm.name.length === 0) {
    errors.push({ skillId, field: "name", message: "必须存在且非空" });
  } else {
    if (fm.name.length > 64) {
      errors.push({ skillId, field: "name", message: `超过 64 字符（当前 ${fm.name.length}）` });
    }
    if (!VALID_NAME_RE.test(fm.name)) {
      errors.push({
        skillId,
        field: "name",
        message: `"${fm.name}" 不符合规范：仅允许小写字母、数字、连字符，且不能首尾或连续连字符`,
      });
    }
    if (fm.name !== skillId) {
      errors.push({
        skillId,
        field: "name",
        message: `"${fm.name}" 与目录名 "${skillId}" 不一致`,
      });
    }
  }

  // description
  if (!fm.description || fm.description.length === 0) {
    errors.push({ skillId, field: "description", message: "必须存在且非空" });
  } else if (fm.description.length > 1024) {
    errors.push({
      skillId,
      field: "description",
      message: `超过 1024 字符（当前 ${fm.description.length}）`,
    });
  }

  // compatibility（可选但需 <= 500 字符）
  if (fm.compatibility && fm.compatibility.length > 500) {
    errors.push({
      skillId,
      field: "compatibility",
      message: `超过 500 字符（当前 ${fm.compatibility.length}）`,
    });
  }

  return errors;
}
