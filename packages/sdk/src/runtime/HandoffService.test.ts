import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentError, Agent, AgentNS, CallbackTool } from "@ai-zen/agents-core";
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

/** 生成交接文档正文（形状与真件一致；写多长都不影响判据） */
function docContent(padding = 600): string {
  return `## 💬 Conversation Breakpoint\nBreakpoint content from the previous round\n## 🔔 First Step for the Next Agent\n- run npm test\n${"x".repeat(padding)}`;
}

/**
 * 模型那一侧的脚本：从交接指令里认出这次的文档路径，然后调一次写工具把它落盘。
 *
 * `body` 可以给得比 `docContent()` 短 —— “写出来不到 400 字节算没写出来”那条就靠它验
 * （`PRD.md` 3.6）。
 */
function writeScript(body: string = docContent()): FakeAgentOptions["onSend"] {
  return async (_content, _nth, self) => {
    await self.callWrite(self.handoffPathOf(), body);
  };
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
 * 新 core 里**没有 `send()`** 了（`CORE.md` §1）：自交接靠「`push` 一条指令」，判据是那次写文档
 * 的**工具调用**。所以这个替身要把 core 那条路的三样东西都演出来：
 *   - `start()`：幂等，返回一句「到死才 resolve」的 promise；
 *   - `push(entry)`：落一条 user 消息 → 变 `working` → 这一批（`onOuterLoopStart`）→ 跑脚本
 *     （脚本里用 `callWrite` 模拟模型调写工具）→ 这一批收口（`onOuterLoopEnd`）→ 变闲；
 *   - `dispatch(hook, ctx)`：与 core 的 `dispatchHook` 同一口径（任一插件返回字符串即短路），
 *     钩子在前（还能拒）、跑在中间、钩子在后（能看结果）。
 *
 * `state` 的转移必须走 `setState`（同值不发），否则订阅方会被同一次转移喂两次。
 * `state` 与 `isOutputPaused` 是**两处状态**（与 core 同口径）：`state` 只说循环的位置，
 * `isOutputPaused` 只管「从下一批起还收不收件」。
 */
class FakeAgent {
  messages: any[];
  definition: { messages: any[] };
  tools: any[];
  model = "fake-model";
  modelConfig: Record<string, unknown> = {};
  scope = { cwd: process.cwd() };
  /** 投进来的指令正文（等价于旧 `send()` 收到的内容） */
  sent: string[] = [];
  plugins: any[] = [];
  client: any;
  /** 常驻会话：自交接要求 agent 能「再问一次」 */
  lifetime = "resident";
  state: "working" | "idle" = "idle";
  /** 还取不取件（另一处状态，不影响 `state`） */
  private outputPaused = false;

  get isOutputPaused(): boolean {
    return this.outputPaused;
  }

  /** 关输出闸（与 core 同口径：发事件 + 跑钩子） */
  pauseOutput(): void {
    if (this.outputPaused) return;
    this.outputPaused = true;
    this.emit("output:paused", { agent: this });
    void this.dispatch("onOutputPaused", { agent: this });
  }

  /** 用户按了停（与 core 同口径：关闸 + 报「有人按了停」） */
  abort(): void {
    this.pauseOutput();
    void this.dispatch("onAbort", { agent: this });
  }

  /** 开输出闸 */
  resumeOutput(): void {
    if (!this.outputPaused) return;
    this.outputPaused = false;
    this.emit("output:resumed", { agent: this });
    void this.dispatch("onOutputResumed", { agent: this });
  }

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

  /** 跑一遍钩子（与 core 的 `dispatchHook` 同一口径：任一插件返回字符串即短路） */
  async dispatch(hook: string, ctx: any): Promise<string | undefined> {
    for (const plugin of this.plugins) {
      const fn = plugin?.[hook];
      if (typeof fn !== "function") continue;
      const result = await fn.call(plugin, ctx);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  /** 这次交接的文档路径（指令里给的绝对路径） */
  handoffPathOf(): string {
    const content = this.sent.at(-1) ?? "";
    return /absolute path:\s*(\S+\.md)/.exec(content)?.[1] ?? "";
  }

  /**
   * 模拟模型调一次 `write`：门（`onToolStart`，能拒）→ 真的跑（写盘）→ 结果（`onToolEnd`）。
   *
   * 三个可观测点与 core 一一对应，于是「谁在什么时候看到什么」与真跑一致。
   */
  async callWrite(path: string, body: string): Promise<void> {
    const toolCall: any = {
      agent: this,
      tool_call: {
        function: { name: "write", arguments: JSON.stringify({ path, content: body }) },
      },
      function_call: { name: "write" },
      parsedArgs: { path, content: body },
      resultMessage: { status: AgentNS.MessageStatus.Completed, content: "" },
    };
    const denied = await this.dispatch("onToolStart", { agent: this, toolCall });
    if (denied !== undefined) {
      // 拒了：那条 tool 消息的正文就是拒绝理由，工具不跑
      toolCall.resultMessage.content = denied;
      await this.dispatch("onToolEnd", { agent: this, toolCall });
      return;
    }
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, body, "utf-8");
    await this.dispatch("onToolEnd", { agent: this, toolCall });
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

  private setState(next: "working" | "idle"): void {
    const from = this.state;
    if (from === next) return;
    this.state = next;
    // 与 core 同口径：状态事件按到达值分名（CORE.md §10）
    this.emit(`state:${next}`, { agent: this, from });
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
    // 真 core：一批开头先落 user 消息，再进内循环
    this.messages.push({ role: "user", content, source: entry.source });
    const batch = [{ ...entry, createdAt: new Date().toISOString() }];

    void (async () => {
      this.setState("working");
      await this.dispatch("onOuterLoopStart", { agent: this, entries: batch });
      await this.options.onSend?.(content, this.sent.length, this);
      await this.dispatch("onOuterLoopEnd", { agent: this, entries: batch });
      // 模拟 core：追加 assistant 回执，然后回到「闲」
      this.messages.push({ role: "assistant", content: "Handoff document written." });
      this.setState("idle");
    })();
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

  it("createPostMessages 的形状是死的：system + hidden、正文只带路径", () => {
    const messages = HandoffService.createPostMessages("/tmp/handoffs/x.md");

    expect(messages).toHaveLength(1);
    const breakpoint = messages[0]!;
    // `role: system` + `hidden`（不给人看，但照常进上下文）—— PRD 3.6 / 4.5
    expect(breakpoint.role).toBe("system");
    expect(breakpoint.hidden).toBe(true);
    // 正文只有路径：不带全文，也不带自己编的指令句
    expect(breakpoint.content).toBe("/tmp/handoffs/x.md");
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
      // 模型用 write 工具把它落盘：钩子按「工具名 + 路径」认出这一次
      onSend: writeScript(),
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
      onSend: writeScript(),
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
      onSend: writeScript(),
    });

    await service.handoff({ agent: asAgent(agent) });

    expect(agent.sent[0]).toContain("# Test handoff standards");
    expect(agent.sent[0]).not.toContain(FALLBACK_HANDOFF_TEMPLATE.split("\n")[0] + "\n");
  });

  it("交接期间关着输出闸，但 SDK 不开闸（开闸在宿主交接收口）", async () => {
    let pausedAtCommit: boolean | undefined;
    const { service } = await makeService({
      onHandoff: (ctx) => {
        // 宿主换记忆就发生在这一钩子里：此刻闸必须是关的，否则这期间落进来的话会被一起挪进存档
        pausedAtCommit = (ctx.agent as any).isOutputPaused;
      },
    });
    const agent = new FakeAgent({ onSend: writeScript() });
    const resume = vi.spyOn(agent, "resumeOutput");

    const ctx = await service.handoff({ agent: asAgent(agent) });

    expect(ctx.mode).toBe("self");
    expect(pausedAtCommit).toBe(true);
    // 拿到写文档结果时换记忆还没发生：此刻开闸会让这期间落进来的话落进旧记忆
    expect(resume).not.toHaveBeenCalled();
    expect(agent.isOutputPaused).toBe(true);
  });

  it("summary 那一档也一样：自己关闸，也不开回来", async () => {
    let pausedAtCommit: boolean | undefined;
    const { service } = await makeService({
      mode: "summary",
      onHandoff: (ctx) => {
        pausedAtCommit = (ctx.agent as any).isOutputPaused;
      },
    });
    // 没有 write 工具 → 自交接不可用，必然走摘要
    const agent = new FakeAgent({ writeTool: false });
    const resume = vi.spyOn(agent, "resumeOutput");

    const ctx = await service.handoff({ agent: asAgent(agent) });

    expect(ctx.mode).toBe("summary");
    expect(pausedAtCommit).toBe(true);
    expect(resume).not.toHaveBeenCalled();
    expect(agent.isOutputPaused).toBe(true);
  });

  it("取消（用户按了停）之后不替他把闸开回来", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent({
      onSend: (_content, _nth, self) => {
        // 用户在这一批里按了中断
        self.abort();
      },
    });

    await expect(service.handoff({ agent: asAgent(agent) })).rejects.toThrow(HandoffAbortedError);

    // 停是他的意愿：交接收尾不许顺手把它开回来
    expect(agent.isOutputPaused).toBe(true);
  });

  it("agent 无 write 工具时直接走 summary", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent({ writeTool: false });

    const ctx = await service.handoff({ agent: asAgent(agent) });

    expect(agent.sent).toHaveLength(0);
    expect(ctx.mode).toBe("summary");
    expect(existsSync(ctx.handoffPath)).toBe(true);
  });

  it("写得过小 → 单向降级 summary（阈值 400 字节）", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent({ onSend: writeScript("too short") });

    const ctx = await service.handoff({ agent: asAgent(agent) });

    expect(agent.sent).toHaveLength(1); // 只投一次：没有第二次机会
    expect(ctx.requestedMode).toBe("self");
    // 文件写出来了，但不到 400 字节 —— 算没写出来（PRD 3.6 / 4.5）
    expect(ctx.mode).toBe("summary");
    // summary 由服务调用模型并落盘
    expect(agent.client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(ctx.handoffDoc).toContain("## 💬 Conversation Breakpoint");
    const written = await fs.readFile(ctx.handoffPath, "utf-8");
    expect(written).toBe(ctx.handoffDoc);
  });

  it("minHandoffBytes 可调：调小之后短文档算写出来了", async () => {
    const { service } = await makeService({ minHandoffBytes: 5 });
    const agent = new FakeAgent({ onSend: writeScript("够短但过线") });

    const ctx = await service.handoff({ agent: asAgent(agent) });

    expect(ctx.mode).toBe("self");
    expect(agent.client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("交接回合期间守卫 armed，结束后 disarm", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent({
      onSend: async (_c, _n, self) => {
        const guard = self.plugins.find((p) => p instanceof HandoffGuardPlugin);
        expect(guard?.armed).toBe(true);
        await self.callWrite(self.handoffPathOf(), docContent());
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
    // 而是「这个会话已经不在了」—— 降级 summary 会为一个死掉的会话白烧一次全量输入。
    const { service } = await makeService();
    const agent = new FakeAgent();
    agent.stop();

    await expect(service.handoff({ agent: asAgent(agent) })).rejects.toBeInstanceOf(AgentError);
    expect(agent.sent).toHaveLength(0);
    expect(agent.client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("agent 不收件时不投递（不收件就不取件），直接降级 summary", async () => {
    // 不收件时 `push` 只会排队，等 resumeOutput 之后突然自己跑起来 —— 那是「用户让它停却看见
    // 它又开口」。所以这一趟当没跑成，走逃生模式（summary 不经过 agent）。
    const { service } = await makeService();
    const agent = new FakeAgent();
    agent.pauseOutput();

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

  it("handingOff 在流程结束后复位", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent({
      onSend: writeScript(),
    });

    expect(service.handingOff).toBe(false);
    const pending = service.handoff({ agent: asAgent(agent) });
    expect(service.handingOff).toBe(true);
    await pending;
    expect(service.handingOff).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// self 模式：真 core 走一遍
// ---------------------------------------------------------------------------

/**
 * 这一组不接假 agent：判据落在 core 的钩子上（`onToolStart` / `onToolEnd` / `onOuterLoopEnd`），
 * 由真的循环来发。假件把它演得太随意就验不出任何东西。
 */
describe("self 模式：真 core（投指令 + 看那次写工具的结果，没有 send()）", () => {
  /**
   * 造一个客户端：流式请求（会话那一次）回「模型要求调 write」+ 收尾文本，
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

  it("把指令投进去、那次写工具的结果回来了、再校验落盘（模式仍是 self）", async () => {
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

  it("模型不写文档（工具失败）→ 降级 summary（真 core 也一样）", async () => {
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
// migrate：写文档 **+ 换记忆**（记忆长什么样只有这一处算）
// ---------------------------------------------------------------------------

/**
 * 这一组的预设：假 agent 开局是 `[system 模板, user, assistant]`，模板那一条在 `definition.messages`。
 * 自交接会投一条指令、跑一趟写工具，所以交接回合本身也会多出两条消息。
 */
describe("migrate", () => {
  function selfAgent(body?: string): FakeAgent {
    return new FakeAgent({ onSend: writeScript(body) });
  }

  it("prune：物理剔除旧记忆，只留模板 + 交接断点", async () => {
    const { service } = await makeService({ strategy: "prune" });
    const agent = selfAgent();

    const ctx = await service.migrate({ agent: asAgent(agent) });

    // 模板（system 提示）1 条 + 断点 1 条
    expect(agent.messages).toHaveLength(2);
    expect(agent.messages[0]?.role).toBe("system");
    expect(agent.messages[0]?.content).toBe("You are a helper.");

    const breakpoint = agent.messages.at(-1)!;
    expect(breakpoint.role).toBe("system");
    expect(breakpoint.hidden).toBe(true);
    // 正文只带路径
    expect(breakpoint.content).toBe(ctx.handoffPath);
    expect(breakpoint.omit).toBeFalsy();
  });

  it("omit（默认）：历史标 omit，模板与断点不标", async () => {
    const { service } = await makeService();
    const agent = selfAgent();
    const historyBefore = agent.messages.length;

    const ctx = await service.migrate({ agent: asAgent(agent) });

    // 旧消息一条不删（模板 1 + 历史 2 + 交接回合 2），末尾再加 1 条断点
    expect(agent.messages).toHaveLength(historyBefore + 2 + 1);
    const breakpoint = agent.messages.at(-1)!;
    expect(breakpoint.content).toBe(ctx.handoffPath);
    expect(breakpoint.omit).toBeFalsy();
    // 模板那一条不 omit，其余旧消息全标上
    expect(agent.messages[0]?.omit).toBeFalsy();
    expect(agent.messages.slice(1, -1).every((message) => message.omit === true)).toBe(true);
  });

  it("strategy 参数覆盖构造默认", async () => {
    const { service } = await makeService(); // 默认 omit
    const agent = selfAgent();

    await service.migrate({ agent: asAgent(agent), strategy: "prune" });

    expect(agent.messages).toHaveLength(2);
  });

  it("definition 没有 messages 时按空模板处理（不抛原生 TypeError）", async () => {
    const { service } = await makeService({ strategy: "prune" });
    const agent = selfAgent();
    // 手写的定义可能根本没有 messages；交接回合此时已跑完，抛 TypeError 对调用方毫无可操作性
    agent.definition = {} as unknown as { messages: any[] };

    const ctx = await service.migrate({ agent: asAgent(agent) });

    expect(agent.messages).toHaveLength(1); // 只剩交接断点
    expect(agent.messages[0]?.content).toBe(ctx.handoffPath);
  });

  it("summary 模式下 prune 也把文档落盘，断点仍只给路径", async () => {
    const { service } = await makeService({ strategy: "prune" });
    const agent = new FakeAgent({ writeTool: false });

    const ctx = await service.migrate({ agent: asAgent(agent) });

    expect(ctx.mode).toBe("summary");
    const written = await fs.readFile(ctx.handoffPath, "utf-8");
    expect(written).toContain("## 💬 Conversation Breakpoint");
    expect(agent.messages.at(-1)?.content).toBe(ctx.handoffPath);
    expect(agent.messages.at(-1)?.content).not.toContain("## 💬 Conversation Breakpoint");
  });

  it("onBeforeHandoff / onHandoff / onMigrated 依次收到上下文，且 onMigrated 只叫一次", async () => {
    const order: string[] = [];
    const { service } = await makeService({
      strategy: "prune",
      onBeforeHandoff: (ctx) => {
        order.push("before");
        expect(ctx.mode).toBe("self");
        expect(ctx.handoffDoc).toBeUndefined();
        expect(ctx.messageCountBefore).toBe(3);
      },
      onHandoff: (ctx) => {
        order.push("handoff");
        expect(ctx.handoffPath).toBeTruthy();
      },
      onMigrated: (ctx) => {
        order.push("migrated");
        // 这一拍记忆已经是新的那一份了
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
});

// ---------------------------------------------------------------------------
// migrate 的落库接缝：一处实现 + 可接管
// ---------------------------------------------------------------------------

describe("migrate 的落库接缝（commitMemory）", () => {
  it("不注入：SDK 自己换 agent.messages（外部使用者走的那条）", async () => {
    const { service } = await makeService({ strategy: "prune" });
    const agent = new FakeAgent({ onSend: writeScript() });
    // 记忆就是这个数组（换是原地换：同一个数组、不换引用，CORE.md §12）
    const memory = agent.messages;

    const ctx = await service.migrate({ agent: asAgent(agent) });

    expect(agent.messages).toBe(memory);
    expect(agent.messages).toHaveLength(2);
    expect(agent.messages.at(-1)?.content).toBe(ctx.handoffPath);
  });

  it("注入：agent.messages 一个字节都不动，回调拿到的是同一份结果", async () => {
    const seen: Array<{ memory: any[]; handoffPath: string; mode: string }> = [];
    const { service } = await makeService({
      strategy: "prune",
      commitMemory: (commit) => {
        seen.push(commit as any);
      },
    });
    const agent = new FakeAgent({ onSend: writeScript() });
    const memory = agent.messages;

    const ctx = await service.migrate({ agent: asAgent(agent) });

    // 接缝只决定「落在哪儿」：SDK 没把新记忆换上去（旧记忆一条没剔、断点也没追）
    expect(agent.messages).toBe(memory);
    expect(agent.messages.at(-1)?.content).toBe("Handoff document written.");
    expect(agent.messages.some((message) => message.content === ctx.handoffPath)).toBe(false);

    // 回调拿到的那一份与「不注入时 SDK 会换成的那一份」逐条相同（同一份算出来的结果）
    expect(seen).toHaveLength(1);
    const commit = seen[0]!;
    expect(commit.handoffPath).toBe(ctx.handoffPath);
    expect(commit.mode).toBe("self");
    expect(commit.memory).toHaveLength(2);
    expect(commit.memory[0]?.content).toBe("You are a helper.");
    expect(commit.memory[1]).toMatchObject({
      role: "system",
      hidden: true,
      content: ctx.handoffPath,
    });
  });

  it("400 字节门槛在两条路上都生效：不注入", async () => {
    const { service } = await makeService({ strategy: "prune" });
    const agent = new FakeAgent({ onSend: writeScript("too short") });

    const ctx = await service.migrate({ agent: asAgent(agent) });

    // 自交接没写过 400 字节 → 单向降级到独立摘要，记忆照旧换
    expect(ctx.requestedMode).toBe("self");
    expect(ctx.mode).toBe("summary");
    expect(agent.messages).toHaveLength(2);
    expect(agent.messages.at(-1)?.content).toBe(ctx.handoffPath);
  });

  it("400 字节门槛在两条路上都生效：注入（降级也交同一份结果给回调）", async () => {
    const seen: string[] = [];
    const { service } = await makeService({
      strategy: "prune",
      commitMemory: (commit) => {
        seen.push(commit.mode);
      },
    });
    const agent = new FakeAgent({ onSend: writeScript("too short") });

    const ctx = await service.migrate({ agent: asAgent(agent) });

    expect(ctx.mode).toBe("summary");
    // 降级之后仍然走同一个接缝（落库这一段不因执行者不同而分叉）
    expect(seen).toEqual(["summary"]);
    // SDK 没动内存：交接回合那一条指令与回执都还在（旧记忆一条没剔）
    expect(agent.messages.at(-1)?.content).toBe("Handoff document written.");
    expect(agent.messages.some((message) => message.content === ctx.handoffPath)).toBe(false);
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
    // 传下去的就是调用方递进来的那一个（服务自己不持有句柄）
    const [, requestOptions] = agent.client.chat.completions.create.mock.calls[0]!;
    const passed = (requestOptions as { signal?: AbortSignal }).signal;
    expect(passed).toBeInstanceOf(AbortSignal);
    ac.abort();
    expect(passed!.aborted).toBe(true);
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

    // 只投了一次：取消不能被当成「文档没写好」而去降级 summary
    expect(agent.sent).toHaveLength(1);
    // 一路降到 summary 会再发一次模型请求——必须没有
    expect(agent.client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("self 模式被取消后删掉写了一半的文档", async () => {
    const { service, dir } = await makeService();
    const ac = new AbortController();
    const agent = new FakeAgent({
      onSend: async (_content, _nth, self) => {
        // 模型已经用 write 工具落了半截内容，然后被取消
        await self.callWrite(
          self.handoffPathOf(),
          "## 💬 Conversation Breakpoint\nonly half written",
        );
        ac.abort();
      },
    });

    await expect(
      service.handoff({ agent: asAgent(agent), mode: "self", signal: ac.signal }),
    ).rejects.toThrow(HandoffAbortedError);

    // 半成品必须清掉：否则下一回的接手方会把不完整内容当成真实交接读进去
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

  it("提交点之后的取消不再打断这一趟（文档已经写好）", async () => {
    const ac = new AbortController();
    // onHandoff 只在文档写好后才触发 = 提交点：此后停下会留下「文档已落盘但被当成未完成」
    // 的第三种状态，所以跨过这一步的事不再响应取消
    const { service } = await makeService({ onHandoff: () => ac.abort() });
    const agent = new FakeAgent({
      onSend: writeScript(),
    });

    const ctx = await service.handoff({ agent: asAgent(agent), signal: ac.signal });

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
