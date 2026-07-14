import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverSkills, readSkill, parseFrontmatter, validateSkill } from "./skills";
import type { Frontmatter } from "./skills";
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

function writeSkillRaw(id: string, raw: string) {
  const skillDir = join(dir, id);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), raw);
}

// ==================================================================
// discoverSkills
// ==================================================================

describe("discoverSkills", () => {
  it("空目录返回空数组", () => {
    expect(discoverSkills([dir])).toEqual([]);
  });

  it("发现所有 Skill", () => {
    writeSkill("code-review", "code-review", "Automated code review");
    writeSkill("deploy", "deploy", "One-click deployment");

    const result = discoverSkills([dir]);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("code-review");
    expect(result[0].description).toBe("Automated code review");
    expect(result[1].id).toBe("deploy");
  });

  it("跳过没有 SKILL.md 的目录", () => {
    mkdirSync(join(dir, "empty-dir"), { recursive: true });
    writeSkill("valid", "valid", "A valid skill");

    expect(discoverSkills([dir])).toHaveLength(1);
  });

  it("跳过解析失败的 SKILL.md（无 name）", () => {
    const skillDir = join(dir, "bad-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "no frontmatter here");

    expect(discoverSkills([dir])).toEqual([]);
  });

  it("目录不存在时返回空数组", () => {
    expect(discoverSkills([join(dir, "nonexistent")])).toEqual([]);
  });

  it("name 不符合规范时仍可发现（校验为警告不阻塞）", () => {
    writeSkill("my-tool", "我的工具", "中文名不符合规范但不应阻塞");

    const result = discoverSkills([dir]);
    // 仍能发现（name 非空即收录）
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("my-tool");
  });

  it("多路径扫描：合并所有路径的 skill", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ai-zen-discovery2-"));
    try {
      writeSkill("skill-a", "skill-a", "Skill A from dir1");
      // dir2 放另一批
      mkdirSync(join(dir2, "skill-b"), { recursive: true });
      writeFileSync(join(dir2, "skill-b", "SKILL.md"), `---\nname: skill-b\ndescription: Skill B from dir2\n---\n# skill-b`);

      const result = discoverSkills([dir, dir2]);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("skill-a");
      expect(result[1].id).toBe("skill-b");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("多路径：同名 skill 靠前路径优先（先到先得）", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ai-zen-discovery2-"));
    try {
      writeSkill("shared-skill", "shared-skill", "From dir1");
      mkdirSync(join(dir2, "shared-skill"), { recursive: true });
      writeFileSync(join(dir2, "shared-skill", "SKILL.md"), `---\nname: shared-skill\ndescription: From dir2\n---\n# shared-skill`);

      const result = discoverSkills([dir, dir2]);
      expect(result).toHaveLength(1);
      expect(result[0].description).toBe("From dir1");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

// ==================================================================
// parseFrontmatter
// ==================================================================

describe("parseFrontmatter", () => {
  // ---- 向后兼容：现有字段 ----

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

  // ---- 新增：规范字段 ----

  it("解析 license 和 compatibility", () => {
    const fm = parseFrontmatter(`---
name: my-skill
description: A skill
license: MIT
compatibility: requires git
---
# Body`);

    expect(fm.license).toBe("MIT");
    expect(fm.compatibility).toBe("requires git");
  });

  it("解析 metadata 嵌套字段", () => {
    const fm = parseFrontmatter(`---
name: my-skill
description: A skill
metadata:
  author: example-org
  version: "1.0"
---
# Body`);

    expect(fm.metadata).toEqual({ author: "example-org", version: "1.0" });
  });

  it("metadata 为空时不设置", () => {
    const fm = parseFrontmatter(`---
name: my-skill
metadata:
---
# Body`);

    expect(fm.metadata).toBeUndefined();
  });

  it("解析 allowed-tools（空格分隔 → 数组）", () => {
    const fm = parseFrontmatter(`---
name: my-skill
allowed-tools: Bash(git:*) Read writeFile
---
# Body`);

    expect(fm.allowedTools).toEqual(["Bash(git:*)", "Read", "writeFile"]);
  });

  it("allowed-tools 空值时为空数组", () => {
    const fm = parseFrontmatter(`---
name: my-skill
allowed-tools:
---
# Body`);

    expect(fm.allowedTools).toEqual([]);
  });

  it("全字段综合解析", () => {
    const fm = parseFrontmatter(`---
name: pdf-processing
description: Extract PDF text, fill forms, merge files
license: Apache-2.0
compatibility: requires python3
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Bash(git:*) Read
sub-agent: true
---
# PDF Processing Skill

Full body content here.`);

    expect(fm.name).toBe("pdf-processing");
    expect(fm.description).toBe("Extract PDF text, fill forms, merge files");
    expect(fm.license).toBe("Apache-2.0");
    expect(fm.compatibility).toBe("requires python3");
    expect(fm.metadata).toEqual({ author: "example-org", version: "1.0" });
    expect(fm.allowedTools).toEqual(["Bash(git:*)", "Read"]);
    expect(fm.subAgent).toBe(true);
  });
});

// ==================================================================
// validateSkill
// ==================================================================

describe("validateSkill", () => {
  // ---- name 校验 ----

  it("合法 name 无错误", () => {
    const errors = validateSkill("pdf-processing", { name: "pdf-processing", description: "desc" });
    expect(errors).toEqual([]);
  });

  it("合法 name：多段连字符", () => {
    const errors = validateSkill("code-review-tool", { name: "code-review-tool", description: "desc" });
    expect(errors).toEqual([]);
  });

  it("合法 name：数字", () => {
    const errors = validateSkill("data-analyzer-v2", { name: "data-analyzer-v2", description: "desc" });
    expect(errors).toEqual([]);
  });

  it("非法：name 为空", () => {
    const errors = validateSkill("my-skill", { name: "", description: "desc" });
    expect(errors).toContainEqual({ skillId: "my-skill", field: "name", message: "必须存在且非空" });
  });

  it("非法：name 含有大写字母", () => {
    const errors = validateSkill("PDF-Processing", { name: "PDF-Processing", description: "desc" });
    expect(errors.some((e) => e.field === "name")).toBe(true);
  });

  it("非法：name 以连字符开头", () => {
    const errors = validateSkill("-leading", { name: "-leading", description: "desc" });
    expect(errors.some((e) => e.field === "name")).toBe(true);
  });

  it("非法：name 以连字符结尾", () => {
    const errors = validateSkill("trailing-", { name: "trailing-", description: "desc" });
    expect(errors.some((e) => e.field === "name")).toBe(true);
  });

  it("非法：name 含连续连字符", () => {
    const errors = validateSkill("double--dash", { name: "double--dash", description: "desc" });
    expect(errors.some((e) => e.field === "name")).toBe(true);
  });

  it("非法：name 超过 64 字符", () => {
    const longName = "a".repeat(65);
    const errors = validateSkill(longName, { name: longName, description: "desc" });
    expect(errors.some((e) => e.field === "name" && e.message.includes("64"))).toBe(true);
  });

  it("非法：name 与目录名不一致", () => {
    const errors = validateSkill("actual-dir", { name: "different-name", description: "desc" });
    expect(errors.some((e) => e.field === "name" && e.message.includes("不一致"))).toBe(true);
  });

  // ---- description 校验 ----

  it("合法 description 无错误", () => {
    const errors = validateSkill("my-skill", { name: "my-skill", description: "A valid description" });
    expect(errors).toEqual([]);
  });

  it("非法：description 为空", () => {
    const errors = validateSkill("my-skill", { name: "my-skill", description: "" });
    expect(errors.some((e) => e.field === "description")).toBe(true);
  });

  it("非法：description 超过 1024 字符", () => {
    const longDesc = "x".repeat(1025);
    const errors = validateSkill("my-skill", { name: "my-skill", description: longDesc });
    expect(errors.some((e) => e.field === "description" && e.message.includes("1024"))).toBe(true);
  });

  // ---- compatibility 校验 ----

  it("合法 compatibility 无错误", () => {
    const errors = validateSkill("my-skill", { name: "my-skill", description: "desc", compatibility: "requires git" });
    expect(errors).toEqual([]);
  });

  it("非法：compatibility 超过 500 字符", () => {
    const longCompat = "x".repeat(501);
    const errors = validateSkill("my-skill", { name: "my-skill", description: "desc", compatibility: longCompat });
    expect(errors.some((e) => e.field === "compatibility")).toBe(true);
  });

  // ---- 多错误聚合 ----

  it("多个字段违规时返回全部错误", () => {
    const errors = validateSkill("my-dir", { name: "", description: "" });
    expect(errors.filter((e) => e.field === "name").length).toBeGreaterThanOrEqual(1);
    expect(errors.filter((e) => e.field === "description").length).toBeGreaterThanOrEqual(1);
  });
});

// ==================================================================
// readSkill
// ==================================================================

describe("readSkill", () => {
  it("读取完整 Skill 内容与元数据", () => {
    const skillDir = join(dir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---
name: my-skill
description: A test skill
license: MIT
sub-agent: true
---
# Skill Body

Full content here.`);

    const skill = readSkill([dir], "my-skill");

    expect(skill).not.toBeNull();
    expect(skill!.id).toBe("my-skill");
    expect(skill!.name).toBe("my-skill");
    expect(skill!.description).toBe("A test skill");
    expect(skill!.license).toBe("MIT");
    expect(skill!.subAgent).toBe(true);
    expect(skill!.content).toContain("# Skill Body");
  });

  it("skill 不存在返回 null", () => {
    expect(readSkill([dir], "nonexistent")).toBeNull();
  });

  it("目录存在但无 SKILL.md 返回 null", () => {
    mkdirSync(join(dir, "empty-skill"), { recursive: true });
    expect(readSkill([dir], "empty-skill")).toBeNull();
  });

  it("sub-agent 未声明时 subAgent 为 false", () => {
    const skillDir = join(dir, "plain-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---
name: plain-skill
---
# Body`);

    const skill = readSkill([dir], "plain-skill");
    expect(skill!.subAgent).toBe(false);
  });

  it("name 不符合规范时仍可读取（校验为警告）", () => {
    const skillDir = join(dir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---
name: 我的技能
description: 中文名也可读
---
# Body`);

    const skill = readSkill([dir], "my-skill");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("我的技能");
  });

  it("多路径查找：在第一个路径找到即返回", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ai-zen-discovery2-"));
    try {
      const skillDir = join(dir, "my-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `---\nname: my-skill\ndescription: From dir1\n---\n# Body`);

      const skill = readSkill([dir, dir2], "my-skill");
      expect(skill).not.toBeNull();
      expect(skill!.description).toBe("From dir1");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("多路径查找：在第二个路径找到", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ai-zen-discovery2-"));
    try {
      const skillDir = join(dir2, "my-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `---\nname: my-skill\ndescription: From dir2\n---\n# Body`);

      const skill = readSkill([dir, dir2], "my-skill");
      expect(skill).not.toBeNull();
      expect(skill!.description).toBe("From dir2");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
