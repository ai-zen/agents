/**
 * 能力发现的验收（F-G1 / F-G2 / F-F6 / L9 / R54）。
 *
 * 覆盖：5 层 MCP 链的路径与「只有 2 层可编辑」、合并顺序（近的优先）、`missing` 与 `broken`
 * 分开报、写回时 `oauth` 与未知字段原样保留、Skill 4 层 / 工具与子 Agent 各 2 层、
 * 坏条目也要看得见、以及组装层要的那份路径。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ConfigManager } from "@ai-zen/agents-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerError } from "../wire/errors.js";
import type { DiscoveryLayerView } from "../wire/index.js";
import { DiscoveryService } from "./DiscoveryService.js";

const WORKSPACE_ID = "ws-1";

let dataRoot: string;
let project: string;
let home: string;
let service: DiscoveryService;

/** 写一个 JSON 文件（顺带建目录） */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
}

/** 写一个文本文件（顺带建目录） */
async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf-8");
}

/** 按层序取一层（层序不连续时也能定位） */
function layerAt(layers: DiscoveryLayerView[], depth: number): DiscoveryLayerView {
  const found = layers.find((layer) => layer.depth === depth);
  if (!found) throw new Error(`没有第 ${depth} 层`);
  return found;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "ai-zen-discovery-"));
  project = join(dataRoot, "project");
  home = join(dataRoot, "home");
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeJson(join(dataRoot, "config.json"), { endpoints: [], models: [] });

  const configManager = new ConfigManager(join(dataRoot, "config.json"));
  service = new DiscoveryService({
    configManager,
    homeDir: home,
    findWorkspace: (workspaceId) =>
      workspaceId === WORKSPACE_ID ? { cwd: project } : undefined,
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("DiscoveryService 的层路径", () => {
  it("MCP 是 5 层链，顺序与 L9 一致", () => {
    const layers = service.mcpLayers(project);
    expect(layers.map((layer) => layer.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(layers.map((layer) => layer.path)).toEqual([
      join(project, ".mcp.json"),
      join(project, ".ai-zen", "mcp.json"),
      join(project, ".agents", "mcp.json"),
      join(dataRoot, "mcp.json"),
      join(home, ".agents", "mcp.json"),
    ]);
  });

  it("MCP 只有 2 个作用域可编辑（项目侧 .ai-zen 与数据根）", () => {
    const editable = service
      .mcpLayers(project)
      .filter((layer) => layer.editable)
      .map((layer) => [layer.depth, layer.scope]);
    expect(editable).toEqual([
      [1, "workspace"],
      [3, "user"],
    ]);
  });

  it("Skill 4 层、工具与子 Agent 各 2 层，近的在前", () => {
    expect(service.skillLayers(project).map((layer) => layer.path)).toEqual([
      join(project, ".ai-zen", "skills"),
      join(project, ".agents", "skills"),
      join(dataRoot, "skills"),
      join(home, ".agents", "skills"),
    ]);
    expect(service.toolLayers(project).map((layer) => layer.path)).toEqual([
      join(project, ".agents", "tools"),
      join(dataRoot, "tools"),
    ]);
    expect(service.subAgentLayers(project).map((layer) => layer.path)).toEqual([
      join(project, ".agents", "sub-agents"),
      join(dataRoot, "sub-agents"),
    ]);
  });

  it("没有项目时只给项目之外的那几层", () => {
    expect(service.mcpLayers(null).map((layer) => layer.depth)).toEqual([3, 4]);
    expect(service.skillLayers(null).map((layer) => layer.depth)).toEqual([2, 3]);
    expect(service.toolLayers(null).map((layer) => layer.depth)).toEqual([1]);
    expect(service.subAgentLayers(null).map((layer) => layer.depth)).toEqual([1]);
  });

  it("组装一个 Scope 要的路径（R54）", () => {
    const paths = service.scopeAbilityPaths(project);
    expect(paths.agentsDir).toBe(join(dataRoot, "agents"));
    expect(paths.skillsPaths).toHaveLength(4);
    expect(paths.toolsPaths).toHaveLength(2);
    expect(paths.subAgentsPaths).toHaveLength(2);
    expect(paths.mcpPaths).toHaveLength(5);
    expect(paths.mcpPaths[0]).toBe(join(project, ".mcp.json"));
  });
});

describe("DiscoveryService 读 MCP", () => {
  it("近的层优先，被盖住的那条也留在自己那一层并说明被谁覆盖", async () => {
    await writeJson(join(project, ".ai-zen", "mcp.json"), {
      mcpServers: {
        shared: { type: "stdio", command: "node", args: ["near"] },
        "only-workspace": { type: "stdio", command: "node" },
      },
    });
    await writeJson(join(dataRoot, "mcp.json"), {
      mcpServers: {
        shared: { type: "http", url: "https://far.example" },
        "only-user": { type: "http", url: "https://user.example" },
      },
    });

    const { discovery } = await service.discover({ workspaceId: WORKSPACE_ID });

    expect(discovery.workspaceId).toBe(WORKSPACE_ID);
    expect(discovery.mcps.map((layer) => layer.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(discovery.mcps.map((layer) => layer.editable)).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);

    const near = layerAt(discovery.mcps, 1);
    expect(near.state).toBe("ok");
    expect(near.entries.map((entry) => entry.id)).toEqual(["only-workspace", "shared"]);
    expect(near.entries.every((entry) => entry.problem === null)).toBe(true);

    const far = layerAt(discovery.mcps, 3);
    expect(far.state).toBe("ok");
    const shadowed = far.entries.find((entry) => entry.id === "shared");
    expect(shadowed?.problem?.messageKey).toBe("discovery.shadowed");
    expect(shadowed?.problem?.params.path).toBe(near.path);
    expect(far.entries.find((entry) => entry.id === "only-user")?.problem).toBeNull();

    // 与 SDK 的合并口径一致：同 id 取近的那一层
    const effective = await service.effectiveMcpServers(project);
    expect(effective.map((server) => server.id).sort()).toEqual([
      "only-user",
      "only-workspace",
      "shared",
    ]);
    expect(effective.find((server) => server.id === "shared")?.transport).toBe("stdio");
  });

  it("文件不存在与文件坏了分开报", async () => {
    await writeText(join(project, ".ai-zen", "mcp.json"), "{ 这不是 JSON");

    const { discovery } = await service.discover({ workspaceId: WORKSPACE_ID });

    const broken = layerAt(discovery.mcps, 1);
    expect(broken.state).toBe("broken");
    expect(broken.problem?.messageKey).toBe("config.fileBroken");
    expect(broken.problem?.params.path).toBe(join(project, ".ai-zen", "mcp.json"));
    expect(broken.entries).toEqual([]);

    const missing = layerAt(discovery.mcps, 0);
    expect(missing.state).toBe("missing");
    expect(missing.problem).toBeNull();
  });

  it("mcpServers 不是对象也算坏文件", async () => {
    await writeJson(join(dataRoot, "mcp.json"), { mcpServers: ["nope"] });
    const { discovery } = await service.discover({ workspaceId: WORKSPACE_ID });
    expect(layerAt(discovery.mcps, 3).state).toBe("broken");
  });

  it("写回时保留 oauth 与这一版不认识的字段", async () => {
    await writeJson(join(dataRoot, "mcp.json"), {
      mcpServers: {
        a: {
          type: "http",
          url: "https://old.example",
          disabled: true,
          oauth: { authorizationUrl: "https://auth", tokenUrl: "https://token", clientId: "c" },
          "x-custom": { nested: [1, 2] },
        },
      },
    });

    const layer = await service.writeMcpLayer(
      "user",
      [
        { id: "a", transport: "http", url: "https://new.example" },
        { id: "b", transport: "stdio", command: "node", args: ["-v"] },
      ],
      null,
    );

    const written = JSON.parse(await readFile(join(dataRoot, "mcp.json"), "utf-8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(written.mcpServers.a.type).toBe("http");
    expect(written.mcpServers.a.url).toBe("https://new.example");
    expect(written.mcpServers.a.oauth).toEqual({
      authorizationUrl: "https://auth",
      tokenUrl: "https://token",
      clientId: "c",
    });
    expect(written.mcpServers.a["x-custom"]).toEqual({ nested: [1, 2] });
    expect(written.mcpServers.a.disabled).toBe(true);
    expect(written.mcpServers.b.command).toBe("node");

    expect(layer.path).toBe(join(dataRoot, "mcp.json"));
    expect(layer.state).toBe("ok");
    expect(layer.entries.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
  });

  it("写回时可以改回去：显式给 disabled: false 就会写进去", async () => {
    await writeJson(join(project, ".ai-zen", "mcp.json"), {
      mcpServers: { a: { type: "stdio", command: "node", disabled: true } },
    });
    const layer = await service.writeMcpLayer(
      "workspace",
      [{ id: "a", transport: "stdio", command: "node", disabled: false }],
      project,
    );
    expect(layer.entries[0]?.enabled).toBe(true);
    const written = JSON.parse(
      await readFile(join(project, ".ai-zen", "mcp.json"), "utf-8"),
    ) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(written.mcpServers.a.disabled).toBe(false);
  });

  it("workspace 作用域没给项目就拒", async () => {
    await expect(service.writeMcpLayer("workspace", [], null)).rejects.toBeInstanceOf(ServerError);
  });
});

describe("DiscoveryService 读目录类能力", () => {
  it("Skill 4 层、近的优先、坏掉的 SKILL.md 也要看得见", async () => {
    const skill = (name: string, description: string): string =>
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
    await writeText(join(project, ".ai-zen", "skills", "handoff", "SKILL.md"), skill("handoff", "near"));
    await writeText(join(dataRoot, "skills", "handoff", "SKILL.md"), skill("handoff", "far"));
    await writeText(join(dataRoot, "skills", "no-frontmatter", "SKILL.md"), "# 只有正文\n");

    const { discovery } = await service.discover({ workspaceId: WORKSPACE_ID });

    expect(discovery.skills.map((layer) => layer.depth)).toEqual([0, 1, 2, 3]);
    const near = layerAt(discovery.skills, 0);
    expect(near.state).toBe("ok");
    expect(near.entries.map((entry) => entry.id)).toEqual(["handoff"]);
    expect(near.entries[0]?.name).toBe("handoff");

    expect(layerAt(discovery.skills, 1).state).toBe("missing");

    const far = layerAt(discovery.skills, 2);
    expect(far.state).toBe("ok");
    const shadowed = far.entries.find((entry) => entry.id === "handoff");
    expect(shadowed?.problem?.messageKey).toBe("discovery.shadowed");
    const broken = far.entries.find((entry) => entry.id === "no-frontmatter");
    expect(broken?.enabled).toBe(false);
    expect(broken?.problem?.messageKey).toBe("discovery.skillBroken");

    expect(layerAt(discovery.skills, 3).state).toBe("missing");
  });

  it("工具 2 层：加载不成的文件也列出来", async () => {
    await writeText(join(project, ".agents", "tools", "not-a-tool.mjs"), "export const value = 1;\n");

    const { discovery } = await service.discover({ workspaceId: WORKSPACE_ID });

    expect(discovery.tools.map((layer) => layer.depth)).toEqual([0, 1]);
    const near = layerAt(discovery.tools, 0);
    expect(near.state).toBe("ok");
    const entry = near.entries.find((candidate) => candidate.id === "not-a-tool");
    expect(entry?.enabled).toBe(false);
    expect(entry?.problem?.messageKey).toBe("discovery.toolUnloadable");
    expect(layerAt(discovery.tools, 1).state).toBe("missing");
  });

  it("子 Agent 2 层：没有 function 的 json 说明它用不了", async () => {
    await writeJson(join(project, ".agents", "sub-agents", "helper.json"), {
      id: "helper",
      name: "Helper",
      messages: [],
      function: { name: "helper_tool", description: "d", parameters: { type: "object" } },
    });
    await writeJson(join(dataRoot, "sub-agents", "plain.json"), { id: "plain", name: "Plain" });

    const { discovery } = await service.discover({ workspaceId: WORKSPACE_ID });

    const near = layerAt(discovery.subagents, 0);
    expect(near.entries.map((entry) => entry.id)).toEqual(["helper"]);
    expect(near.entries[0]?.problem).toBeNull();
    expect(near.entries[0]?.source).toBe(join(project, ".agents", "sub-agents", "helper.json"));

    const far = layerAt(discovery.subagents, 1);
    const plain = far.entries.find((entry) => entry.id === "plain");
    expect(plain?.enabled).toBe(false);
    expect(plain?.problem?.messageKey).toBe("discovery.subAgentBroken");
  });

  it("项目不存在时按 not_found 拒", async () => {
    await expect(service.discover({ workspaceId: "没有这个项目" })).rejects.toBeInstanceOf(
      ServerError,
    );
  });
});
