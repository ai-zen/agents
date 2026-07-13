import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverSkills } from "./skills";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-discovery-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSkill(id: string, name: string, description: string) {
  const skillDir = join(dir, id);
  mkdirSync(skillDir, { recursive: true });
  const content = `---
name: ${name}
description: ${description}
---
# ${name}

Some skill content.`;
  writeFileSync(join(skillDir, "SKILL.md"), content);
}

describe("discoverSkills", () => {
  it("空目录返回空数组", () => {
    expect(discoverSkills(dir)).toEqual([]);
  });

  it("发现所有 Skill", () => {
    writeSkill("code-review", "代码审查", "自动审查代码");
    writeSkill("deploy", "部署", "一键部署");

    const result = discoverSkills(dir);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("code-review");
    expect(result[0].description).toBe("自动审查代码");
    expect(result[1].id).toBe("deploy");
  });

  it("跳过没有 SKILL.md 的目录", () => {
    mkdirSync(join(dir, "empty-dir"), { recursive: true });
    writeSkill("valid", "有效", "有效 Skill");

    expect(discoverSkills(dir)).toHaveLength(1);
  });

  it("跳过解析失败的 SKILL.md", () => {
    const skillDir = join(dir, "bad-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "no frontmatter here");

    expect(discoverSkills(dir)).toEqual([]);
  });

  it("目录不存在时返回空数组", () => {
    expect(discoverSkills(join(dir, "nonexistent"))).toEqual([]);
  });
});
