/**
 * 资产清单 —— 用**真的目录树**测，因为这条方法的全部意义就是「按 SDK 的发现规则扫服务端磁盘」。
 *
 * 注入假发现在这里毫无价值：那会把「扫哪些目录」这件事从被测对象里偷走，而它正是最容易
 * 出错的地方（少一层目录、多一种扩展名）。所以每个用例造一套临时目录：全局层在
 * `<aiZenDir>` / `<home>/.agents`，项目层在工作区路径下。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetService } from "./AssetService.js";
import { ensureWorkspace } from "../workspace/workspace.js";

let root: string;
let aiZenDir: string;
let homeDir: string;
let workspacesRoot: string;
let workspacePath: string;
let workspaceId: string;
let service: AssetService;

/** 写一个 skill（`<dir>/<id>/SKILL.md`，frontmatter 的 name 必须与目录名一致） */
async function writeSkill(base: string, id: string, description: string): Promise<string> {
  const dir = join(base, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, "SKILL.md"),
    ["---", `name: ${id}`, `description: ${description}`, "---", "", "正文"].join("\n"),
    "utf-8",
  );
  return dir;
}

/** 写一个用户工具（`{ function, exec }` 形状，SDK 的加载器认这一种） */
async function writeTool(base: string, name: string, toolName: string): Promise<string> {
  await fs.mkdir(base, { recursive: true });
  const file = join(base, `${name}.js`);
  await fs.writeFile(
    file,
    `export default {
  function: { name: "${toolName}", description: "来自 ${name}.js" },
  exec: async () => "ok",
};
`,
    "utf-8",
  );
  return file;
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "aiz-asset-"));
  aiZenDir = join(root, "ai-zen");
  homeDir = join(root, "home");
  workspacesRoot = join(aiZenDir, "workspaces");
  workspacePath = join(root, "proj");
  await fs.mkdir(workspacePath, { recursive: true });
  // 工作区得先在服务端登记过（路径只能靠 workspace.json 反查）
  workspaceId = (await ensureWorkspace({ workspacesRoot, path: workspacePath })).id;
  service = new AssetService({ aiZenDir, homeDir, workspacesRoot });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("AssetService：技能清单", () => {
  beforeEach(async () => {
    await writeSkill(join(workspacePath, ".ai-zen", "skills"), "proj-skill", "项目里的技能");
    await writeSkill(
      join(workspacePath, ".agents", "skills"),
      "agents-skill",
      "项目里 .agents 的技能",
    );
    await writeSkill(join(aiZenDir, "skills"), "global-skill", "全局的技能");
    await writeSkill(join(homeDir, ".agents", "skills"), "user-skill", "用户目录的技能");
  });

  it("缺省两层都列：每条自带 source，项目层在前", async () => {
    const { assets } = await service.list({ kind: "skill", workspaceId });

    expect(assets.map((asset) => asset.id)).toEqual([
      "proj-skill",
      "agents-skill",
      "global-skill",
      "user-skill",
    ]);
    expect(assets.map((asset) => asset.source)).toEqual(["project", "project", "global", "global"]);
    // skill 的单位是目录，展示名取 frontmatter
    expect(assets[0]).toEqual({
      id: "proj-skill",
      name: "proj-skill",
      description: "项目里的技能",
      source: "project",
      path: join(workspacePath, ".ai-zen", "skills", "proj-skill"),
    });
  });

  it("scope:global 不要工作区也不会失败（也不该列项目层）", async () => {
    const { assets } = await service.list({ kind: "skill", scope: "global" });

    expect(assets.map((asset) => asset.id)).toEqual(["global-skill", "user-skill"]);
  });

  it("scope:project 只列项目层", async () => {
    const { assets } = await service.list({ kind: "skill", scope: "project", workspaceId });

    expect(assets.map((asset) => asset.id)).toEqual(["proj-skill", "agents-skill"]);
  });

  it("缺 workspaceId（又要两层）：只列全局层，不猜「你说的是哪个项目」", async () => {
    const { assets } = await service.list({ kind: "skill" });

    expect(assets.map((asset) => asset.source)).toEqual(["global", "global"]);
  });

  it("工作区不存在 → unknown-workspace（不是空清单）", async () => {
    await expect(
      service.list({ kind: "skill", scope: "project", workspaceId: "nope-00000000" }),
    ).rejects.toMatchObject({ code: "unknown-workspace" });
  });
});

describe("AssetService：同名资产靠项目层覆盖", () => {
  it("两层同名：合并清单里只有一条，来源标项目层；只看全局时列的是全局那份", async () => {
    const projectCopy = await writeSkill(
      join(workspacePath, ".ai-zen", "skills"),
      "same",
      "项目版",
    );
    await writeSkill(join(aiZenDir, "skills"), "same", "全局版");

    const merged = await service.list({ kind: "skill", workspaceId });
    expect(merged.assets).toHaveLength(1);
    expect(merged.assets[0]).toMatchObject({
      description: "项目版",
      source: "project",
      path: projectCopy,
    });

    const onlyGlobal = await service.list({ kind: "skill", scope: "global" });
    expect(onlyGlobal.assets).toHaveLength(1);
    expect(onlyGlobal.assets[0]).toMatchObject({ description: "全局版", source: "global" });
  });
});

describe("AssetService：工具清单", () => {
  it("给的是文件路径、文件名当 id、名字与描述取自工具定义", async () => {
    const projectFile = await writeTool(
      join(workspacePath, ".ai-zen", "tools"),
      "hello",
      "hello_tool",
    );
    await writeTool(join(aiZenDir, "tools"), "global_one", "global_one_tool");

    const { assets } = await service.list({ kind: "tool", workspaceId });

    expect(assets).toEqual([
      {
        id: "hello",
        name: "hello_tool",
        description: "来自 hello.js",
        source: "project",
        path: projectFile,
      },
      {
        id: "global_one",
        name: "global_one_tool",
        description: "来自 global_one.js",
        source: "global",
        path: join(aiZenDir, "tools", "global_one.js"),
      },
    ]);
  });

  it("不是工具的文件不算资产（`SKILL.md` 之类不该出现在工具清单里）", async () => {
    const toolsDir = join(workspacePath, ".ai-zen", "tools");
    await fs.mkdir(toolsDir, { recursive: true });
    await fs.writeFile(join(toolsDir, "notes.md"), "# 不是工具", "utf-8");

    const { assets } = await service.list({ kind: "tool", workspaceId });

    expect(assets).toEqual([]);
  });
});
