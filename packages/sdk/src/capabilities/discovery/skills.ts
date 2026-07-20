import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../shared/logger.js";

const log = createLogger();

// ---- 类型 ----

export interface Frontmatter {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  /** @extension Claude Code 启发：声明此 Skill 可作为子 Agent 运行 */
  subAgent?: boolean;
}

export interface SkillValidationError {
  skillId: string;
  field: string;
  message: string;
}

/** Skill 完整信息。id = 目录名 = SKILL.md 的 name 字段 */
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  subAgent: boolean;
  content: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
}

// ---- 发现（返回完整 SkillInfo，不再丢失 subAgent 等信息）----

/**
 * 扫描多个目录中发现的所有 Skill（含 SKILL.md 的子目录）。
 * 按优先级从高到低传入路径列表，同名 skill 靠前的路径优先（先到先得）。
 * 解析 YAML frontmatter 中的 name 和 description，同时校验合规。
 */
export function discoverSkills(paths: string[], options?: { silent?: boolean }): SkillInfo[] {
  const silent = options?.silent ?? false;
  const seen = new Set<string>();
  const items: SkillInfo[] = [];

  for (const dir of paths) {
    if (!existsSync(dir)) continue;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue;

      const skillMdPath = join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      const skill = readSkillFromPath(entry.name, skillMdPath, silent);
      if (skill) {
        seen.add(entry.name);
        items.push(skill);
      }
    }
  }

  return items;
}

// ---- 完整读取（用于加载 Skill 正文和子 Agent 判断）----

/**
 * 读取单个 Skill 的完整内容与元数据。
 * 按优先级从高到低传入路径列表，靠前的路径优先（先到先得）。
 * 返回 null 如果 skill 在所有目录中都不存在或 SKILL.md 不可读。
 */
export function readSkill(skillDirs: string[], skillId: string, options?: { silent?: boolean }): SkillInfo | null {
  const silent = options?.silent ?? false;
  for (const dir of skillDirs) {
    const candidate = join(dir, skillId, "SKILL.md");
    if (existsSync(candidate)) {
      return readSkillFromPath(skillId, candidate, silent);
    }
  }
  return null;
}

// ---- 内部 ----

function readSkillFromPath(skillId: string, skillMdPath: string, silent?: boolean): SkillInfo | null {
  try {
    const content = readFileSync(skillMdPath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm.name) return null;

    // 规范合规校验
    if (!silent) {
      const errors = validateSkill(skillId, fm);
      for (const err of errors) {
        log.warn(`[skills] ${err.skillId}: ${err.field} — ${err.message}`);
      }
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

/** @internal */
export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Frontmatter = {};
  const lines = match[1].split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

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

    const kv = line.match(/^(\S+):\s*(.*)/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      switch (key) {
        case "name": result.name = val; break;
        case "description": result.description = val; break;
        case "sub-agent": result.subAgent = val === "true"; break;
        case "license": result.license = val; break;
        case "compatibility": result.compatibility = val; break;
        case "allowed-tools": result.allowedTools = val ? val.split(/\s+/).filter(Boolean) : []; break;
      }
    }
    i++;
  }

  return result;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---- 校验 ----

const VALID_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** @internal */
export function validateSkill(skillId: string, fm: Frontmatter): SkillValidationError[] {
  const errors: SkillValidationError[] = [];

  if (!fm.name || fm.name.length === 0) {
    errors.push({ skillId, field: "name", message: "必须存在且非空" });
  } else {
    if (fm.name.length > 64) {
      errors.push({ skillId, field: "name", message: `超过 64 字符（当前 ${fm.name.length}）` });
    }
    if (!VALID_NAME_RE.test(fm.name)) {
      errors.push({ skillId, field: "name", message: `"${fm.name}" 不符合规范：仅允许小写字母、数字、连字符，且不能首尾或连续连字符` });
    }
    if (fm.name !== skillId) {
      errors.push({ skillId, field: "name", message: `"${fm.name}" 与目录名 "${skillId}" 不一致` });
    }
  }

  if (!fm.description || fm.description.length === 0) {
    errors.push({ skillId, field: "description", message: "必须存在且非空" });
  } else if (fm.description.length > 1024) {
    errors.push({ skillId, field: "description", message: `超过 1024 字符（当前 ${fm.description.length}）` });
  }

  if (fm.compatibility && fm.compatibility.length > 500) {
    errors.push({ skillId, field: "compatibility", message: `超过 500 字符（当前 ${fm.compatibility.length}）` });
  }

  return errors;
}
