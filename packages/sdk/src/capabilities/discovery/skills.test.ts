import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverSkills, readSkill, parseFrontmatter } from "./skills";
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

// ---- parseFrontmatter / readSkill ----

describe("parseFrontmatter", () => {
  it("解析 name、description、sub-agent", () => {
    const fm = parseFrontmatter(`---
name: 测试技能
description: 测试描述
sub-agent: true
---
# 正文`);

    expect(fm.name).toBe("测试技能");
    expect(fm.description).toBe("测试描述");
    expect(fm.subAgent).toBe(true);
  });

  it("sub-agent 缺失时返回 undefined", () => {
    const fm = parseFrontmatter(`---
name: 普通技能
---
# 正文`);

    expect(fm.subAgent).toBeUndefined();
  });

  it("sub-agent 为 false", () => {
    const fm = parseFrontmatter(`---
name: 普通技能
sub-agent: false
---
# 正文`);

    expect(fm.subAgent).toBe(false);
  });

  it("无 frontmatter 返回空对象", () => {
    const fm = parseFrontmatter(`# 直接正文`);
    expect(fm).toEqual({});
  });
});

describe("readSkill", () => {
  it("读取完整 Skill 内容与元数据", () => {
    const skillDir = join(dir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---
name: 我的技能
description: 技能描述
sub-agent: true
---
# 技能正文

这是完整的技能指导内容。`);

    const skill = readSkill(dir, "my-skill");

    expect(skill).not.toBeNull();
    expect(skill!.id).toBe("my-skill");
    expect(skill!.name).toBe("我的技能");
    expect(skill!.description).toBe("技能描述");
    expect(skill!.subAgent).toBe(true);
    expect(skill!.content).toContain("# 技能正文");
    expect(skill!.content).toContain("这是完整的技能指导内容。");
  });

  it("skill 不存在返回 null", () => {
    expect(readSkill(dir, "nonexistent")).toBeNull();
  });

  it("目录存在但无 SKILL.md 返回 null", () => {
    mkdirSync(join(dir, "empty-skill"), { recursive: true });
    expect(readSkill(dir, "empty-skill")).toBeNull();
  });

  it("sub-agent 未声明时 subAgent 为 false", () => {
    const skillDir = join(dir, "plain-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---
name: 普通技能
---
# 正文`);

    const skill = readSkill(dir, "plain-skill");
    expect(skill!.subAgent).toBe(false);
  });
});
