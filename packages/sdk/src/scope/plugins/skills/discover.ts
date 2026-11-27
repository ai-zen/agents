import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { SILENT_LOG, type LogSink } from "../../../shared/logger.js";

export interface Frontmatter {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /** @extension Claude Code 启发：声明此 Skill 可作为 subagent 运行 */
  subAgent?: boolean;
}

export interface SkillValidationError {
  skillId: string;
  field: string;
  message: string;
}

/**
 * Skill 完整信息。id = 目录名；`name` 取自 SKILL.md 的 frontmatter，
 * 两者不一致时 `validateSkill()` 只报一条错误，不拦收录。
 */
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  subAgent: boolean;
  content: string;
  /** SKILL.md 所在目录的绝对路径 */
  dirPath: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
}

/** 发现 / 读取一个 Skill 时的选项 */
export interface DiscoverSkillsOptions {
  /** 静默：不写日志（批量探测 / 只读一层目录清单时用） */
  silent?: boolean;
  /** 日志口（可选）：合规校验没过时每条报一句；不注入就不记（库缺省沉默） */
  logger?: LogSink;
}

/**
 * 扫描多个目录中发现的所有 Skill（含 SKILL.md 的子目录）。
 * 按优先级从高到低传入路径列表，同名 skill 靠前的路径优先（先到先得）。
 * 解析 YAML frontmatter 中的 name 和 description，同时校验合规。
 */
export async function discoverSkills(
  paths: string[],
  options?: DiscoverSkillsOptions,
): Promise<SkillInfo[]> {
  const seen = new Set<string>();
  const items: SkillInfo[] = [];

  for (const dir of paths) {
    try {
      await fs.access(dir);
    } catch {
      continue;
    }

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue;

      const skillMdPath = join(dir, entry.name, "SKILL.md");
      // 不必先 `access`：`readSkillFromPath()` 自己 catch-all，读不到就回 null
      const skill = await readSkillFromPath(entry.name, skillMdPath, options);
      if (skill) {
        seen.add(entry.name);
        items.push(skill);
      }
    }
  }

  return items;
}

/**
 * 读取单个 Skill 的完整内容与元数据。
 * 按优先级从高到低传入路径列表，靠前的路径优先（先到先得）。
 * 返回 null 如果 skill 在所有目录中都不存在或 SKILL.md 不可读。
 */
export async function readSkill(
  skillDirs: string[],
  skillId: string,
  options?: DiscoverSkillsOptions,
): Promise<SkillInfo | null> {
  for (const dir of skillDirs) {
    // `readSkillFromPath()` 读不到就回 null，所以不必先探测再读
    const skill = await readSkillFromPath(skillId, join(dir, skillId, "SKILL.md"), options);
    if (skill) return skill;
  }
  return null;
}

async function readSkillFromPath(
  skillId: string,
  skillMdPath: string,
  options: DiscoverSkillsOptions = {},
): Promise<SkillInfo | null> {
  try {
    const content = await fs.readFile(skillMdPath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm.name) return null;

    // 规范合规校验（只报不拦；且 `silent` 时连校验都不跑）
    if (!options.silent) {
      const errors = validateSkill(skillId, fm);
      const logger = options.logger ?? SILENT_LOG;
      for (const err of errors) {
        logger.warn(`[skills] ${err.skillId}: ${err.field} — ${err.message}`);
      }
    }

    return {
      id: skillId,
      name: fm.name,
      description: fm.description ?? "",
      subAgent: fm.subAgent ?? false,
      content,
      dirPath: dirname(skillMdPath),
      license: fm.license,
      compatibility: fm.compatibility,
      metadata: fm.metadata,
    };
  } catch {
    return null;
  }
}

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

const VALID_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** @internal */
export function validateSkill(skillId: string, fm: Frontmatter): SkillValidationError[] {
  const errors: SkillValidationError[] = [];

  if (!fm.name || fm.name.length === 0) {
    errors.push({ skillId, field: "name", message: "Must be present and non-empty" });
  } else {
    if (fm.name.length > 64) {
      errors.push({
        skillId,
        field: "name",
        message: `Exceeds 64 characters (currently ${fm.name.length})`,
      });
    }
    if (!VALID_NAME_RE.test(fm.name)) {
      errors.push({
        skillId,
        field: "name",
        message: `"${fm.name}" is not valid: only lowercase letters, digits and hyphens are allowed, and it must not start, end or contain consecutive hyphens`,
      });
    }
    if (fm.name !== skillId) {
      errors.push({
        skillId,
        field: "name",
        message: `"${fm.name}" does not match the directory name "${skillId}"`,
      });
    }
  }

  if (!fm.description || fm.description.length === 0) {
    errors.push({ skillId, field: "description", message: "Must be present and non-empty" });
  } else if (fm.description.length > 1024) {
    errors.push({
      skillId,
      field: "description",
      message: `Exceeds 1024 characters (currently ${fm.description.length})`,
    });
  }

  if (fm.compatibility && fm.compatibility.length > 500) {
    errors.push({
      skillId,
      field: "compatibility",
      message: `Exceeds 500 characters (currently ${fm.compatibility.length})`,
    });
  }

  return errors;
}
