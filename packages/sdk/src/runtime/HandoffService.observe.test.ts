/**
 * 交接这一趟的三格事实（`HandoffFact`）：开始了、成了、没成。
 *
 * 与 `HandoffService.test.ts` 同一套搭法（假 agent + 临时交接目录），这里多出来的是「听」的那一侧：
 * 一个只订阅、不介入的第三方凭这三格就能说清这一趟走到哪了，不必再轮询 `handingOff`。假的是
 * **模型那一步**（假 agent、假端点），交接流程本身是真的。
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentError, AgentNS } from "@ai-zen/agents-core";
import { HandoffService, type HandoffFact } from "./HandoffService.js";

// ---------------------------------------------------------------------------
// helpers（与 HandoffService.test.ts 同一套）
// ---------------------------------------------------------------------------

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
 * 常驻会话没有 `send()`（`CORE.md` §1）：自交接靠「`push` 一条指令」，判据是那次写文档
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
  /** 投进来的指令正文（`push` 收到的 `entry.content`） */
  sent: string[] = [];
  plugins: any[] = [];
  client: any;
  /** 常驻会话：自交接要求 agent 能「再问一次」 */
  lifetime = "resident";
  state: "working" | "idle" = "idle";
  /** 还取不取走（另一处状态，不影响 `state`） */
  private outputPaused = false;

  get isOutputPaused(): boolean {
    return this.outputPaused;
  }

  /** 关输出开关（与 core 同口径：发事件 + 跑钩子） */
  pauseOutput(): void {
    if (this.outputPaused) return;
    this.outputPaused = true;
    this.emit("output:paused", { agent: this });
    void this.dispatch("onOutputPaused", { agent: this });
  }

  /** 用户按了停（与 core 同口径：关开关 + 报「有人按了停」） */
  abort(): void {
    this.pauseOutput();
    void this.dispatch("onAbort", { agent: this });
  }

  /** 开输出开关 */
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
    // 与 core 同口径：事件给订阅方，钩子给插件（守卫就靠 `onStop` 认「这一段已经不在了」）
    void this.dispatch("onStop", { agent: this });
    this.resolveDeath?.();
  }

  kill(): void {
    this.closed = true;
    this.emit("killed", { agent: this });
    void this.dispatch("onKill", { agent: this });
    this.resolveDeath?.();
  }

  // ---- 投递 ----

  send(entry: any): void {
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
  return await fs.mkdtemp(join(tmpdir(), "aizen-handoff-observe-"));
}

/** 把 FakeAgent 当作 SdkAgent 传入服务 */
const asAgent = (agent: FakeAgent) => agent as any;

const dirs: string[] = [];

async function makeService(): Promise<{ service: HandoffService; dir: string }> {
  const dir = await makeDir();
  dirs.push(dir);
  const service = new HandoffService({ handoffDir: dir });
  return { service, dir };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 三格事实
// ---------------------------------------------------------------------------

describe("交接的事实：开始、结束与失败", () => {
  it("没成的那一趟：开始一条、失败一条", async () => {
    const { service } = await makeService();
    const facts: HandoffFact[] = [];
    service.observe((fact) => facts.push(fact));

    // 摘要是**申请来的**那一档：写文档那一步在端点上，端点回错就是这一趟没成
    const agent = new FakeAgent();
    agent.client.chat.completions.create.mockRejectedValue(new Error("端点 500：写不了"));

    await expect(service.handoff({ agent: asAgent(agent), mode: "summary" })).rejects.toThrow(
      /端点 500/,
    );

    // 开始一条、失败一条，各一条、顺序如此
    expect(facts.map((fact) => fact.type)).toEqual(["started", "failed"]);

    // 失败那一格带得上原因：收成 `Error`，正文就是端点给的那句
    const started = facts[0] as Extract<HandoffFact, { type: "started" }>;
    const failed = facts[1] as Extract<HandoffFact, { type: "failed" }>;
    expect(started).toEqual({ type: "started", mode: "summary" });
    expect(failed.mode).toBe("summary");
    expect(failed.error).toBeInstanceOf(Error);
    expect(failed.error.message).toContain("端点 500");
  });

  it("成的那一趟：开始一条、结束一条，没有失败", async () => {
    const { service } = await makeService();
    const facts: HandoffFact[] = [];
    service.observe((fact) => facts.push(fact));

    const agent = new FakeAgent({ onSend: writeScript() });

    const ctx = await service.handoff({ agent: asAgent(agent) });

    expect(ctx.mode).toBe("self");
    expect(facts.map((fact) => fact.type)).toEqual(["started", "finished"]);
    expect(facts[0]).toEqual({ type: "started", mode: "self" });
    expect(facts[1]).toEqual({ type: "finished", mode: "self" });
  });

  it("订阅者抛错不影响这一趟交接", async () => {
    const { service } = await makeService();
    const facts: HandoffFact[] = [];
    // 第一个订阅者：在 `started` 那一下抛
    service.observe((fact) => {
      if (fact.type === "started") throw new Error("旁路炸了");
    });
    // 第二个订阅者：照常记
    service.observe((fact) => facts.push(fact));

    // 与上面那条成功用例同一套搭法：模型那一步真的把文档写出来
    const agent = new FakeAgent({ onSend: writeScript() });
    const ctx = await service.handoff({ agent: asAgent(agent) });

    // 这一趟仍然返回：说得出来是哪一档
    expect(ctx.mode).toBe("self");

    // 而且它跑的是成功那一趟：`started` 之后没有 `failed`
    const types = facts.map((fact) => fact.type);
    const startedAt = types.indexOf("started");
    expect(startedAt).toBeGreaterThanOrEqual(0);
    expect(types.slice(startedAt + 1)).not.toContain("failed");
    expect(types.slice(startedAt + 1)).toContain("finished");
  });

  it("退订之后不再收到，退订两次不炸", async () => {
    const { service } = await makeService();
    const facts: HandoffFact[] = [];
    const off = service.observe((fact) => facts.push(fact));
    off();
    off();

    const agent = new FakeAgent({ onSend: writeScript() });
    const ctx = await service.handoff({ agent: asAgent(agent) });

    // 这一趟照常跑完了（文档真写出来了），订阅者却一条事实都没收到
    expect(ctx.mode).toBe("self");
    expect(facts).toEqual([]);
  });
});
