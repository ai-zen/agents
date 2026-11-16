import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentError, Agent, CallbackTool } from "@ai-zen/agents-core";
import { HandoffAbortedError, HandoffService } from "./HandoffService.js";
import { HandoffGuardPlugin } from "./HandoffGuardPlugin.js";
import { FALLBACK_HANDOFF_TEMPLATE } from "../config/factory-skills.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const SKILL_CONTENT = [
  "---",
  "name: handoff",
  "description: Test handoff skill",
  "---",
  "",
  "# Test handoff standards",
  "",
  "## 💬 Conversation Breakpoint",
  "## 🔔 First Step for the Next Agent",
].join("\n");

/** 生成足够大的交接文档正文（默认超过 400 字节阈值） */
function docContent(padding = 600): string {
  return `## 💬 Conversation Breakpoint\nBreakpoint content from the previous round\n## 🔔 First Step for the Next Agent\n- run npm test\n${"x".repeat(padding)}`;
}

interface FakeAgentOptions {
  /** 每次投递时的行为（默认什么都不做） */
  onSend?: (content: string, call: number, agent: FakeAgent) => void | Promise<void>;
  /** 是否具备 write 工具（默认有） */
  writeTool?: boolean;
  messages?: any[];
  definitionMessages?: any[];
}

type Listener = (payload: any) => void;

/**
 * 假 agent：只实现 `HandoffService` 用到的表面。
 *
 * 新 core 里**没有 `send()`** 了（`CORE.md` §1）：自交接那一轮靠「`push` 一条指令 + 等闲」
 * 实现。所以这个替身要模拟的就是那条路的三个可观测点：
 *   - `start()`：幂等，返回一句「到死才 resolve」的 promise；
 *   - `push(entry)`：落一条 user 消息 → 变忙 → （跑 `onSend`）→ 追加回执 → 变闲；
 *   - `on("state" | "stopped" | "killed")`：订阅，返回取消函数。
 *
 * `state` 的转移必须走 `setState`（同值不发），否则订阅方会被同一次转移喂两次。
 */
class FakeAgent {
  messages: any[];
  definition: { messages: any[] };
  tools: any[];
  model = "fake-model";
  modelConfig: Record<string, unknown> = {};
  lastUsage: any = { prompt_tokens: 999 };
  scope = { cwd: process.cwd() };
  /** 投进来的指令正文（等价于旧 `send()` 收到的内容） */
  sent: string[] = [];
  plugins: any[] = [];
  client: any;
  /** 常驻会话：自交接要求 agent 能「再问一轮」 */
  lifetime = "resident";
  state: "busy" | "idle" | "paused" = "idle";

  private listeners = new Map<string, Set<Listener>>();
  private closed = false;
  private death?: Promise<void>;
  private resolveDeath?: () => void;

  constructor(public options: FakeAgentOptions = {}) {
    this.messages = options.messages ?? [
      { role: "system", content: "You are a helper." },
      { role: "user", content: "help me do task A" },
      { role: "assistant", content: "ok, started" },
    ];
    this.definition = { messages: options.definitionMessages ?? [this.messages[0]] };
    this.tools =
      options.writeTool === false
        ? []
        : [
            { type: "function", function: { name: "write", parameters: {} } },
            { type: "function", function: { name: "read", parameters: {} } },
          ];
    this.client = {
      chat: {
        completions: {
          // 形参与真实的 `create(body, options)` 同形：第二个参数是 RequestOptions，
          // 取消信号就靠它递下去
          create: vi.fn(async (_body?: unknown, _options?: { signal?: AbortSignal }) => ({
            choices: [{ message: { content: docContent() } }],
          })),
        },
      },
    };
  }

  use(plugin: any): void {
    this.plugins.push(plugin);
  }

  // ---- 事件（core 的 `on()` 返回取消函数） ----

  on(type: string, handler: Listener): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  private emit(type: string, payload: any): void {
    for (const handler of this.listeners.get(type) ?? []) handler(payload);
  }

  private setState(next: "busy" | "idle" | "paused"): void {
    const from = this.state;
    if (from === next) return;
    this.state = next;
    this.emit("state", { agent: this, from, to: next });
  }

  // ---- 死活 ----

  start(): Promise<void> {
    this.death ??= new Promise<void>((resolve) => (this.resolveDeath = resolve));
    return this.death;
  }

  stop(): void {
    this.closed = true;
    this.emit("stopped", { agent: this });
    this.resolveDeath?.();
  }

  kill(): void {
    this.closed = true;
    this.emit("killed", { agent: this });
    this.resolveDeath?.();
  }

  // ---- 投递 ----

  push(entry: any): void {
    if (this.closed) {
      throw new AgentError("closed", "往已经关了的 agent 投递");
    }
    const content = entry.content as string;
    this.sent.push(content);
    // 真 core：一批开头先落 user 消息，再发请求
    this.messages.push({ role: "user", content, source: entry.source });
    this.setState("busy");

    const finish = () => {
      // 模拟 core：追加 assistant 回执，然后回到「闲」
      this.messages.push({ role: "assistant", content: "Handoff document written." });
      this.setState("idle");
    };
    const result = this.options.onSend?.(content, this.sent.length, this);
    if (result instanceof Promise) void result.then(finish);
    else finish();
  }
}

/** 临时交接目录（每例独立，避免相互污染） */
async function makeDir(): Promise<string> {
  return await fs.mkdtemp(join(tmpdir(), "aizen-handoff-"));
}

/** 把 FakeAgent 当作 SdkAgent 传入服务 */
const asAgent = (agent: FakeAgent) => agent as any;

const dirs: string[] = [];

async function makeService(
  options: Partial<ConstructorParameters<typeof HandoffService>[0]> = {},
): Promise<{ service: HandoffService; dir: string }> {
  const dir = await makeDir();
  dirs.push(dir);
  const service = new HandoffService({ handoffDir: dir, ...options });
  return { service, dir };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 静态纯工具
// ---------------------------------------------------------------------------

describe("HandoffService 静态工具", () => {
  it("createHandoffFileName 只用到秒的时间戳（无会话 id 后缀）", () => {
    const name = HandoffService.createHandoffFileName(new Date(2026, 0, 2, 3, 4, 5));
    expect(name).toBe("20260102-030405.md");
  });

  it("createHandoffInstruction 串联 Skill 正文与参数（含路径与工具能力）", () => {
    const prompt = HandoffService.createHandoffInstruction({
      skillContent: SKILL_CONTENT,
      handoffPath: "/tmp/handoffs/a.md",
      toolsAvailable: true,
    });

    expect(prompt).toContain("# Test handoff standards");
    expect(prompt).toContain("## Handoff parameters");
    expect(prompt).toContain("/tmp/handoffs/a.md");
    expect(prompt).toContain("Tools available: yes");
    expect(prompt).toContain("write tool");
    expect(prompt).toContain("do not restate the document content");
  });

  it("createHandoffInstruction 无工具时要求直接输出正文并禁止推测", () => {
    const prompt = HandoffService.createHandoffInstruction({
      skillContent: SKILL_CONTENT,
      handoffPath: "/tmp/handoffs/a.md",
      toolsAvailable: false,
    });

    expect(prompt).toContain("Tools available: no");
    expect(prompt).toContain("⚠️ Unverified");
    expect(prompt).toContain("Output the complete document body directly");
    expect(prompt).not.toContain("write tool");
  });

  it("createPostMessages 只给路径并要求先 read", () => {
    const messages = HandoffService.createPostMessages("/tmp/handoffs/x.md");

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("/tmp/handoffs/x.md");
    expect(messages[0].content).toContain("read");
    // 不再内联全文
    expect(messages[0].content).not.toContain("## 💬 Conversation Breakpoint");
  });

  it("serializeMessages 序列化为 [role]: content", () => {
    expect(
      HandoffService.serializeMessages([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ] as any),
    ).toBe("[user]: hello\n\n[assistant]: hi");
  });
});

// ---------------------------------------------------------------------------
// handoff：只产出文档
// ---------------------------------------------------------------------------

describe("handoff", () => {
  it("self 模式：原 agent 在自己会话里写文档，会话不切换", async () => {
    const { service, dir } = await makeService();
    const agent = new FakeAgent({
      onSend: async (_content, _call, self) => {
        // 模拟 agent 用 write 工具落盘
        const [userMsg] = self.sent;
        const path = userMsg.match(/Handoff document absolute path: (.+)/)![1].trim();
        await fs.writeFile(path, docContent(), "utf-8");
      },
    });

    const ctx = await service.handoff({ agent: asAgent(agent) });

    expect(ctx.mode).toBe("self");
    expect(ctx.requestedMode).toBe("self");
    expect(existsSync(ctx.handoffPath)).toBe(true);
    expect(ctx.handoffPath.startsWith(dir)).toBe(true);
    // self 模式不读盘 → handoffDoc 为空
    expect(ctx.handoffDoc).toBeUndefined();
    // 会话未切换：历史仍在，且多出交接回合
    expect(ctx.messageCountBefore).toBe(3);
    expect(agent.messages.length).toBe(3 + 2);
    expect(agent.sent).toHaveLength(1);
  });

  it("self 模式：注入给 agent 的指令含 Skill 正文（而非代码内固定章节）", async () => {
    // 也要登记：`makeDir()` 造的就该由 `dirs` 统一收，漏一个就是一个跑不掉的 /tmp 目录
    const missingSkillDir = await makeDir();
    dirs.push(missingSkillDir);
    const { service } = await makeService({
      skillDirs: [join(missingSkillDir, "nope")], // 不存在 → 走兜底
    });
    const agent = new FakeAgent({
      onSend: async (_c, _n, self) => {
        const path = self.sent[0].match(/Handoff document absolute path: (.+)/)![1].trim();
        await fs.writeFile(path, docContent(), "utf-8");
      },
    });

    await service.handoff({ agent: asAgent(agent) });

    // 读不到 Skill → 兜底模板（保险丝）
    expect(agent.sent[0]).toContain(FALLBACK_HANDOFF_TEMPLATE.split("\n")[0]);
    expect(agent.sent[0]).toContain("## 🔔 First Step for the Next Agent");
  });

  it("self 模式：读得到 Skill 时使用 Skill 正文", async () => {
    const skillRoot = await makeDir();
    dirs.push(skillRoot);
    await fs.mkdir(join(skillRoot, "handoff"), { recursive: true });
    await fs.writeFile(join(skillRoot, "handoff", "SKILL.md"), SKILL_CONTENT, "utf-8");

    const { service } = await makeService({ skillDirs: [skillRoot] });
    const agent = new FakeAgent({
      onSend: async (_c, _n, self) => {
        const path = self.sent[0].match(/Handoff document absolute path: (.+)/)![1].trim();
        await fs.writeFile(path, docContent(), "utf-8");
      },
    });

    await service.handoff({ agent: asAgent(agent) });

    expect(agent.sent[0]).toContain("# Test handoff standards");
    expect(agent.sent[0]).not.toContain(FALLBACK_HANDOFF_TEMPLATE.split("\n")[0] + "\n");
  });

  it("self 模式：文件未落盘时重试一次，第二次成功即采用", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent({
      onSend: async (content, call, self) => {
        if (call !== 2) return; // 第一次什么都不写
        const path = content.match(/(\/\S+\.md)/)![1];
        await fs.writeFile(path, docContent(), "utf-8");
      },
    });

    const ctx = await service.handoff({ agent: asAgent(agent) });

    expect(agent.sent).toHaveLength(2);
    expect(ctx.mode).toBe("self");
    expect(existsSync(ctx.handoffPath)).toBe(true);
  });

  it("self 模式：两次都写得过小 → 单向降级 summary（阈值 400 字节）", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent({
      onSend: async (_c, _n, self) => {
        const path = self.sent[0].match(/Handoff document absolute path: (.+)/)![1].trim();
        await fs.writeFile(path, "too short", "utf-8");
      },
    });

    const ctx = await service.handoff({ agent: asAgent(agent) });

    expect(agent.sent).toHaveLength(2); // 原回合 + 1 次重试
    expect(ctx.requestedMode).toBe("self");
    expect(ctx.mode).toBe("summary");
    // summary 由服务调用模型并落盘
    expect(agent.client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(ctx.handoffDoc).toContain("## 💬 Conversation Breakpoint");
    const written = await fs.readFile(ctx.handoffPath, "utf-8");
    expect(written).toBe(ctx.handoffDoc);
  });

  it("agent 无 write 工具时直接走 summary", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent({ writeTool: false });

    const ctx = await service.handoff({ agent: asAgent(agent) });

    expect(agent.sent).toHaveLength(0);
    expect(ctx.mode).toBe("summary");
    expect(existsSync(ctx.handoffPath)).toBe(true);
  });

  it("交接回合不改写 lastUsage（护栏让行由 isSuspended 负责）", async () => {
    const { service } = await makeService();
    let usageAtSend: unknown = "not executed";
    const agent = new FakeAgent({
      onSend: async (_c, _n, self) => {
        usageAtSend = self.lastUsage;
        const path = self.sent[0].match(/Handoff document absolute path: (.+)/)![1].trim();
        await fs.writeFile(path, docContent(), "utf-8");
      },
    });

    await service.handoff({ agent: asAgent(agent) });

    // lastUsage 是从 messages 派生的只读值，交接不再去动它
    expect(usageAtSend).toEqual({ prompt_tokens: 999 });
  });

  it("交接回合期间守卫 armed，结束后 disarm", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent({
      onSend: async (_c, _n, self) => {
        const guard = self.plugins.find((p) => p instanceof HandoffGuardPlugin);
        expect(guard?.armed).toBe(true);
        const path = self.sent[0].match(/Handoff document absolute path: (.+)/)![1].trim();
        await fs.writeFile(path, docContent(), "utf-8");
      },
    });

    await service.handoff({ agent: asAgent(agent) });

    const guard = agent.plugins.find((p) => p instanceof HandoffGuardPlugin)!;
    expect(guard.armed).toBe(false);
    // 同一 agent 反复交接不重复注册守卫
    await service.handoff({ agent: asAgent(agent) });
    expect(agent.plugins.filter((p) => p instanceof HandoffGuardPlugin)).toHaveLength(1);
  });

  it("agent 已经关门时不投递、不做 summary，直接把 closed 往上抛", async () => {
    // `push` 在关门之后抛 `AgentError("closed")`（CORE.md §1）。那不是「文档没写出来」，
    // 而是「这个会话已经不在了」—— 降级 summary 会为一个死掉的会话白烧一轮全量输入。
    const { service } = await makeService();
    const agent = new FakeAgent();
    agent.stop();

    await expect(service.handoff({ agent: asAgent(agent) })).rejects.toBeInstanceOf(AgentError);
    expect(agent.sent).toHaveLength(0);
    expect(agent.client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("agent 处于暂停时不投递（暂停不取件），直接降级 summary", async () => {
    // 暂停中 `push` 只会排队，等 resume 之后突然自己跑起来 —— 那是「用户按了暂停却看见
    // 它又开口」。所以这一轮当没跑成，走逃生模式（summary 不经过 agent）。
    const { service } = await makeService();
    const agent = new FakeAgent();
    agent.state = "paused";

    const ctx = await service.handoff({ agent: asAgent(agent) });

    expect(agent.sent).toHaveLength(0);
    expect(ctx.mode).toBe("summary");
    expect(existsSync(ctx.handoffPath)).toBe(true);
  });

  it("summary 模型不返回内容时抛错", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent({ writeTool: false });
    agent.client.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: null } }],
    });

    await expect(service.handoff({ agent: asAgent(agent) })).rejects.toThrow(
      "Failed to generate the handoff document",
    );
  });

  it("进行中再次调用被拒（防重入）", async () => {
    const { service } = await makeService();
    let nested: Promise<unknown> | undefined;
    const agent = new FakeAgent({
      onSend: async () => {
        nested = service.handoff({ agent: asAgent(agent) });
        await nested.catch(() => {});
      },
    });

    const ctx = await service.handoff({ agent: asAgent(agent) });

    expect(ctx.mode).toBe("summary"); // 因为文件没写出来 → 降级
    await expect(nested).rejects.toThrow("A handoff is already in progress");
  });

  it("handoff 时 migrating 为 false（不改动会话语义）", async () => {
    let migrating: unknown;
    const { service } = await makeService({
      onHandoff: (ctx) => {
        migrating = ctx.migrating;
      },
    });
    const agent = new FakeAgent({
      onSend: async (_c, _n, self) => {
        const path = self.sent[0].match(/Handoff document absolute path: (.+)/)![1].trim();
        await fs.writeFile(path, docContent(), "utf-8");
      },
    });

    await service.handoff({ agent: asAgent(agent) });

    expect(migrating).toBe(false);
  });

  it("busy 在流程结束后复位", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent({
      onSend: async (_c, _n, self) => {
        const path = self.sent[0].match(/Handoff document absolute path: (.+)/)![1].trim();
        await fs.writeFile(path, docContent(), "utf-8");
      },
    });

    expect(service.busy).toBe(false);
    const pending = service.handoff({ agent: asAgent(agent) });
    expect(service.busy).toBe(true);
    await pending;
    expect(service.busy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// self 模式：真 core 跑一轮
// ---------------------------------------------------------------------------

/**
 * 这一组不接假 agent：`push` + 等闲这条新路完全依赖 core 的真实状态转移
 * （`push` 同步变忙 → 一圈跑完变闲），假件把它演得太随意就验不出任何东西。
 */
describe("self 模式：真 core（push + 等闲，没有 send()）", () => {
  /**
   * 造一个客户端：流式请求（会话那一轮）回「模型要求调 write」+ 收尾文本，
   * 非流式请求（`summary` 目录那一次 `completeOnce`）直接回一篇完整文档。
   */
  function makeStreams(handoffPathOf: (body: any) => string) {
    let round = 0;
    const create = vi.fn(async (body: any) => {
      // 非流式 = summary 那条路（`completeOnce` 不带 stream）
      if (body.stream !== true) {
        return { choices: [{ message: { content: docContent() } }] };
      }
      round++;
      const chunks =
        round === 1
          ? [
              {
                id: "c1",
                object: "chat.completion.chunk",
                created: 0,
                model: "m",
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call-1",
                          type: "function",
                          function: {
                            name: "write",
                            arguments: JSON.stringify({
                              path: handoffPathOf(body),
                              content: docContent(),
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                id: "c2",
                object: "chat.completion.chunk",
                created: 0,
                model: "m",
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              },
            ]
          : [
              {
                id: "c3",
                object: "chat.completion.chunk",
                created: 0,
                model: "m",
                choices: [{ index: 0, delta: { content: "written" }, finish_reason: null }],
              },
              {
                id: "c4",
                object: "chat.completion.chunk",
                created: 0,
                model: "m",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              },
            ];
      return {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk;
        },
      };
    });
    return { client: { chat: { completions: { create } } } as any, create };
  }

  it("把指令投进去、等这一轮收完、再校验落盘（模式仍是 self）", async () => {
    const { service } = await makeService();
    const writeTool = new CallbackTool({
      function: {
        name: "write",
        description: "写文件",
        parameters: { type: "object", properties: {}, required: [] },
      },
      callback: async (args: any) => {
        await fs.writeFile(args.path, args.content, "utf-8");
        return "ok";
      },
    });

    // 指令正文里带了交接文档的绝对路径（`createHandoffInstruction` 拼的），模型照它写
    const { client } = makeStreams((body) =>
      /Handoff document absolute path: (.+)/.exec(String(body.messages.at(-1).content))![1]!.trim(),
    );
    const agent = new Agent({ client, model: "m", tools: [writeTool] });

    const ctx = await service.handoff({ agent: agent as any });

    expect(ctx.mode).toBe("self");
    expect(existsSync(ctx.handoffPath)).toBe(true);
    // 交接回合真的落在了这个会话里（一条指令 + 两条 assistant + 一条 tool 结果）
    expect(agent.messages.length).toBeGreaterThan(1);
    expect(agent.messages.some((m) => m.role === "tool")).toBe(true);

    agent.kill();
  });

  it("模型不写文档时重试一次，两次都空则降级 summary（真 core 也一样）", async () => {
    const { service } = await makeService();
    const { client } = makeStreams(() => "/nonexistent/path.md");
    // write 工具存在（否则自交接不可用），但模型调的是一个不写盘的方向：这里让它每次都失败
    const writeTool = new CallbackTool({
      function: {
        name: "write",
        description: "写文件",
        parameters: { type: "object", properties: {}, required: [] },
      },
      callback: async () => {
        throw new Error("nope");
      },
    });
    const agent = new Agent({ client, model: "m", tools: [writeTool] });

    const ctx = await service.handoff({ agent: agent as any });

    expect(ctx.mode).toBe("summary");
    expect(existsSync(ctx.handoffPath)).toBe(true);

    agent.kill();
  });
});

// ---------------------------------------------------------------------------
// migrate：交接 + 开新会话
// ---------------------------------------------------------------------------

describe("migrate", () => {
  function selfAgent(): FakeAgent {
    return new FakeAgent({
      onSend: async (_c, _n, self) => {
        const path = self.sent[0].match(/Handoff document absolute path: (.+)/)![1].trim();
        await fs.writeFile(path, docContent(), "utf-8");
      },
    });
  }

  it("prune：物理剔除历史，只留模板 + 交接断点", async () => {
    const { service } = await makeService({ strategy: "prune" });
    const agent = selfAgent();

    const ctx = await service.migrate({ agent: asAgent(agent) });

    expect(agent.messages).toHaveLength(2); // definition.messages(1) + 断点(1)
    const breakpoint = agent.messages.at(-1)!;
    expect(breakpoint.role).toBe("user");
    expect(breakpoint.content).toContain(ctx.handoffPath);
    expect(breakpoint.content).toContain("read");
    expect(breakpoint.omit).toBeFalsy();
  });

  it("definition 没有 messages 时按空模板处理（不抛原生 TypeError）", async () => {
    const { service } = await makeService({ strategy: "prune" });
    const agent = selfAgent();
    // 手写的 definition 可能根本没有 messages；交接回合此时已跑完，
    // 抛 TypeError 对调用方毫无可操作性
    agent.definition = {} as unknown as { messages: any[] };

    const ctx = await service.migrate({ agent: asAgent(agent) });

    expect(agent.messages).toHaveLength(1); // 只剩交接断点
    expect(agent.messages[0]!.content).toContain(ctx.handoffPath);
  });

  it("omit（默认）：历史标记 omit，断点不标记", async () => {
    const { service } = await makeService();
    const agent = selfAgent();

    const ctx = await service.migrate({ agent: asAgent(agent) });

    // 原 3 条 + 交接回合 2 条 = 5 条历史，末尾再加 1 条断点
    expect(agent.messages).toHaveLength(6);
    const breakpoint = agent.messages.at(-1)!;
    expect(breakpoint.content).toContain(ctx.handoffPath);
    expect(breakpoint.omit).toBeFalsy();
    // 首条（模板 system）不省略，其余历史标记 omit
    expect(agent.messages[0].omit).toBeFalsy();
    expect(agent.messages.slice(1, -1).every((m) => m.omit === true)).toBe(true);
  });

  it("migrate 参数 strategy 覆盖构造默认", async () => {
    const { service } = await makeService(); // 默认 omit
    const agent = selfAgent();

    await service.migrate({ agent: asAgent(agent), strategy: "prune" });

    expect(agent.messages).toHaveLength(2);
  });

  it("onBeforeHandoff / onHandoff / onMigrated 依次收到上下文", async () => {
    const order: string[] = [];
    const { service } = await makeService({
      strategy: "prune",
      onBeforeHandoff: (ctx) => {
        order.push("before");
        expect(ctx.mode).toBe("self");
        expect(ctx.handoffDoc).toBeUndefined();
        expect(ctx.messageCountBefore).toBe(3);
        expect(ctx.migrating).toBe(true); // 钩子可据此区分 /handoff 与 /migrate
      },
      onHandoff: (ctx) => {
        order.push("handoff");
        expect(ctx.handoffPath).toBeTruthy();
      },
      onMigrated: (ctx) => {
        order.push("migrated");
        expect(ctx.agent.messages).toHaveLength(2);
      },
    });
    const agent = selfAgent();

    await service.migrate({ agent: asAgent(agent), promptTokens: 80, handoffTokens: 50 });

    expect(order).toEqual(["before", "handoff", "migrated"]);
  });

  it("钩子抛错不中断流程", async () => {
    const { service } = await makeService({
      strategy: "prune",
      onBeforeHandoff: () => {
        throw new Error("UI error");
      },
      onHandoff: () => {
        throw new Error("log error");
      },
      onMigrated: () => {
        throw new Error("save error");
      },
    });
    const agent = selfAgent();

    const ctx = await service.migrate({ agent: asAgent(agent) });

    expect(existsSync(ctx.handoffPath)).toBe(true);
    expect(agent.messages).toHaveLength(2);
  });

  it("summary 模式下 prune 也把文档落盘，断点仍只给路径", async () => {
    const { service } = await makeService({ strategy: "prune" });
    const agent = new FakeAgent({ writeTool: false });

    const ctx = await service.migrate({ agent: asAgent(agent) });

    expect(ctx.mode).toBe("summary");
    const written = await fs.readFile(ctx.handoffPath, "utf-8");
    expect(written).toContain("## 💬 Conversation Breakpoint");
    expect(agent.messages.at(-1)!.content).not.toContain("## 💬 Conversation Breakpoint");
  });
});

// ---------------------------------------------------------------------------
// 取消（AbortSignal）—— 用户按 Ctrl+C 必须真的停下，且**不降级、不重试**
// ---------------------------------------------------------------------------

describe("取消（AbortSignal）", () => {
  /** 造一个「请求一开始就被取消」的 OpenAI 错误（与 SDK 抛的形态一致） */
  const abortError = () =>
    Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });

  it("summary 模式把取消信号作为 RequestOptions 传给模型请求", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent({ writeTool: false });
    const ac = new AbortController();

    await service.handoff({ agent: asAgent(agent), mode: "summary", signal: ac.signal });

    // 第二个参数才是 RequestOptions；放进 body 不会被 SDK 当成取消信号。
    // 传下去的是「服务句柄 + 调用方 signal」的合集，不是调用方那个对象本身
    const [, requestOptions] = agent.client.chat.completions.create.mock.calls[0]!;
    const passed = (requestOptions as { signal?: AbortSignal }).signal;
    expect(passed).toBeInstanceOf(AbortSignal);
    ac.abort();
    expect(passed!.aborted).toBe(true);
  });

  it("summary 请求进行中被服务 abort() 拦住 → 请求 signal 触发、不落盘", async () => {
    const { service, dir } = await makeService();
    const agent = new FakeAgent({ writeTool: false });
    let seen: AbortSignal | undefined;
    agent.client.chat.completions.create.mockImplementationOnce(
      async (_body?: unknown, options?: { signal?: AbortSignal }) => {
        seen = options?.signal;
        service.abort();
        throw abortError();
      },
    );

    await expect(service.handoff({ agent: asAgent(agent), mode: "summary" })).rejects.toThrow(
      HandoffAbortedError,
    );

    // 自动迁移这条路没有外部 signal，只有服务自身的句柄能中止这次请求
    expect(seen?.aborted).toBe(true);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("summary 请求被取消 → 抛 HandoffAbortedError（不是普通失败），且不落盘", async () => {
    const { service, dir } = await makeService();
    const agent = new FakeAgent({ writeTool: false });
    agent.client.chat.completions.create.mockRejectedValueOnce(abortError());
    const ac = new AbortController();
    ac.abort();

    await expect(
      service.handoff({ agent: asAgent(agent), mode: "summary", signal: ac.signal }),
    ).rejects.toThrow(HandoffAbortedError);

    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("self 模式被取消：不重试、不降级 summary（这正是 Ctrl+C 无效的根因）", async () => {
    const { service } = await makeService();
    const ac = new AbortController();
    // 真机形态：`agent.abort()` 不抛错，send 正常返回，但文档没写出来
    const agent = new FakeAgent({ onSend: () => void ac.abort() });

    await expect(
      service.handoff({ agent: asAgent(agent), mode: "self", signal: ac.signal }),
    ).rejects.toThrow(HandoffAbortedError);

    // 只发送了一轮：取消不能被当成「文档没写好」而触发重试
    expect(agent.sent).toHaveLength(1);
    // 一路降到 summary 会再发一次模型请求——必须没有
    expect(agent.client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("self 模式被取消后删掉写了一半的文档", async () => {
    const { service, dir } = await makeService();
    const ac = new AbortController();
    const agent = new FakeAgent({
      onSend: async (content) => {
        // 模型已经用 write 工具落了半截内容，然后被取消
        const path = /Handoff document absolute path: (.+)/.exec(content)![1]!.trim();
        await fs.writeFile(path, "## 💬 Conversation Breakpoint\nonly half written", "utf-8");
        ac.abort();
      },
    });

    await expect(
      service.handoff({ agent: asAgent(agent), mode: "self", signal: ac.signal }),
    ).rejects.toThrow(HandoffAbortedError);

    // 半成品必须清掉：否则下一轮接手方会把不完整内容当成真实交接读进去
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("migrate 被取消后回到交接前：历史逐条不变、不留断点、不留文档", async () => {
    const { service, dir } = await makeService({ strategy: "prune" });
    const ac = new AbortController();
    const agent = new FakeAgent({ onSend: () => void ac.abort() });
    const before = JSON.parse(JSON.stringify(agent.messages));

    await expect(service.migrate({ agent: asAgent(agent), signal: ac.signal })).rejects.toThrow(
      HandoffAbortedError,
    );

    // 断点消息没有被注入，交接回合也没留在历史里
    expect(agent.messages).toEqual(before);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("服务自身的 abort() 就能取消（自动迁移这条路递不进 signal）", async () => {
    const { service, dir } = await makeService();
    // 自动迁移由 AutoMigratePlugin 直接调 migrate()，调用方没有 signal 可传，
    // 服务不自己持有取消句柄的话，Ctrl+C 会被当成「文档没写出来」→ 重试 → 降级
    const agent = new FakeAgent({ onSend: () => service.abort() });

    await expect(service.handoff({ agent: asAgent(agent) })).rejects.toThrow(HandoffAbortedError);

    expect(agent.sent).toHaveLength(1);
    expect(agent.client.chat.completions.create).not.toHaveBeenCalled();
    expect(agent.messages).toHaveLength(3);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("取消后 agent.messages 逐条回到交接前（不留半截交接回合）", async () => {
    const { service } = await makeService();
    const ac = new AbortController();
    const agent = new FakeAgent({ onSend: () => void ac.abort() });
    const before = JSON.parse(JSON.stringify(agent.messages));

    await expect(service.handoff({ agent: asAgent(agent), signal: ac.signal })).rejects.toThrow(
      HandoffAbortedError,
    );

    // 交接指令（几 KB 的 Skill 正文）必须一并消失：否则下一次请求会把它当历史再发一遍，
    // `↑` 翻历史也能把它翻出来
    expect(agent.messages).toEqual(before);
  });

  it("summary 文档已落盘后才被取消：文档同样删掉（不留半成品）", async () => {
    const { service, dir } = await makeService();
    const agent = new FakeAgent({ writeTool: false });
    const ac = new AbortController();
    // 请求本身成功返回，取消在「已生成、已落盘」之后生效：最后一道取消点拦住它
    agent.client.chat.completions.create.mockImplementationOnce(async () => {
      ac.abort();
      return { choices: [{ message: { content: docContent() } }] };
    });

    await expect(
      service.handoff({ agent: asAgent(agent), mode: "summary", signal: ac.signal }),
    ).rejects.toThrow(HandoffAbortedError);

    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("提交点之后（文档已校验通过）的取消不再打断迁移", async () => {
    const ac = new AbortController();
    // onHandoff 只在文档通过校验后触发 = 提交点：此后停下会留下「已存档但未剔除」的
    // 第三种状态，比让迁移做完更糟，所以这里只验「迁移照常完成」
    const { service } = await makeService({ strategy: "prune", onHandoff: () => ac.abort() });
    const agent = new FakeAgent({
      onSend: async (_c, _n, self) => {
        const path = self.sent[0].match(/Handoff document absolute path: (.+)/)![1].trim();
        await fs.writeFile(path, docContent(), "utf-8");
      },
    });

    const ctx = await service.migrate({ agent: asAgent(agent), signal: ac.signal });

    expect(existsSync(ctx.handoffPath)).toBe(true);
    expect(agent.messages).toHaveLength(2);
  });

  it("没有进行中的交接时 abort() 是 no-op（不污染下一次交接）", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent();

    service.abort();

    const ctx = await service.handoff({ agent: asAgent(agent), mode: "summary" });
    expect(existsSync(ctx.handoffPath)).toBe(true);
  });

  it("signal 存在但未取消时行为不变（防止误伤正常路径）", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent();
    const ac = new AbortController();

    const ctx = await service.handoff({
      agent: asAgent(agent),
      mode: "summary",
      signal: ac.signal,
    });

    expect(ctx.mode).toBe("summary");
    expect(existsSync(ctx.handoffPath)).toBe(true);
  });
});
