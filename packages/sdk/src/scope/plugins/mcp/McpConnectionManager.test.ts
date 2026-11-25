import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpConnectionManager } from "./McpConnectionManager.js";
import { currentElicitationOwner, withElicitationOwner } from "./elicitation.js";
import type { McpServerDefinition } from "../../../types/index.js";

// 纯 mock 对象，不涉及 vi.mock
const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getServerCapabilities: vi.fn().mockReturnValue({
    tools: {},
    resources: {},
    prompts: {},
  }),
  listTools: vi.fn().mockResolvedValue({
    tools: [
      { name: "test-tool", description: "a tool", inputSchema: { type: "object", properties: {} } },
    ],
  }),
  listResources: vi.fn().mockResolvedValue({ resources: [] }),
  listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
  callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  // 建连之后要裹一层任务会话（`@modelcontextprotocol/ext-tasks`），它摸的是这四格
  request: vi.fn(),
  getProtocolEra: vi.fn().mockReturnValue("legacy"),
  // 技能扩展那一套（`SkillsClient`）读这两格：协商到的协议版本决定结果信封的形状，
  // `_walkPages` 是它翻页用的（真 `Client` 上有，替身得补一个）
  getNegotiatedProtocolVersion: vi.fn().mockReturnValue("2026-07-28"),
  // 服务器发回来的 `elicitation/create` 通过它注册处理器；用例把注册进来的那一个拿出来直接调
  setRequestHandler: vi.fn(),
  _walkPages: async (_method: string, fetchPage: (cursor?: string) => unknown) =>
    fetchPage(undefined),
  fallbackRequestHandler: undefined,
  fallbackNotificationHandler: undefined,
  onclose: undefined,
};

const mockTransport = {
  start: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(undefined),
};

const stdioConfig: McpServerDefinition = {
  id: "test-stdio",
  transport: "stdio",
  command: "node",
  args: ["server.js"],
};

const httpConfig: McpServerDefinition = {
  id: "test-http",
  transport: "http",
  url: "https://mcp.example.com",
};

describe("McpConnectionManager", () => {
  let manager: McpConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();

    // 通过自定义 transport 工厂 + 自定义 Client 工厂来注入 mock
    manager = new McpConnectionManager(
      // transportFactory
      () => mockTransport as any,
      // clientFactory
      // 每次建连给一份新的：任务会话在 client 外裹的那层适配器是独占的，同一个对象套两次会报
      () => ({ ...mockClient }) as any,
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockClient.connect.mockResolvedValue(undefined);
    mockClient.close.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({
      tools: [
        {
          name: "test-tool",
          description: "a tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    mockClient.listResources.mockResolvedValue({ resources: [] });
    mockClient.listPrompts.mockResolvedValue({ prompts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  // ---- 状态机 ----

  it("初始状态 disconnected", () => {
    expect(manager.getState("github")).toBe("disconnected");
  });

  it("connect → connected", async () => {
    const promise = manager.connect("github", stdioConfig);

    expect(manager.getState("github")).toBe("connecting");

    const manifest = await promise;
    expect(manager.getState("github")).toBe("connected");
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0].name).toBe("test-tool");
  });

  it("connect 失败 → error", async () => {
    mockClient.connect.mockRejectedValueOnce(new Error("connection refused"));

    await expect(manager.connect("github", stdioConfig)).rejects.toThrow("connection refused");
    expect(manager.getState("github")).toBe("error");
  });

  it("disconnect → disconnected", async () => {
    await manager.connect("github", stdioConfig);

    await manager.disconnect("github");
    expect(manager.getState("github")).toBe("disconnected");
  });

  it("重复 connect 已连接的 server 直接返回清单", async () => {
    await manager.connect("github", stdioConfig);

    const manifest = await manager.connect("github", stdioConfig);
    expect(manifest.tools).toHaveLength(1);
  });

  it("重复 connect 正在连接中的 server 复用同一 promise", async () => {
    const [r1, r2] = await Promise.all([
      manager.connect("github", stdioConfig),
      manager.connect("github", stdioConfig),
    ]);
    expect(r1).toBe(r2);
  });

  it("stdio 缺少 command 时抛出错误", async () => {
    // 使用默认构造（无 factory）来测试校验逻辑，因为 mock 工厂会绕过校验
    const rawManager = new McpConnectionManager();
    const badConfig: McpServerDefinition = { id: "bad", transport: "stdio" };
    await expect(rawManager.connect("bad", badConfig)).rejects.toThrow("missing command");
  });

  it("http 缺少 url 时抛出错误", async () => {
    const rawManager = new McpConnectionManager();
    const badConfig: McpServerDefinition = { id: "bad", transport: "http" };
    await expect(rawManager.connect("bad", badConfig)).rejects.toThrow("missing url");
  });

  it("sse 缺少 url 时抛出错误", async () => {
    const rawManager = new McpConnectionManager();
    const badConfig: McpServerDefinition = { id: "bad", transport: "sse" };
    await expect(rawManager.connect("bad", badConfig)).rejects.toThrow("missing url");
  });

  it("不支持的 transport 类型时抛出错误", async () => {
    const rawManager = new McpConnectionManager();
    const badConfig = { transport: "websocket" } as any;
    await expect(rawManager.connect("bad", badConfig)).rejects.toThrow("Unsupported MCP transport");
  });

  // ---- 获取 Client ----

  it("getClient 返回已连接的 Client", async () => {
    await manager.connect("github", stdioConfig);
    const client = manager.getClient("github");
    expect(client).toBeDefined();
  });

  it("getClient 返回未连接 server 的 undefined", () => {
    expect(manager.getClient("nonexistent")).toBeUndefined();
  });

  // ---- 空闲超时 ----

  it("空闲超时后自动断开", async () => {
    await manager.connect("github", stdioConfig, { idleTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(manager.getState("github")).toBe("disconnected");
  });

  it("活跃操作重置超时计时器", async () => {
    await manager.connect("github", stdioConfig, { idleTimeoutMs: 1000 });

    await vi.advanceTimersByTimeAsync(500);
    manager.touch("github");

    await vi.advanceTimersByTimeAsync(800);
    expect(manager.getState("github")).toBe("connected");

    await vi.advanceTimersByTimeAsync(400);
    expect(manager.getState("github")).toBe("disconnected");
  });

  // ---- 错误状态恢复 ----

  it("connect 错误状态后可以重试 connect", async () => {
    mockClient.connect.mockRejectedValueOnce(new Error("fail"));

    await expect(manager.connect("github", stdioConfig)).rejects.toThrow();
    expect(manager.getState("github")).toBe("error");

    mockClient.connect.mockResolvedValueOnce(undefined);
    await manager.connect("github", stdioConfig);
    expect(manager.getState("github")).toBe("connected");
  });

  // ---- 断开未连接的 server ----

  it("disconnect 未连接的 server 无操作", async () => {
    await expect(manager.disconnect("nonexistent")).resolves.toBeUndefined();
  });

  // ---- disconnectAll ----

  it("disconnectAll 断开所有连接", async () => {
    await manager.connect("github", stdioConfig);
    await manager.connect("slack", httpConfig);

    await manager.disconnectAll();
    expect(manager.getState("github")).toBe("disconnected");
    expect(manager.getState("slack")).toBe("disconnected");
  });

  // ---- 多 server 独立管理 ----

  it("多个 server 状态独立", async () => {
    await manager.connect("github", stdioConfig);
    expect(manager.getState("github")).toBe("connected");
    expect(manager.getState("slack")).toBe("disconnected");

    await manager.connect("slack", {
      id: "slack",
      transport: "http",
      url: "https://slack.example.com",
    });
    expect(manager.getState("github")).toBe("connected");
    expect(manager.getState("slack")).toBe("connected");

    await manager.disconnect("github");
    expect(manager.getState("github")).toBe("disconnected");
    expect(manager.getState("slack")).toBe("connected");
  });

  // ---- 建连失败 ----

  it("建连失败：原错误原样抛出，且只尝试一次（没有重试环）", async () => {
    const boom = new Error("transient");
    mockClient.connect.mockRejectedValueOnce(boom);

    await expect(manager.connect("github", stdioConfig)).rejects.toBe(boom);
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
    expect(manager.getState("github")).toBe("error");
  });
});

describe("生命周期边界（启动即退出 / 断线 / 建连超时）", () => {
  it("建连过程中 disconnect()：连接不复活，资源被关闭", async () => {
    let releaseConnect!: () => void;
    mockClient.connect.mockImplementation(
      () => new Promise<void>((resolve) => (releaseConnect = resolve)),
    );

    const manager = new McpConnectionManager(
      () => mockTransport as any,
      () => ({ ...mockClient }) as any,
    );

    const connecting = manager.connect("srv", stdioConfig);
    // 建连进行中（客户端 connect 还没返回）就断开一次
    await manager.disconnect("srv");
    releaseConnect();

    await expect(connecting).rejects.toThrow(/cancelled/);
    expect(manager.getState("srv")).toBe("disconnected");
    // 半成品资源必须被关掉，否则 stdio 子进程留成孤儿
    expect(mockClient.close).toHaveBeenCalled();
    expect(mockTransport.close).toHaveBeenCalled();
  });

  it("运行期 transport 关闭时状态标回 disconnected（不做自动重连）", async () => {
    mockClient.connect.mockResolvedValue(undefined);
    const manager = new McpConnectionManager(
      () => mockTransport as any,
      () => ({ ...mockClient }) as any,
    );

    await manager.connect("srv", stdioConfig);
    expect(manager.getState("srv")).toBe("connected");

    // 模拟底层 SSE / stdio 流断开
    (mockTransport as any).onclose?.();

    expect(manager.getState("srv")).toBe("disconnected");
    expect(manager.getClient("srv")).toBeUndefined();
  });

  it("建连超时会断开并抛错，不会永久挂起", async () => {
    // connect 永不返回
    mockClient.connect.mockImplementation(() => new Promise<void>(() => {}));

    const manager = new McpConnectionManager(
      () => mockTransport as any,
      () => ({ ...mockClient }) as any,
    );

    await expect(manager.connect("srv", httpConfig, { connectTimeoutMs: 50 })).rejects.toThrow(
      /timed out after 50ms/,
    );
    expect(manager.getState("srv")).toBe("disconnected");
  });

  it("transport error 回调会被接管，不影响既有处理", async () => {
    mockClient.connect.mockResolvedValue(undefined);
    const prevOnError = vi.fn();
    (mockTransport as any).onerror = prevOnError;

    const manager = new McpConnectionManager(
      () => mockTransport as any,
      () => ({ ...mockClient }) as any,
    );
    await manager.connect("srv", stdioConfig);

    (mockTransport as any).onerror?.(new Error("boom"));
    expect(prevOnError).toHaveBeenCalled();

    delete (mockTransport as any).onclose;
    delete (mockTransport as any).onerror;
  });
});

/**
 * 技能（MCP Skills 扩展）：服务端声明了那个扩展才有得问，没声明就一个请求都不发。
 *
 * 条目原样带出来 —— 技能内容仍走 `resources/read`，所以要一并给出附属文件的 uri。
 */
describe("McpConnectionManager：技能清单", () => {
  const DIGEST = `sha256:${"a".repeat(64)}`;

  function newManager() {
    return new McpConnectionManager(
      () => mockTransport as any,
      () => ({ ...mockClient }) as any,
    );
  }

  it("声明了扩展：清单里带上技能（uri + frontmatter + 文件清单）", async () => {
    vi.clearAllMocks();
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.getServerCapabilities.mockReturnValue({
      tools: {},
      resources: {},
      extensions: { "io.modelcontextprotocol/skills": {} },
    });
    mockClient.listTools.mockResolvedValue({ tools: [] });
    mockClient.listResources.mockResolvedValue({ resources: [] });
    mockClient.request.mockResolvedValue({
      resultType: "complete",
      skills: [
        {
          uri: "skill://code-review/SKILL.md",
          frontmatter: { name: "code-review", description: "Review code using the checklist." },
          resources: [
            { uri: "skill://code-review/SKILL.md", digest: DIGEST, size: 12 },
            { uri: "skill://code-review/references/checklist.md", digest: DIGEST, size: 7 },
          ],
        },
      ],
      ttlMs: 300000,
      cacheScope: "public",
    });

    const manifest = await newManager().connect("github", stdioConfig);

    expect(manifest.skills).toEqual([
      {
        uri: "skill://code-review/SKILL.md",
        frontmatter: { name: "code-review", description: "Review code using the checklist." },
        resources: [
          { uri: "skill://code-review/SKILL.md", digest: DIGEST, size: 12 },
          { uri: "skill://code-review/references/checklist.md", digest: DIGEST, size: 7 },
        ],
      },
    ]);
    // 真发了那次请求（第三个入参是选项，缺省时是 `undefined`，所以只看第一个入参的形状）
    expect(mockClient.request.mock.calls.map((call) => (call[0] as any).method)).toContain(
      "skills/list",
    );
  });

  it("没声明扩展：一个 skills/list 都不发，清单里是空数组", async () => {
    vi.clearAllMocks();
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.getServerCapabilities.mockReturnValue({ tools: {}, resources: {} });
    mockClient.listTools.mockResolvedValue({ tools: [] });
    mockClient.listResources.mockResolvedValue({ resources: [] });

    const manifest = await newManager().connect("github", stdioConfig);

    expect(manifest.skills).toEqual([]);
    expect(mockClient.request.mock.calls.map((call) => (call[0] as any).method)).not.toContain(
      "skills/list",
    );
  });
});

/**
 * MCP elicitation：服务器在工具调用中途要问用户一张表。
 *
 * 「这次调用属于哪段会话」不在载荷里，得靠 `call_mcp_tool` 在发请求之前压进那本账
 * （`elicitation.ts`）。这一组把注册进来的处理器拿出来直接调，钉住四件事：
 * 有账就问、没账回 decline、url 那档回 decline、出题自己炸了回 cancel。
 */
describe("McpConnectionManager：elicitation", () => {
  /** 建连之后把注册进来的那个处理器拿出来 */
  async function handlerOf(manager: McpConnectionManager) {
    await manager.connect("github", stdioConfig);
    const call = mockClient.setRequestHandler.mock.calls.find(
      (entry) => entry[0] === "elicitation/create",
    );
    expect(call).toBeDefined();
    return call![1] as (request: unknown) => Promise<{ action: string; content?: unknown }>;
  }

  const formRequest = {
    method: "elicitation/create",
    params: {
      message: "要花 2 块钱，继续吗？",
      requestedSchema: {
        type: "object",
        properties: { ok: { type: "string", enum: ["yes", "no"] } },
        required: ["ok"],
      },
    },
  };

  function newManager() {
    return new McpConnectionManager(
      () => mockTransport as any,
      () => ({ ...mockClient }) as any,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.getServerCapabilities.mockReturnValue({ tools: {}, resources: {} });
    mockClient.listTools.mockResolvedValue({ tools: [] });
    mockClient.listResources.mockResolvedValue({ resources: [] });
  });

  it("没有人在飞（一次性 Agent / 没有题板）：回 decline", async () => {
    const manager = newManager();
    const handler = await handlerOf(manager);

    await expect(handler(formRequest)).resolves.toEqual({ action: "decline" });
  });

  it("有账：把表交给那一段会话，答复原样收回给服务器", async () => {
    const manager = newManager();
    const handler = await handlerOf(manager);
    const asked: unknown[] = [];

    // 账压在这台服务器的客户端上（真路径由 `call_mcp_tool` 压，这里手动压以隔离这一层）
    const client = manager.getClient("github")!;
    const answer = await withElicitationOwner(
      client,
      {
        sessionId: "sess-1",
        ask: async (request) => {
          asked.push(request);
          return { action: "accept", content: { ok: "yes" } };
        },
      },
      () => handler(formRequest),
    );

    expect(answer).toEqual({ action: "accept", content: { ok: "yes" } });
    expect(asked).toEqual([
      {
        message: "要花 2 块钱，继续吗？",
        requestedSchema: formRequest.params.requestedSchema,
      },
    ]);
  });

  it("用户拒了：交 decline；用户关掉：交 cancel（三态原样给服务器）", async () => {
    const manager = newManager();
    const handler = await handlerOf(manager);
    const client = manager.getClient("github")!;

    const declined = await withElicitationOwner(
      client,
      { sessionId: "sess-1", ask: async () => ({ action: "decline" }) },
      () => handler(formRequest),
    );
    expect(declined).toEqual({ action: "decline" });

    const cancelled = await withElicitationOwner(
      client,
      { sessionId: "sess-1", ask: async () => ({ action: "cancel" }) },
      () => handler(formRequest),
    );
    expect(cancelled).toEqual({ action: "cancel" });
  });

  it("没人答它了（会话没了）：回 decline，不是挂在那里", async () => {
    const manager = newManager();
    const handler = await handlerOf(manager);
    const client = manager.getClient("github")!;

    const answer = await withElicitationOwner(
      client,
      { sessionId: "sess-1", ask: async () => undefined },
      () => handler(formRequest),
    );
    expect(answer).toEqual({ action: "decline" });
  });

  it("url 那一档我们没声明：收到就回 decline", async () => {
    const manager = newManager();
    const handler = await handlerOf(manager);
    const client = manager.getClient("github")!;

    const answer = await withElicitationOwner(
      client,
      { sessionId: "sess-1", ask: async () => ({ action: "accept" }) },
      () =>
        handler({
          method: "elicitation/create",
          params: { mode: "url", message: "去这个页面填密钥", url: "https://x.dev" },
        }),
    );
    expect(answer).toEqual({ action: "decline" });
  });
});

/**
 * 那本账本身（`elicitation.ts`）：压栈、弹栈、嵌套、没有账。
 *
 * 为什么单独钉：它是「题挂在哪一段会话」唯一的依据，压漏一次就串到别段去了。
 */
describe("elicitation 记账", () => {
  it("压进去才看得到，出来就没了（嵌套时只弹自己那一格）", async () => {
    const client = {};
    const outer = { sessionId: "s-outer", ask: async () => undefined };
    const inner = { sessionId: "s-inner", ask: async () => undefined };
    expect(currentElicitationOwner(client)).toBeUndefined();

    await withElicitationOwner(client, outer, async () => {
      expect(currentElicitationOwner(client)).toBe(outer);
      await withElicitationOwner(client, inner, async () => {
        expect(currentElicitationOwner(client)).toBe(inner);
      });
      // 内层弹掉之后外层还在
      expect(currentElicitationOwner(client)).toBe(outer);
    });

    expect(currentElicitationOwner(client)).toBeUndefined();
  });

  it("客户端或通道缺一个就直接跑（不记账、也不报错）", async () => {
    const client = {};
    await expect(withElicitationOwner(client, undefined, async () => 1)).resolves.toBe(1);
    await expect(
      withElicitationOwner(
        undefined,
        { sessionId: "s", ask: async () => undefined },
        async () => 2,
      ),
    ).resolves.toBe(2);
    expect(currentElicitationOwner(client)).toBeUndefined();
  });
});
