/**
 * `ConfigService` —— 用临时目录测真实的落盘行为。
 *
 * 不 mock 任何东西：这一层的价值就在于「路径拼对没有、文件写坏没有、坏文件报得对不对」，
 * mock 掉 `fs` 等于把要测的东西删了。所有用例都在 `mkdtemp` 出来的目录里跑，
 * 绝不碰用户真实的配置根（否则跑一次测试就把用户的 Agent 定义改了）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { ConfigService } from "./ConfigService.js";
import { ensureWorkspace } from "../workspace/workspace.js";

let root: string;
let workspacesRoot: string;
let service: ConfigService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aiz-config-service-"));
  workspacesRoot = join(root, "workspaces");
  service = new ConfigService({
    configFile: join(root, "config.json"),
    agentsDir: join(root, "agents"),
    subAgentsDir: join(root, "sub-agents"),
    globalMcpFile: join(root, "mcp.json"),
    workspacesRoot,
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * 一份能落盘的 Agent 定义（`id` 决定文件名，`messages` 至少一条）。
 *
 * 末尾的断言只为省掉一个依赖：`role` 在 core 里是 string enum，本包不直接依赖 core，
 * 所以这里造一个**形状**正确的对象（落盘层不校验、也不该校验 SDK 的枚举）。
 */
function definition(id: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    name: id,
    messages: [{ id: `${id}-m1`, role: "system", content: "你是助手" }],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...extra,
  } as unknown as AgentDefinition;
}

describe("全局配置", () => {
  it("文件不存在时读出出厂默认配置（不是空对象）", async () => {
    const { config } = await service.get();
    expect(Array.isArray((config as AppConfig).models)).toBe(true);
    expect((config as AppConfig).models.length).toBeGreaterThan(0);
  });

  it("save 之后 get 读得回来（整份往返，字段不丢）", async () => {
    const before = (await service.get()).config as AppConfig;
    const next: AppConfig = { ...before, maxToolOutput: 1234 };

    await expect(service.save(next)).resolves.toEqual({ saved: true });

    const after = (await service.get()).config as AppConfig;
    expect(after.maxToolOutput).toBe(1234);
    expect(after.models).toEqual(before.models);
    // 落盘的是可读的 JSON（人能直接改，也是排障时的唯一凭据）
    expect(readFileSync(join(root, "config.json"), "utf-8")).toContain('"maxToolOutput": 1234');
  });

  it("save 不做 bootstrap：只写 config.json，不顺手创建 agents/ 之类的目录", async () => {
    await service.save((await service.get()).config as AppConfig);

    expect(readFileSync(join(root, "config.json"), "utf-8").length).toBeGreaterThan(0);
    // bootstrap 会建 agents/、sub-agents/、skills/ …；那属于组装根的初始化职责
    expect(() => statSync(join(root, "agents"))).toThrow();
    expect(() => statSync(join(root, "sub-agents"))).toThrow();
  });

  it("reasoningPresets：文件缺失时回落到出厂种子（不写盘）", async () => {
    const { presets } = await service.reasoningPresets();
    const table = presets as Record<string, { levels: Record<string, unknown> }>;

    expect(Object.keys(table)).toContain("openai");
    expect(table.openai.levels).toHaveProperty("off");
    // 只是回落，不会在磁盘上凭空造出这张表
    expect(() => statSync(join(root, "reasoning-presets.json"))).toThrow();
  });
});

describe("全局兜底模型（setDefaultModel：只写一个字段）", () => {
  it("写进 config.json 的 defaultModel，其它字段一个不动", async () => {
    const before = (await service.get()).config as AppConfig;
    // 先放一个「对方的改动」：窄方法不许把它抹掉（多客户端并存时就靠这条）
    await service.save({ ...before, maxToolOutput: 4321, defaultAgent: "coder" });

    await expect(service.setDefaultModel("gpt-6-astra")).resolves.toEqual({
      modelId: "gpt-6-astra",
    });

    const after = (await service.get()).config as AppConfig;
    expect(after.defaultModel).toBe("gpt-6-astra");
    expect(after.maxToolOutput).toBe(4321);
    expect(after.defaultAgent).toBe("coder");
    expect(after.models).toEqual(before.models);
    // 落盘的就是可读 JSON：这条字段确实写进了那个文件（不是只活在内存里）
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf-8")).defaultModel).toBe(
      "gpt-6-astra",
    );
  });

  it("不校验模型存不存在（那是客户端切换前的链路校验；写错了由 createAgent 在用时报）", async () => {
    await expect(service.setDefaultModel("not-a-model")).resolves.toEqual({
      modelId: "not-a-model",
    });
    expect((await service.get()).config as AppConfig).toMatchObject({
      defaultModel: "not-a-model",
    });
  });
});

describe("MCP 配置（global）", () => {
  it("文件不存在 = 正常空配置（带那个文件的路径）", async () => {
    await expect(service.mcpGet({ scope: "global" })).resolves.toEqual({
      ok: true,
      config: { mcpServers: {} },
      path: join(root, "mcp.json"),
    });
  });

  it("坏 JSON = 可展示的状态（ok:false + 原因），不是抛错、也不改写文件", async () => {
    writeFileSync(join(root, "mcp.json"), '{ "mcpServers": { oops }', "utf-8");

    const result = await service.mcpGet({ scope: "global" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.length).toBeGreaterThan(0);
    // 原始内容还在：客户端还没决定要不要覆盖，服务端不许先动
    expect(readFileSync(join(root, "mcp.json"), "utf-8")).toBe('{ "mcpServers": { oops }');
  });

  it("顶层不是对象也算坏文件（数组/null 没法当配置编辑）", async () => {
    writeFileSync(join(root, "mcp.json"), "[1,2,3]", "utf-8");
    const result = await service.mcpGet({ scope: "global" });
    expect(result.ok).toBe(false);
  });

  it("save 之后 get 读得回，缺父目录也能写出来", async () => {
    const config = { mcpServers: { pty: { command: "npx", args: ["socket-pty"] } } };

    await expect(service.mcpSave({ scope: "global", config })).resolves.toEqual({ saved: true });
    await expect(service.mcpGet({ scope: "global" })).resolves.toEqual({
      ok: true,
      config,
      path: join(root, "mcp.json"),
    });
  });
});

describe("MCP 配置（project：路径要靠 workspaceId 找回工作区）", () => {
  it("写到 <工作区>/.ai-zen/mcp.json，读得回来", async () => {
    const projectPath = join(root, "proj-a");
    mkdirSync(projectPath, { recursive: true });
    const workspace = await ensureWorkspace({ workspacesRoot, path: projectPath });

    await expect(
      service.mcpSave({
        scope: "project",
        workspaceId: workspace.id,
        config: { mcpServers: { local: { command: "node" } } },
      }),
    ).resolves.toEqual({ saved: true });

    // 文件确实落在工作区里，而不是全局那份
    const onDisk = JSON.parse(readFileSync(join(projectPath, ".ai-zen", "mcp.json"), "utf-8"));
    expect(onDisk).toEqual({ mcpServers: { local: { command: "node" } } });
    expect(() => statSync(join(root, "mcp.json"))).toThrow();

    await expect(service.mcpGet({ scope: "project", workspaceId: workspace.id })).resolves.toEqual({
      ok: true,
      config: { mcpServers: { local: { command: "node" } } },
      path: join(projectPath, ".ai-zen", "mcp.json"),
    });
  });

  it("缺 workspaceId → workspace-required（可判别，不是 bad-params）", async () => {
    await expect(service.mcpGet({ scope: "project" })).rejects.toMatchObject({
      code: "workspace-required",
    });
    await expect(
      service.mcpSave({ scope: "project", config: { mcpServers: {} } }),
    ).rejects.toMatchObject({ code: "workspace-required" });
  });

  it("工作区记录不存在 / 记录坏了 → unknown-workspace", async () => {
    await expect(
      service.mcpGet({ scope: "project", workspaceId: "nope-12345678" }),
    ).rejects.toMatchObject({ code: "unknown-workspace" });

    mkdirSync(join(workspacesRoot, "broken-12345678"), { recursive: true });
    writeFileSync(join(workspacesRoot, "broken-12345678", "workspace.json"), "{oops", "utf-8");
    await expect(
      service.mcpGet({ scope: "project", workspaceId: "broken-12345678" }),
    ).rejects.toMatchObject({ code: "unknown-workspace" });
  });

  it("workspaceId 指到 workspaces 外面 → unknown-workspace（id 来自客户端，不能逃逸）", async () => {
    await expect(
      service.mcpGet({ scope: "project", workspaceId: "../../etc" }),
    ).rejects.toMatchObject({ code: "unknown-workspace" });
  });
});

describe("Agent 定义", () => {
  it("listAgents 两路分开给（顶层与子 Agent 各一栏）", async () => {
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "sub-agents"), { recursive: true });
    writeFileSync(join(root, "agents", "a.json"), JSON.stringify(definition("a")), "utf-8");
    writeFileSync(join(root, "agents", "b.json"), JSON.stringify(definition("b")), "utf-8");
    writeFileSync(join(root, "sub-agents", "x.json"), JSON.stringify(definition("x")), "utf-8");

    const { agents, subAgents } = await service.listAgents();

    expect((agents as AgentDefinition[]).map((item) => item.id).sort()).toEqual(["a", "b"]);
    expect((subAgents as AgentDefinition[]).map((item) => item.id)).toEqual(["x"]);
  });

  it("listAgents 跳过解析失败的文件（一个坏文件不该让整栏空掉）", async () => {
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents", "good.json"), JSON.stringify(definition("good")), "utf-8");
    writeFileSync(join(root, "agents", "bad.json"), "{oops", "utf-8");

    const { agents } = await service.listAgents();
    expect((agents as AgentDefinition[]).map((item) => item.id)).toEqual(["good"]);
  });

  it("getAgent：不带 kind 时顶层优先，其次子 Agent，都没有回 null", async () => {
    const writer = await service.saveAgent("agent", definition("default", { name: "顶层" }));
    expect(writer).toEqual({ saved: true });
    await service.saveAgent("subagent", definition("helper", { name: "子" }));
    await service.saveAgent("subagent", definition("default", { name: "子里的 default" }));

    expect((await service.getAgent({ id: "default" })).agent).toMatchObject({ name: "顶层" });
    expect((await service.getAgent({ id: "helper" })).agent).toMatchObject({ name: "子" });
    expect((await service.getAgent({ id: "ghost" })).agent).toBeNull();
  });

  /**
   * 同名 id 是两个池子里各自的**两份**定义。这一组是回归保护：曾经 `getAgent` 只收 `id`，
   * 客户端两栏界面上点中子 Agent 的 `default`，拿回的是顶层那份。
   */
  describe("getAgent 区分池子（kind）", () => {
    beforeEach(async () => {
      // 都叫 `default` 是默认情形，不是边角：出厂就两栏各一个
      await service.saveAgent("agent", definition("default", { name: "顶层" }));
      await service.saveAgent("subagent", definition("default", { name: "子里的 default" }));
      await service.saveAgent("subagent", definition("helper", { name: "帮手" }));
    });

    it("不指定 kind：同名时拿到顶层那份", async () => {
      expect((await service.getAgent({ id: "default" })).agent).toMatchObject({ name: "顶层" });
    });

    it("kind: subagent → 子 Agent 那份（不被顶层抢走）", async () => {
      expect((await service.getAgent({ id: "default", kind: "subagent" })).agent).toMatchObject({
        name: "子里的 default",
      });
    });

    it("kind: agent → 顶层那份", async () => {
      expect((await service.getAgent({ id: "default", kind: "agent" })).agent).toMatchObject({
        name: "顶层",
      });
    });

    it("只有子 Agent 有该 id、不指定 kind：回落到子 Agent 那份", async () => {
      expect((await service.getAgent({ id: "helper" })).agent).toMatchObject({ name: "帮手" });
    });

    it("指定了池子就不跨池回落（顶层没有的 id 加上 kind:agent 是 null）", async () => {
      await expect(service.getAgent({ id: "helper", kind: "agent" })).resolves.toEqual({
        agent: null,
      });
    });
  });

  it("saveAgent 按 kind 落到两个目录（同名 id 是两份不同的定义）", async () => {
    await service.saveAgent("agent", definition("dup", { name: "顶层" }));
    await service.saveAgent("subagent", definition("dup", { name: "子" }));

    const top = JSON.parse(readFileSync(join(root, "agents", "dup.json"), "utf-8"));
    const sub = JSON.parse(readFileSync(join(root, "sub-agents", "dup.json"), "utf-8"));
    expect(top.name).toBe("顶层");
    expect(sub.name).toBe("子");
  });

  it("removeAgent：存在回 true 且文件消失，不存在回 false 而不抛错", async () => {
    await service.saveAgent("agent", definition("gone"));

    await expect(service.removeAgent("agent", "gone")).resolves.toEqual({ removed: true });
    expect(() => statSync(join(root, "agents", "gone.json"))).toThrow();

    await expect(service.removeAgent("agent", "gone")).resolves.toEqual({ removed: false });
    await expect(service.removeAgent("subagent", "never")).resolves.toEqual({ removed: false });
  });

  it("id 想逃出定义目录 → 直接拒（id 来自客户端）", async () => {
    await expect(service.saveAgent("agent", definition("../../evil"))).rejects.toThrow(
      /Invalid entity id/,
    );
    await expect(service.getAgent({ id: "../../evil" })).rejects.toThrow(/Invalid entity id/);
    await expect(service.getAgent({ id: "../../evil", kind: "subagent" })).rejects.toThrow(
      /Invalid entity id/,
    );
  });
});

describe("ConfigService：bootstrap 由服务端负责", () => {
  it("空目录 bootstrap 之后：默认 Agent / 子 Agent 都在，配置也是出厂的", async () => {
    // 客户端不再碰本机配置目录，所以“首次启动就有默认 Agent”只能由服务端保证 ——
    // 否则新机器上第一个 `agent.list` 拿到空列表，TUI 连启动都过不去
    expect((await service.listAgents()).agents).toEqual([]);

    await service.bootstrap();

    const listed = await service.listAgents();
    expect(listed.agents.map((agent) => (agent as AgentDefinition).id)).toContain("default");
    expect(listed.subAgents.length).toBeGreaterThan(0);
    // 默认 Agent 必须绑着出厂模型，否则 createAgent 一开会话就报“未绑定模型”
    expect((listed.agents[0] as AgentDefinition).modelId).toBeTruthy();
    expect(((await service.get()).config as AppConfig).models?.length).toBeGreaterThan(0);
  });

  it("bootstrap 幂等：跑两次不会把用户的改动冲掉", async () => {
    await service.bootstrap();
    const before = await service.listAgents();
    const first = before.agents[0] as AgentDefinition;
    await service.saveAgent("agent", { ...first, name: "我改过的名字" });

    await service.bootstrap();

    const after = (await service.listAgents()).agents.find(
      (agent) => (agent as AgentDefinition).id === first.id,
    );
    expect((after as AgentDefinition).name).toBe("我改过的名字");
  });
});

/**
 * 配置写盘之后，服务端**自己**要把缓存的 Scope 作废。
 *
 * 不这样做的症状是「改了配置，另一段会话还在用旧的」：`Scope` 里存着配置快照，而且是按
 * 工作区缓存的 —— 客户端只会 reload 它手上那段会话所在的工作区，别的工作区照样是旧的。
 * 这里只锁「写盘后通知了」这件事；「通知之后兜底真的生效」由真进程冒烟验（`resolveModel`
 * 的用例只证明解析顺序，不证明快照刷新）。
 */
describe("ConfigService：写盘后通知装配方（丢旧配置快照）", () => {
  it("三条写路径都会通知：save / setDefaultAgent / setDefaultModel", async () => {
    let notified = 0;
    const watched = new ConfigService({
      configFile: join(root, "config.json"),
      agentsDir: join(root, "agents"),
      subAgentsDir: join(root, "sub-agents"),
      globalMcpFile: join(root, "mcp.json"),
      workspacesRoot,
      onConfigChanged: () => {
        notified++;
      },
    });

    await watched.save({ endpoints: [], models: [] });
    expect(notified).toBe(1);
    await watched.setDefaultAgent("default");
    expect(notified).toBe(2);
    await watched.setDefaultModel("gpt-6-astra");
    expect(notified).toBe(3);
  });

  it("只读的方法不通知（读配置不该让运行时重建）", async () => {
    let notified = 0;
    const watched = new ConfigService({
      configFile: join(root, "config.json"),
      agentsDir: join(root, "agents"),
      subAgentsDir: join(root, "sub-agents"),
      globalMcpFile: join(root, "mcp.json"),
      workspacesRoot,
      onConfigChanged: () => {
        notified++;
      },
    });
    await watched.save({ endpoints: [], models: [] });
    const before = notified;

    await watched.get();
    await watched.reasoningPresets();
    await watched.listAgents();

    expect(notified).toBe(before);
  });

  it("不注入回调时照常工作（单测与嵌入式用法不必关心装配方）", async () => {
    await expect(service.setDefaultModel("gpt-6-astra")).resolves.toEqual({
      modelId: "gpt-6-astra",
    });
  });
});
