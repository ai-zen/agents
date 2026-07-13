import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DisclosureItem } from "../disclosure";

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

interface Frontmatter {
  name?: string;
  description?: string;
}

function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Frontmatter = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) {
      if (kv[1] === "name") result.name = kv[2].trim();
      if (kv[1] === "description") result.description = kv[2].trim();
    }
  }
  return result;
}
