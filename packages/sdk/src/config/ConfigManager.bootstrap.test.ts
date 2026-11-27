import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConfigManager,
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_DEFINITION,
  DEFAULT_SUBAGENT_ID,
  DEFAULT_SUBAGENT_DEFINITION,
  DEFAULT_APP_CONFIG,
  DEFAULT_MCP_CONFIG,
} from "./ConfigManager.js";

async function tempDir() {
  return await fs.mkdtemp(join(tmpdir(), "ai-zen-bootstrap-"));
}

function makeManager(basePath: string) {
  return new ConfigManager(join(basePath, "config.json"));
}

describe("ConfigManager.ensureDefaultAgent", () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) await fs.rm(testDir, { recursive: true, force: true });
  });

  it("文件在但不是合法 JSON → 抛，不当成「没有这个文件」", async () => {
    testDir = await tempDir();
    const mgr = makeManager(testDir);
    await fs.mkdir(join(testDir, "agents"), { recursive: true });
    await fs.writeFile(
      join(testDir, "agents", `${DEFAULT_AGENT_ID}.json`),
      "{ 这不是 JSON",
      "utf-8",
    );

    // 当成「没有」的话，用户的自定义定义会静默消失（下面的初始化流程见目录里已有文件就收手）
    await expect(mgr.ensureDefaultAgent()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("全新空目录 → 创建 agents/ 并写入 default.json", async () => {
    testDir = await tempDir();
    const mgr = makeManager(testDir);

    const result = (await mgr.ensureDefaultAgent())!;

    expect(result.id).toBe(DEFAULT_AGENT_ID);
    const agentPath = join(testDir, "agents", `${DEFAULT_AGENT_ID}.json`);
    await expect(fs.access(agentPath)).resolves.toBeUndefined();

    const raw = JSON.parse(await fs.readFile(agentPath, "utf-8"));
    expect(raw.id).toBe(DEFAULT_AGENT_ID);
    expect(raw.name).toBe(DEFAULT_AGENT_DEFINITION.name);
    expect(raw.permissions.tools).toEqual({ allow: ["*"] });
    expect(raw.messages.length).toBe(1);
    expect(raw.messages[0].role).toBe("system");
    // 出厂默认 Agent 携带 custom: false（初始化时会同步出厂提示词）
    expect(raw.custom).toBe(false);
  });

  it("agents 目录已存在但为空 → 写入 default.json", async () => {
    testDir = await tempDir();
    const agentsDir = join(testDir, "agents");
    await fs.mkdir(agentsDir, { recursive: true });

    const mgr = makeManager(testDir);
    const result = (await mgr.ensureDefaultAgent())!;

    expect(result.id).toBe(DEFAULT_AGENT_ID);
    await expect(fs.access(join(agentsDir, `${DEFAULT_AGENT_ID}.json`))).resolves.toBeUndefined();
  });

  it("已有其他 agent → 不覆盖，返回 null", async () => {
    testDir = await tempDir();
    const agentsDir = join(testDir, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(
      join(agentsDir, "my-agent.json"),
      JSON.stringify({
        id: "my-agent",
        name: "My Agent",
        messages: [],
        createdAt: "",
        updatedAt: "",
      }),
    );

    const mgr = makeManager(testDir);
    const result = await mgr.ensureDefaultAgent();

    expect(result).toBeNull();
    await expect(fs.access(join(agentsDir, "my-agent.json"))).resolves.toBeUndefined();
    await expect(fs.access(join(agentsDir, `${DEFAULT_AGENT_ID}.json`))).rejects.toThrow();
  });

  it("default.json 已存在且 custom !== true → 保留自定义字段，仅同步出厂提示词", async () => {
    testDir = await tempDir();
    const agentsDir = join(testDir, "agents");
    await fs.mkdir(agentsDir, { recursive: true });

    const customContent = {
      id: DEFAULT_AGENT_ID,
      name: "My Custom Name",
      messages: [{ role: "system" as any, content: "Custom prompt" }],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      permissions: { tools: { deny: ["*"] } },
    };
    await fs.writeFile(
      join(agentsDir, `${DEFAULT_AGENT_ID}.json`),
      JSON.stringify(customContent, null, 2),
    );

    const mgr = makeManager(testDir);
    const result = (await mgr.ensureDefaultAgent())!;

    const raw = JSON.parse(await fs.readFile(join(agentsDir, `${DEFAULT_AGENT_ID}.json`), "utf-8"));
    // 非 messages 字段保留
    expect(raw.name).toBe("My Custom Name");
    expect(raw.permissions.tools).toEqual({ deny: ["*"] });
    expect(raw.createdAt).toBe("2024-01-01T00:00:00.000Z");
    // 提示词已同步为出厂内容，updatedAt 刷新
    expect(raw.messages[0].content).toBe(DEFAULT_AGENT_DEFINITION.messages[0].content);
    expect(raw.updatedAt).not.toBe("2024-01-01T00:00:00.000Z");
    expect(result.name).toBe("My Custom Name");
  });

  it("custom: true → 完全跳过提示词同步", async () => {
    testDir = await tempDir();
    const agentsDir = join(testDir, "agents");
    await fs.mkdir(agentsDir, { recursive: true });

    const customContent = {
      id: DEFAULT_AGENT_ID,
      name: "My Custom Name",
      custom: true,
      messages: [{ role: "system" as any, content: "My custom prompt" }],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    await fs.writeFile(
      join(agentsDir, `${DEFAULT_AGENT_ID}.json`),
      JSON.stringify(customContent, null, 2),
    );

    const mgr = makeManager(testDir);
    const result = (await mgr.ensureDefaultAgent())!;

    const raw = JSON.parse(await fs.readFile(join(agentsDir, `${DEFAULT_AGENT_ID}.json`), "utf-8"));
    expect(raw.messages[0].content).toBe("My custom prompt");
    expect(raw.updatedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(result.messages[0].content).toBe("My custom prompt");
  });

  it("提示词与出厂一致 → 不写盘、updatedAt 不变", async () => {
    testDir = await tempDir();
    const mgr = makeManager(testDir);
    await mgr.ensureDefaultAgent();

    const agentPath = join(testDir, "agents", `${DEFAULT_AGENT_ID}.json`);
    const first = JSON.parse(await fs.readFile(agentPath, "utf-8"));

    await new Promise<void>((resolve) => setTimeout(() => resolve(), 10));
    await mgr.ensureDefaultAgent();

    const second = JSON.parse(await fs.readFile(agentPath, "utf-8"));
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it("返回的 AgentDefinition 包含 createdAt 和 updatedAt", async () => {
    testDir = await tempDir();
    const mgr = makeManager(testDir);

    const result = (await mgr.ensureDefaultAgent())!;

    expect(result.createdAt).toBeTruthy();
    expect(result.updatedAt).toBeTruthy();
    expect(new Date(result.createdAt).toISOString()).toBe(result.createdAt);
    expect(new Date(result.updatedAt).toISOString()).toBe(result.updatedAt);
  });
});

describe("ConfigManager.ensureDefaultSubAgent", () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) await fs.rm(testDir, { recursive: true, force: true });
  });

  it("文件在但不是合法 JSON → 抛，不当成「没有这个文件」", async () => {
    testDir = await tempDir();
    const mgr = makeManager(testDir);
    await fs.mkdir(join(testDir, "sub-agents"), { recursive: true });
    await fs.writeFile(
      join(testDir, "sub-agents", `${DEFAULT_SUBAGENT_ID}.json`),
      "{ 这不是 JSON",
      "utf-8",
    );

    await expect(mgr.ensureDefaultSubAgent()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("全新空目录 → 创建 sub-agents/ 并写入 sub-agent-default.json", async () => {
    testDir = await tempDir();
    const mgr = makeManager(testDir);

    const result = (await mgr.ensureDefaultSubAgent())!;

    expect(result.id).toBe(DEFAULT_SUBAGENT_ID);
    expect(result.function!.name).toBe("sub_agent_default");
    const subPath = join(testDir, "sub-agents", `${DEFAULT_SUBAGENT_ID}.json`);
    await expect(fs.access(subPath)).resolves.toBeUndefined();
  });

  it("文件已存在 → 幂等，不覆盖", async () => {
    testDir = await tempDir();
    const subDir = join(testDir, "sub-agents");
    await fs.mkdir(subDir, { recursive: true });

    const custom = {
      id: DEFAULT_SUBAGENT_ID,
      name: "My Custom SubAgent",
      messages: [],
      function: {
        name: "custom_func",
        description: "",
        parameters: { type: "object", properties: {}, required: [] },
      },
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    await fs.writeFile(join(subDir, `${DEFAULT_SUBAGENT_ID}.json`), JSON.stringify(custom));

    const mgr = makeManager(testDir);
    const result = await mgr.ensureDefaultSubAgent();

    expect(result).not.toBeNull();
    expect(result!.name).toBe("My Custom SubAgent");
    expect(result!.function!.name).toBe("custom_func");
  });

  it("已有其他 SubAgent → 返回 null", async () => {
    testDir = await tempDir();
    const subDir = join(testDir, "sub-agents");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(
      join(subDir, "other.json"),
      JSON.stringify({ id: "other", name: "Other", messages: [], createdAt: "", updatedAt: "" }),
    );

    const mgr = makeManager(testDir);
    const result = await mgr.ensureDefaultSubAgent();

    expect(result).toBeNull();
    await expect(fs.access(join(subDir, `${DEFAULT_SUBAGENT_ID}.json`))).rejects.toThrow();
  });
});

describe("ConfigManager.ensureDefaultConfig", () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) await fs.rm(testDir, { recursive: true, force: true });
  });

  it("文件不存在时写入出厂默认配置", async () => {
    testDir = await tempDir();
    const mgr = makeManager(testDir);

    const cfg = await mgr.ensureDefaultConfig();

    expect(cfg.endpoints.length).toBeGreaterThan(0);
    expect(cfg.models.length).toBeGreaterThan(0);
    expect(cfg.imageModels!.length).toBeGreaterThan(0);
    await expect(fs.access(join(testDir, "config.json"))).resolves.toBeUndefined();
  });

  it("文件已存在 → 保留用户端点，模型清单同步为出厂最新", async () => {
    testDir = await tempDir();
    const mgr = makeManager(testDir);
    await mgr.write({ endpoints: [], models: [] });

    const cfg = await mgr.ensureDefaultConfig();

    // 端点不属于托管范围，原样保留
    expect(cfg.endpoints).toEqual([]);
    // 空模型清单被补齐为出厂最新定义
    expect(cfg.models.map((m) => m.id)).toEqual(DEFAULT_APP_CONFIG.models.map((m) => m.id));
  });

  it("模型同步：未标 custom 的旧模型被替换为出厂最新定义", async () => {
    testDir = await tempDir();
    const mgr = makeManager(testDir);
    // 模拟历史遗留配置：旧模型未标 custom
    await mgr.write({
      endpoints: [
        {
          id: "deepseek",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "sk-x",
        },
      ],
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          endpointId: "deepseek",
          tokenThresholds: { handoff: 250_000, guard: 375000 },
        },
      ],
      defaultMigrationModel: "deepseek-v4-flash",
    });

    const cfg = await mgr.ensureDefaultConfig();

    // 旧模型被移除，出厂最新模型就位
    expect(cfg.models.some((m) => m.id === "deepseek-v4-flash")).toBe(false);
    expect(cfg.models.map((m) => m.id)).toEqual(DEFAULT_APP_CONFIG.models.map((m) => m.id));
    expect(cfg.defaultMigrationModel).toBe(DEFAULT_APP_CONFIG.defaultMigrationModel);
    // 端点未被托管，保持原样
    expect(cfg.endpoints[0].apiKey).toBe("sk-x");
    // 已落盘
    const raw = JSON.parse(await fs.readFile(join(testDir, "config.json"), "utf-8"));
    expect(raw.models.map((m: { id: string }) => m.id)).toEqual(
      DEFAULT_APP_CONFIG.models.map((m) => m.id),
    );
  });

  it("模型同步：custom: true 的模型被完整保留", async () => {
    testDir = await tempDir();
    const mgr = makeManager(testDir);
    await mgr.write({
      endpoints: [],
      models: [
        {
          id: "my-local-llm",
          name: "Local Model",
          endpointId: "local",
          tokenThresholds: { handoff: 32_000, guard: 48000 },
          custom: true,
        },
      ],
    });

    const cfg = await mgr.ensureDefaultConfig();

    const mine = cfg.models.find((m) => m.id === "my-local-llm")!;
    expect(mine.name).toBe("Local Model");
    expect(mine.tokenThresholds.handoff).toBe(32_000);
    // 出厂模型 + 用户自定义模型共存
    expect(cfg.models.length).toBe(DEFAULT_APP_CONFIG.models.length + 1);
  });

  it("模型同步：custom: true 与出厂同 id 时用户版本优先且不重复", async () => {
    testDir = await tempDir();
    const mgr = makeManager(testDir);
    await mgr.write({
      endpoints: [],
      models: [
        {
          id: "glm-5.3",
          name: "My GLM-5.3",
          endpointId: "bigmodelcn",
          tokenThresholds: { handoff: 999, guard: 1498 },
          custom: true,
        },
      ],
    });

    const cfg = await mgr.ensureDefaultConfig();

    const glm = cfg.models.filter((m) => m.id === "glm-5.3");
    expect(glm.length).toBe(1);
    expect(glm[0].name).toBe("My GLM-5.3");
    expect(glm[0].tokenThresholds.handoff).toBe(999);
  });

  it("图片模型同步：未标 custom 的旧图片模型被替换", async () => {
    testDir = await tempDir();
    const mgr = makeManager(testDir);
    await mgr.write({
      endpoints: [],
      models: [],
      imageModels: [
        { id: "old-image-model", name: "Old", endpointId: "x", modelName: "old-image-model" },
      ],
      defaultImageModel: "old-image-model",
    });

    const cfg = await mgr.ensureDefaultConfig();

    expect(cfg.imageModels!.map((m) => m.id)).toEqual(
      DEFAULT_APP_CONFIG.imageModels!.map((m) => m.id),
    );
    expect(cfg.defaultImageModel).toBe(DEFAULT_APP_CONFIG.defaultImageModel);
  });

  it("模型同步：重复调用结果稳定（幂等）", async () => {
    testDir = await tempDir();
    const mgr = makeManager(testDir);

    const first = await mgr.ensureDefaultConfig();
    const second = await mgr.ensureDefaultConfig();

    expect(second).toEqual(first);
    expect(second.models.map((m) => m.id)).toEqual(DEFAULT_APP_CONFIG.models.map((m) => m.id));
  });
});

describe("ConfigManager.bootstrap", () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) await fs.rm(testDir, { recursive: true, force: true });
  });

  it("全新目录 → 创建 config + agent + subAgent + 所有子目录", async () => {
    testDir = await tempDir();
    const mgr = makeManager(testDir);

    const result = await mgr.bootstrap();

    // config
    await expect(fs.access(join(testDir, "config.json"))).resolves.toBeUndefined();

    // agent —— 必须带出厂 modelId（三级解析的第二级；出厂配置不写 defaultModel 兜底）
    expect(result.agent).not.toBeNull();
    expect(result.agent!.id).toBe("default");
    expect(result.agent!.modelId).toBe(DEFAULT_AGENT_DEFINITION.modelId);
    await expect(fs.access(join(testDir, "agents", "default.json"))).resolves.toBeUndefined();
    const agentOnDisk = JSON.parse(
      await fs.readFile(join(testDir, "agents", "default.json"), "utf-8"),
    );
    expect(agentOnDisk.modelId).toBe(DEFAULT_AGENT_DEFINITION.modelId);

    // subAgent
    expect(result.subAgent).not.toBeNull();
    expect(result.subAgent!.id).toBe(DEFAULT_SUBAGENT_ID);
    await expect(
      fs.access(join(testDir, "sub-agents", `${DEFAULT_SUBAGENT_ID}.json`)),
    ).resolves.toBeUndefined();

    // mcp.json — 默认释放含 socket-pty、chrome-devtools 的配置
    const mcp = JSON.parse(await fs.readFile(join(testDir, "mcp.json"), "utf-8"));
    expect(mcp.mcpServers["socket-pty"]).toBeTruthy();
    expect(mcp.mcpServers["socket-pty"].command).toBe("npx");
    expect(mcp.mcpServers["socket-pty"].args).toContain("@ai-zen/socket-pty");
    expect(mcp.mcpServers["chrome-devtools"]).toBeTruthy();
    expect(mcp.mcpServers["chrome-devtools"].command).toBe("npx");
    expect(
      mcp.mcpServers["chrome-devtools"].args.some((a: string) =>
        a.startsWith("chrome-devtools-mcp"),
      ),
    ).toBe(true);

    // dirs
    for (const sub of ["agents", "sub-agents", "skills", "tools", "mcp-oauth"]) {
      await expect(fs.access(join(testDir, sub))).resolves.toBeUndefined();
    }
  });

  it("幂等 — 第二次调用不覆盖已有文件", async () => {
    testDir = await tempDir();
    const mgr = makeManager(testDir);

    await mgr.bootstrap();

    // 修改 config
    await mgr.write({ ...DEFAULT_APP_CONFIG, defaultMigrationModel: "glm-5.3" });

    const result = await mgr.bootstrap();
    expect(result.config.defaultMigrationModel).toBe("glm-5.3");

    // 已有 mcp.json 不被覆盖
    const mcp = JSON.parse(await fs.readFile(join(testDir, "mcp.json"), "utf-8"));
    expect(mcp.mcpServers["socket-pty"]).toBeTruthy();
  });
});

describe("ConfigManager.ensureDefaultMcpConfig", () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) await fs.rm(testDir, { recursive: true, force: true });
  });

  /** 带恢复回调的管理器：恢复一次就往 `recovered` 里记一条路径 */
  function makeManagerWithCallback(basePath: string): {
    manager: ConfigManager;
    recovered: string[];
  } {
    const recovered: string[] = [];
    const manager = new ConfigManager(join(basePath, "config.json"), (path) => {
      recovered.push(path);
    });
    return { manager, recovered };
  }

  it("mcp.json 不存在 → 释放默认配置（含 socket-pty、chrome-devtools），不回调", async () => {
    testDir = await tempDir();
    const { manager, recovered } = makeManagerWithCallback(testDir);

    const cfg = await manager.ensureDefaultMcpConfig();

    expect(cfg.mcpServers).toBeTruthy();
    expect((cfg.mcpServers as Record<string, any>)["socket-pty"]).toBeTruthy();
    expect((cfg.mcpServers as Record<string, any>)["chrome-devtools"]).toBeTruthy();
    await expect(fs.access(join(testDir, "mcp.json"))).resolves.toBeUndefined();
    // 正常首启不是「恢复」，不该惊动通知
    expect(recovered).toEqual([]);
    await expect(fs.access(join(testDir, "mcp.json.broken"))).rejects.toThrow();
  });

  it("mcp.json 是合法对象 → 一个字节都不动，不回调", async () => {
    testDir = await tempDir();
    const { manager, recovered } = makeManagerWithCallback(testDir);
    // 用户自己的 InboxEntry + 这一版不认识的顶层键：都该原样留着
    const custom = {
      mcpServers: { "my-server": { type: "stdio", command: "my-cmd", env: { A: "1" } } },
      somethingUnknown: [1, 2, 3],
    };
    const original = JSON.stringify(custom, null, 2);
    await fs.writeFile(join(testDir, "mcp.json"), original, "utf-8");

    const cfg = await manager.ensureDefaultMcpConfig();

    expect((cfg.mcpServers as Record<string, any>)["my-server"]).toBeTruthy();
    expect((cfg.mcpServers as Record<string, any>)["socket-pty"]).toBeUndefined();
    expect(cfg.somethingUnknown).toEqual([1, 2, 3]);
    // 逐字节不变（用户的文件不被重排或美化）
    await expect(fs.readFile(join(testDir, "mcp.json"), "utf-8")).resolves.toBe(original);
    expect(recovered).toEqual([]);
    await expect(fs.access(join(testDir, "mcp.json.broken"))).rejects.toThrow();
  });

  const BROKEN: [string, string][] = [
    ["坏 JSON", "{ 这不是 JSON"],
    ["数组", JSON.stringify([{ id: "server-1" }])],
    ["null", "null"],
  ];

  for (const [name, content] of BROKEN) {
    it(`${name}：bootstrap 不抛；恢复出厂；残骸留档；回调一次`, async () => {
      testDir = await tempDir();
      await fs.writeFile(join(testDir, "mcp.json"), content, "utf-8");
      const { manager, recovered } = makeManagerWithCallback(testDir);

      // bootstrap 走的是同一条路：坏 mcp.json 不该让它抛出去
      await expect(manager.bootstrap()).resolves.toBeTruthy();

      // 磁盘上已经是合法的出厂配置：下次启动不用再恢复一次
      const onDisk = JSON.parse(await fs.readFile(join(testDir, "mcp.json"), "utf-8"));
      expect(onDisk).toEqual(JSON.parse(JSON.stringify(DEFAULT_MCP_CONFIG)));

      // 残骸是坏文件的原文
      await expect(fs.readFile(join(testDir, "mcp.json.broken"), "utf-8")).resolves.toBe(content);

      expect(recovered).toEqual([join(testDir, "mcp.json")]);
    });
  }

  it("上一份残骸还在 → 新的带时间戳，不覆盖老的那份", async () => {
    testDir = await tempDir();
    const broken = join(testDir, "mcp.json.broken");
    await fs.writeFile(broken, "上一份残骸", "utf-8");
    await fs.writeFile(join(testDir, "mcp.json"), "{ 又坏了", "utf-8");
    const { manager, recovered } = makeManagerWithCallback(testDir);

    await manager.ensureDefaultMcpConfig();

    // 老残骸原封不动
    await expect(fs.readFile(broken, "utf-8")).resolves.toBe("上一份残骸");
    const archived = (await fs.readdir(testDir)).filter((f) => f.startsWith("mcp.json.broken."));
    expect(archived).toHaveLength(1);
    await expect(fs.readFile(join(testDir, archived[0]!), "utf-8")).resolves.toBe("{ 又坏了");
    expect(recovered).toHaveLength(1);
  });

  it("恢复过一次之后，再读不再触发恢复", async () => {
    testDir = await tempDir();
    await fs.writeFile(join(testDir, "mcp.json"), "{ 坏掉了", "utf-8");
    const { manager, recovered } = makeManagerWithCallback(testDir);

    await manager.ensureDefaultMcpConfig();
    await manager.ensureDefaultMcpConfig();

    expect(recovered).toHaveLength(1);
  });
});
