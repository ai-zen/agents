import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigManager } from "./ConfigManager.js";
import {
  FACTORY_SKILLS,
  HANDOFF_SKILL_ID,
  isCustomSkill,
} from "./factory-skills.js";

let dir: string;
let manager: ConfigManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "ai-zen-factory-skills-"));
  manager = new ConfigManager(join(dir, "config.json"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const skillFile = (id: string) => join(dir, "skills", id, "SKILL.md");

describe("isCustomSkill", () => {
  it("识别 frontmatter 中的 custom: true（含引号形式）", () => {
    expect(isCustomSkill('---\nname: x\ncustom: "true"\n---\n正文')).toBe(true);
    expect(isCustomSkill("---\nname: x\ncustom: true\n---\n正文")).toBe(true);
  });

  it("custom 为 false 或缺省时视为出厂托管", () => {
    expect(isCustomSkill('---\nname: x\ncustom: "false"\n---\n正文')).toBe(false);
    expect(isCustomSkill("---\nname: x\n---\n正文")).toBe(false);
    expect(isCustomSkill("没有 frontmatter 的正文 custom: true")).toBe(false);
  });

  it("只检查 frontmatter，正文里的 custom: true 不生效", () => {
    expect(isCustomSkill('---\nname: x\n---\n示例：\ncustom: true')).toBe(false);
  });
});

describe("ConfigManager.ensureFactorySkills", () => {
  it("首次 bootstrap 释放出厂 Skill", async () => {
    await manager.bootstrap();

    const content = await fs.readFile(skillFile(HANDOFF_SKILL_ID), "utf-8");
    expect(content).toContain("name: handoff");
    expect(content).toContain("## 💬 Conversation Breakpoint");
    expect(content).toContain("## 🔔 First Step for the Next Agent");
  });

  it("内容未变化时不重复写盘", async () => {
    await manager.bootstrap();
    const before = await fs.stat(skillFile(HANDOFF_SKILL_ID));

    const written = await manager.ensureFactorySkills();

    expect(written).toEqual([]);
    const after = await fs.stat(skillFile(HANDOFF_SKILL_ID));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("出厂托管的旧内容会被同步为最新版本", async () => {
    await fs.mkdir(join(dir, "skills", HANDOFF_SKILL_ID), { recursive: true });
    await fs.writeFile(
      skillFile(HANDOFF_SKILL_ID),
      '---\nname: handoff\ndescription: old version\nmetadata:\n  custom: "false"\n---\nold body',
      "utf-8",
    );

    const written = await manager.ensureFactorySkills();

    expect(written).toEqual([HANDOFF_SKILL_ID]);
    const content = await fs.readFile(skillFile(HANDOFF_SKILL_ID), "utf-8");
    expect(content).toBe(FACTORY_SKILLS[0].content);
  });

  it("用户声明 custom: true 后永不覆盖", async () => {
    const custom = '---\nname: handoff\nmetadata:\n  custom: "true"\n---\n我自己的交接规范';
    await fs.mkdir(join(dir, "skills", HANDOFF_SKILL_ID), { recursive: true });
    await fs.writeFile(skillFile(HANDOFF_SKILL_ID), custom, "utf-8");

    const written = await manager.ensureFactorySkills();

    expect(written).toEqual([]);
    expect(await fs.readFile(skillFile(HANDOFF_SKILL_ID), "utf-8")).toBe(custom);
  });
});
