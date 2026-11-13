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

import { HostError } from "../wire/errors.js";
import type { DiscoveryEntryView, DiscoveryLayerView, McpServerEntryInput } from "../wire/index.js";
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

/**
 * 层里的一个条目 → 写入入参（读回来、原样写回去）。
 *
 * 这是「客户端拿到视图怎么回写」的最小写法：`null` 表示这一项没有，省略即可；
 * `enabled` 折回 SDK 的 `disabled`；`extra` 一路带着。CLI 侧的 `mcp-helpers.ts` 做的是同一件事。
 */
function inputOf(entry: DiscoveryEntryView): McpServerEntryInput {
  return {
    id: entry.id,
    transport: entry.transport ?? "stdio",
    ...(entry.description !== null ? { description: entry.description } : {}),
    ...(entry.enabled ? {} : { disabled: true }),
    ...(entry.command !== null ? { command: entry.command } : {}),
    ...(entry.args !== null ? { args: entry.args } : {}),
    ...(entry.env !== null ? { env: entry.env } : {}),
    ...(entry.url !== null ? { url: entry.url } : {}),
    ...(entry.headers !== null ? { headers: entry.headers } : {}),
    ...(entry.oauth !== null ? { oauth: entry.oauth } : {}),
    extra: entry.extra,
  };
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
    // 可写的只有两层，而且由宿主直接点名（F-F6：客户端不必按 editable + depth 反推）
    expect(discovery.mcps.map((layer) => layer.scope)).toEqual([
      null,
      "workspace",
      null,
      "user",
      null,
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
    expect(effective.map((host) => host.id).sort()).toEqual([
      "only-user",
      "only-workspace",
      "shared",
    ]);
    expect(effective.find((host) => host.id === "shared")?.transport).toBe("stdio");
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

  it("条目视图带齐传输入口：传输方式与它的参数，加上两个未知键进 extra（F-F6）", async () => {
    await writeJson(join(dataRoot, "mcp.json"), {
      mcpServers: {
        remote: {
          type: "http",
          url: "https://api.example/mcp",
          headers: { Authorization: "Bearer t" },
          description: "远程",
          oauth: { authorizationUrl: "https://auth", tokenUrl: "https://token", clientId: "c" },
          "x-timeout": 30,
          "x-tags": ["a", "b"],
        },
        local: {
          type: "stdio",
          command: "npx",
          args: ["-y", "pty"],
          env: { DEBUG: "1" },
          disabled: true,
        },
      },
    });

    const { discovery } = await service.discover({ workspaceId: WORKSPACE_ID });
    const entries = layerAt(discovery.mcps, 3).entries;
    const remote = entries.find((entry) => entry.id === "remote");
    expect(remote).toMatchObject({
      transport: "http",
      url: "https://api.example/mcp",
      headers: { Authorization: "Bearer t" },
      description: "远程",
      oauth: { authorizationUrl: "https://auth", tokenUrl: "https://token", clientId: "c" },
      enabled: true,
      extra: { "x-timeout": 30, "x-tags": ["a", "b"] },
    });
    expect(remote?.problem).toBeNull();

    const local = entries.find((entry) => entry.id === "local");
    expect(local).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "pty"],
      env: { DEBUG: "1" },
      url: null,
      headers: null,
      enabled: false,
      extra: {},
    });
  });

  it("没有传输方式、也推不出来的条目：transport 为 null 并报出问题", async () => {
    await writeJson(join(dataRoot, "mcp.json"), { mcpServers: { odd: { description: "没写怎么起" } } });
    const { discovery } = await service.discover({ workspaceId: WORKSPACE_ID });
    const odd = layerAt(discovery.mcps, 3).entries.find((entry) => entry.id === "odd");
    expect(odd?.transport).toBeNull();
    expect(odd?.problem?.messageKey).toBe("discovery.mcpEntryInvalid");
  });

  it("**读回来的条目原样写回去 == 一字未改**（F-F6：未知字段原样保留）", async () => {
    // 文件里的每一项都写全：六个传输入口 + oauth + 两个本版不认识的键 + 顶层多一个键
    const path = join(dataRoot, "mcp.json");
    const original =
      `${JSON.stringify(
        {
          $schema: "https://example.test/mcp.schema.json",
          mcpServers: {
            remote: {
              type: "sse",
              url: "https://api.example/sse",
              headers: { Authorization: "Bearer t", "X-Trace": "on" },
              description: "远程",
              oauth: {
                authorizationUrl: "https://auth.example/a",
                tokenUrl: "https://auth.example/t",
                clientId: "client-1",
                clientSecret: "secret-1",
                scope: "mcp",
              },
              "x-timeout": 30,
              "x-tags": ["a", { nested: true }],
            },
            local: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-x"],
              env: { DEBUG: "1" },
              disabled: false,
              "x-quirk": null,
            },
          },
        },
        null,
        2,
      )}\n`;
    await writeText(path, original);

    const before = await service.discover({ workspaceId: WORKSPACE_ID });
    const layer = layerAt(before.discovery.mcps, 3);
    expect(layer.scope).toBe("user");

    // 视图 → 入参 → 写回：CLI 的 MCP 屏做的就是这件事
    for (const entry of layer.entries) {
      await service.writeMcpEntry("user", inputOf(entry), null);
    }

    expect(await readFile(path, "utf-8")).toBe(original);
  });

  it("改一条不动另一条：另一个条目的字节与它的未知键都留着", async () => {
    await writeJson(join(dataRoot, "mcp.json"), {
      mcpServers: {
        a: { type: "stdio", command: "node", args: ["a"], "x-keep": 1 },
        b: { type: "http", url: "https://b.example", headers: { "X-B": "1" } },
      },
    });
    const before = JSON.parse(await readFile(join(dataRoot, "mcp.json"), "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };

    const layer = await service.writeMcpEntry(
      "user",
      { id: "a", transport: "stdio", command: "node", args: ["a", "--verbose"] },
      null,
    );

    const after = JSON.parse(await readFile(join(dataRoot, "mcp.json"), "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(after.mcpServers.b).toEqual(before.mcpServers.b);
    expect(after.mcpServers.a).toEqual({
      type: "stdio",
      command: "node",
      args: ["a", "--verbose"],
      "x-keep": 1,
    });
    expect(layer.entries.find((entry) => entry.id === "a")?.args).toEqual(["a", "--verbose"]);
  });

  it("没给 id 的那一条是新建，且不动层里已有的条目", async () => {
    await writeJson(join(dataRoot, "mcp.json"), {
      mcpServers: { a: { type: "stdio", command: "node", "x-keep": 1 } },
    });

    const layer = await service.writeMcpEntry(
      "user",
      { id: "b", transport: "http", url: "https://b.example" },
      null,
    );

    const written = JSON.parse(await readFile(join(dataRoot, "mcp.json"), "utf-8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(written.mcpServers).sort()).toEqual(["a", "b"]);
    expect(written.mcpServers.a).toEqual({ type: "stdio", command: "node", "x-keep": 1 });
    expect(written.mcpServers.b).toEqual({ type: "http", url: "https://b.example" });
    expect(layer.entries.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
  });

  it("写回时可以改回去：显式给 disabled: false 就会写进去", async () => {
    await writeJson(join(project, ".ai-zen", "mcp.json"), {
      mcpServers: { a: { type: "stdio", command: "node", disabled: true } },
    });
    const layer = await service.writeMcpEntry(
      "workspace",
      { id: "a", transport: "stdio", command: "node", disabled: false },
      project,
    );
    expect(layer.entries[0]?.enabled).toBe(true);
    const written = JSON.parse(
      await readFile(join(project, ".ai-zen", "mcp.json"), "utf-8"),
    ) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(written.mcpServers.a.disabled).toBe(false);
  });

  it("坏文件写一次就修好（同一动作既是新建也是修复，F-F6）", async () => {
    await writeText(join(dataRoot, "mcp.json"), "{ 这不是 JSON");

    const layer = await service.writeMcpEntry(
      "user",
      { id: "a", transport: "stdio", command: "node" },
      null,
    );

    expect(layer.state).toBe("ok");
    expect(layer.entries.map((entry) => entry.id)).toEqual(["a"]);
    const written = JSON.parse(await readFile(join(dataRoot, "mcp.json"), "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(written.mcpServers).toEqual({ a: { type: "stdio", command: "node" } });
  });

  it("删除一条：别的条目留着；本来就没有时 removed: false 且文件不变", async () => {
    await writeJson(join(dataRoot, "mcp.json"), {
      mcpServers: {
        a: { type: "stdio", command: "node" },
        b: { type: "http", url: "https://b.example" },
      },
    });

    const first = await service.deleteMcpEntry("user", "a", null);
    expect(first.removed).toBe(true);
    expect(first.layer.entries.map((entry) => entry.id)).toEqual(["b"]);

    const afterFirst = await readFile(join(dataRoot, "mcp.json"), "utf-8");
    const again = await service.deleteMcpEntry("user", "a", null);
    expect(again.removed).toBe(false);
    expect(await readFile(join(dataRoot, "mcp.json"), "utf-8")).toBe(afterFirst);
    expect(again.layer.entries.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("workspace 作用域没给项目就拒", async () => {
    await expect(
      service.writeMcpEntry("workspace", { id: "a", transport: "stdio" }, null),
    ).rejects.toBeInstanceOf(HostError);
    await expect(service.deleteMcpEntry("workspace", "a", null)).rejects.toBeInstanceOf(HostError);
  });

  it("空 id 两种写法都拒（没地方落地）", async () => {
    await expect(
      service.writeMcpEntry("user", { id: "  ", transport: "stdio" }, null),
    ).rejects.toBeInstanceOf(HostError);
    await expect(service.deleteMcpEntry("user", " ", null)).rejects.toBeInstanceOf(HostError);
  });

  it("不认识的传输方式当场拒，不写盘", async () => {
    await expect(
      service.writeMcpEntry(
        "user",
        { id: "a", transport: "websocket" as unknown as McpServerEntryInput["transport"] },
        null,
      ),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(readFile(join(dataRoot, "mcp.json"), "utf-8")).rejects.toBeTruthy();
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
    // Skill / 工具 / 子 Agent 没有「按作用域写入」这回事（F-G1 只管 MCP）
    expect(discovery.skills.map((layer) => layer.scope)).toEqual([null, null, null, null]);
    expect(discovery.tools.map((layer) => layer.scope)).toEqual([null, null]);
    expect(discovery.subagents.map((layer) => layer.scope)).toEqual([null, null]);
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
      HostError,
    );
  });
});
