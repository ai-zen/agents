import { describe, it, expect, beforeEach, vi } from "vitest";
import { scanSkills, getSkillIdList, loadSkillContent, buildLoadSkillFunction } from "./skill-loader.js";

// ==================== Mock 文件系统 ====================

const vol = new Map<string, string>();

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (path.includes("node_modules")) return actual.existsSync(path);
      return vol.has(path);
    }),
    readdirSync: vi.fn((path: string) => {
      const prefix = path.endsWith("/") ? path : path + "/";
      return Array.from(vol.keys())
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    }),
    readFileSync: vi.fn((path: string, encoding?: any) => {
      if (path.includes("node_modules")) return actual.readFileSync(path, encoding);
      if (!vol.has(path)) throw new Error(`ENOENT: ${path}`);
      return vol.get(path)!;
    }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// ==================== Mock config 路径 ====================

vi.mock("./config.js", async () => {
  return {
    SKILLS_DIR: "/mock/.ai-zen/skills",
  };
});

// ==================== 测试数据 ====================

const sampleSkillMd = `# Git 操作

## 查看状态
使用 \`exec\` 工具执行 \`git status\`

## 提交代码
1. 使用 \`exec\` 执行 \`git add -A\`
2. 使用 \`exec\` 执行 \`git commit -m "<message>"\`
`;

const anotherSkillMd = `# Docker 操作

## 查看容器
使用 \`exec\` 执行 \`docker ps\`
`;

// ==================== 测试 ====================

beforeEach(() => {
  vol.clear();
});

describe("scanSkills", () => {
  it("目录不存在时返回空数组", () => {
    const skills = scanSkills();
    expect(skills).toEqual([]);
  });

  it("扫描全局目录中的 .md 文件", () => {
    vol.set("/mock/.ai-zen/skills/git-operations.md", sampleSkillMd);
    vol.set("/mock/.ai-zen/skills", "");

    const skills = scanSkills();
    expect(skills.length).toBe(1);
    expect(skills[0].id).toBe("git-operations");
    expect(skills[0].source).toBe("global");
  });

  it("忽略非 .md 文件", () => {
    vol.set("/mock/.ai-zen/skills/notes.txt", "hello");
    vol.set("/mock/.ai-zen/skills", "");

    const skills = scanSkills();
    expect(skills.length).toBe(0);
  });

  it("扫描多个 Skill", () => {
    vol.set("/mock/.ai-zen/skills/git.md", sampleSkillMd);
    vol.set("/mock/.ai-zen/skills/docker.md", anotherSkillMd);
    vol.set("/mock/.ai-zen/skills", "");

    const skills = scanSkills();
    expect(skills.length).toBe(2);
    const ids = skills.map((s) => s.id).sort();
    expect(ids).toEqual(["docker", "git"]);
  });

  it("返回正确的文件路径", () => {
    vol.set("/mock/.ai-zen/skills/git.md", sampleSkillMd);
    vol.set("/mock/.ai-zen/skills", "");

    const skills = scanSkills();
    expect(skills[0].filePath).toBe("/mock/.ai-zen/skills/git.md");
  });
});

describe("getSkillIdList", () => {
  it("返回所有 Skill ID", () => {
    vol.set("/mock/.ai-zen/skills/git.md", sampleSkillMd);
    vol.set("/mock/.ai-zen/skills/docker.md", anotherSkillMd);
    vol.set("/mock/.ai-zen/skills", "");

    const ids = getSkillIdList();
    expect(ids.sort()).toEqual(["docker", "git"]);
  });

  it("没有 Skill 时返回空数组", () => {
    const ids = getSkillIdList();
    expect(ids).toEqual([]);
  });
});

describe("loadSkillContent", () => {
  it("加载指定 Skill 的内容", () => {
    vol.set("/mock/.ai-zen/skills/git.md", sampleSkillMd);
    vol.set("/mock/.ai-zen/skills", "");

    const content = loadSkillContent("git");
    expect(content).toBe(sampleSkillMd);
  });

  it("不存在的 Skill 返回 null", () => {
    const content = loadSkillContent("non-existent");
    expect(content).toBeNull();
  });

  it("文件读取失败时返回 null", () => {
    // 目录存在但文件不存在
    vol.set("/mock/.ai-zen/skills", "");

    const content = loadSkillContent("git");
    expect(content).toBeNull();
  });
});

describe("buildLoadSkillFunction", () => {
  it("有 Skill 时 enum 列出所有可用 Skill", () => {
    vol.set("/mock/.ai-zen/skills/git.md", sampleSkillMd);
    vol.set("/mock/.ai-zen/skills/docker.md", anotherSkillMd);
    vol.set("/mock/.ai-zen/skills", "");

    const func = buildLoadSkillFunction();
    expect(func.name).toBe("load_skill");
    expect(func.description).toContain("docker");
    expect(func.description).toContain("git");
  });

  it("没有 Skill 时 description 提示暂无", () => {
    const func = buildLoadSkillFunction();
    expect(func.name).toBe("load_skill");
    expect(func.description).toContain("暂无");
  });

  it("required 包含 skill_id", () => {
    vol.set("/mock/.ai-zen/skills/git.md", sampleSkillMd);
    vol.set("/mock/.ai-zen/skills", "");

    const func = buildLoadSkillFunction();
    expect(func.parameters.required).toContain("skill_id");
  });

  it("required 包含 skill_id", () => {
    const func = buildLoadSkillFunction();
    expect(func.parameters.required).toContain("skill_id");
  });
});
