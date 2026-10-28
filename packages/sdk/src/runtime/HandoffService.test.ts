import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HandoffAbortedError, HandoffService } from "./HandoffService.js";
import { HandoffGuardPlugin } from "./HandoffGuardPlugin.js";
import { FALLBACK_HANDOFF_TEMPLATE } from "../config/factory-skills.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const SKILL_CONTENT = [
  "---",
  "name: handoff",
  "description: 测试用交接 Skill",
  "---",
  "",
  "# 测试交接规范",
  "",
  "## 💬 对话断点",
  "## 🔔 接手第一步",
].join("\n");

/** 生成足够大的交接文档正文（默认超过 400 字节阈值） */
function docContent(padding = 600): string {
  return `## 💬 对话断点\n上一轮的断点内容\n## 🔔 接手第一步\n- 跑 npm test\n${"x".repeat(padding)}`;
}

interface FakeAgentOptions {
  /** 每次 send 时的行为（默认什么都不做） */
  onSend?: (content: string, call: number, agent: FakeAgent) => void | Promise<void>;
  /** 是否具备 write 工具（默认有） */
  writeTool?: boolean;
  messages?: any[];
  definitionMessages?: any[];
}

/** 假 agent：只实现 HandoffService 用到的表面（send / use / tools / messages / definition / client） */
class FakeAgent {
  messages: any[];
  definition: { messages: any[] };
  tools: any[];
  model = "fake-model";
  modelConfig: Record<string, unknown> = {};
  lastUsage: any = { prompt_tokens: 999 };
  scope = { cwd: process.cwd() };
  sent: string[] = [];
  plugins: any[] = [];
  client: any;

  constructor(public options: FakeAgentOptions = {}) {
    this.messages = options.messages ?? [
      { role: "system", content: "You are a helper." },
      { role: "user", content: "帮我做任务 A" },
      { role: "assistant", content: "好的，已开始" },
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
          create: vi.fn(async () => ({
            choices: [{ message: { content: docContent() } }],
          })),
        },
      },
    };
  }

  use(plugin: any): void {
    this.plugins.push(plugin);
  }

  async send(content: string): Promise<any> {
    this.sent.push(content);
    await this.options.onSend?.(content, this.sent.length, this);
    // 模拟 core：追加 user 指令 + assistant 回执
    this.messages.push({ role: "user", content });
    this.messages.push({ role: "assistant", content: "交接文档已写入。" });
    return this.messages;
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
  it("createHandoffFileName 生成 <时间戳>-<会话id前8位>.md", () => {
    const name = HandoffService.createHandoffFileName(
      new Date(2026, 0, 2, 3, 4, 5),
      "abcdef1234567890",
    );
    expect(name).toBe("20260102-030405-abcdef12.md");
  });

  it("createHandoffFileName 无会话 id 时只有时间戳", () => {
    const name = HandoffService.createHandoffFileName(new Date(2026, 0, 2, 3, 4, 5));
    expect(name).toBe("20260102-030405.md");
  });

  it("createHandoffInstruction 串联 Skill 正文与参数（含路径与工具能力）", () => {
    const prompt = HandoffService.createHandoffInstruction({
      skillContent: SKILL_CONTENT,
      handoffPath: "/tmp/handoffs/a.md",
      toolsAvailable: true,
    });

    expect(prompt).toContain("# 测试交接规范");
    expect(prompt).toContain("## 本次交接参数");
    expect(prompt).toContain("/tmp/handoffs/a.md");
    expect(prompt).toContain("工具能力：可用");
    expect(prompt).toContain("write 工具");
    expect(prompt).toContain("不要复述文档内容");
  });

  it("createHandoffInstruction 无工具时要求直接输出正文并禁止推测", () => {
    const prompt = HandoffService.createHandoffInstruction({
      skillContent: SKILL_CONTENT,
      handoffPath: "/tmp/handoffs/a.md",
      toolsAvailable: false,
    });

    expect(prompt).toContain("工具能力：不可用");
    expect(prompt).toContain("⚠️ 未核实");
    expect(prompt).toContain("直接输出完整文档正文");
    expect(prompt).not.toContain("用 write 工具");
  });

  it("createPostMessages 只给路径并要求先 read", () => {
    const messages = HandoffService.createPostMessages("/tmp/handoffs/x.md");

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("/tmp/handoffs/x.md");
    expect(messages[0].content).toContain("read");
    // 不再内联全文
    expect(messages[0].content).not.toContain("## 💬 对话断点");
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
        const path = userMsg.match(/交接文档绝对路径：(.+)/)![1].trim();
        await fs.writeFile(path, docContent(), "utf-8");
      },
    });

    const ctx = await service.handoff({ agent: asAgent(agent), conversationId: "conv-1" });

    expect(ctx.mode).toBe("self");
    expect(ctx.requestedMode).toBe("self");
    expect(existsSync(ctx.handoffPath)).toBe(true);
    expect(ctx.handoffPath.startsWith(dir)).toBe(true);
    expect(ctx.handoffPath.endsWith("-conv-1.md")).toBe(true);
    // self 模式不读盘 → handoffDoc 为空
    expect(ctx.handoffDoc).toBeUndefined();
    // 会话未切换：历史仍在，且多出交接回合
    expect(ctx.messageCountBefore).toBe(3);
    expect(agent.messages.length).toBe(3 + 2);
    expect(agent.sent).toHaveLength(1);
  });

  it("self 模式：注入给 agent 的指令含 Skill 正文（而非代码内固定章节）", async () => {
    const { service } = await makeService({
      skillDirs: [join(await makeDir(), "nope")], // 不存在 → 走兜底
    });
    const agent = new FakeAgent({
      onSend: async (_c, _n, self) => {
        const path = self.sent[0].match(/交接文档绝对路径：(.+)/)![1].trim();
        await fs.writeFile(path, docContent(), "utf-8");
      },
    });

    await service.handoff({ agent: asAgent(agent) });

    // 读不到 Skill → 兜底模板（保险丝）
    expect(agent.sent[0]).toContain(FALLBACK_HANDOFF_TEMPLATE.split("\n")[0]);
    expect(agent.sent[0]).toContain("## 🔔 接手第一步");
  });

  it("self 模式：读得到 Skill 时使用 Skill 正文", async () => {
    const skillRoot = await makeDir();
    dirs.push(skillRoot);
    await fs.mkdir(join(skillRoot, "handoff"), { recursive: true });
    await fs.writeFile(join(skillRoot, "handoff", "SKILL.md"), SKILL_CONTENT, "utf-8");

    const { service } = await makeService({ skillDirs: [skillRoot] });
    const agent = new FakeAgent({
      onSend: async (_c, _n, self) => {
        const path = self.sent[0].match(/交接文档绝对路径：(.+)/)![1].trim();
        await fs.writeFile(path, docContent(), "utf-8");
      },
    });

    await service.handoff({ agent: asAgent(agent) });

    expect(agent.sent[0]).toContain("# 测试交接规范");
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
        const path = self.sent[0].match(/交接文档绝对路径：(.+)/)![1].trim();
        await fs.writeFile(path, "太短", "utf-8");
      },
    });

    const ctx = await service.handoff({ agent: asAgent(agent) });

    expect(agent.sent).toHaveLength(2); // 原回合 + 1 次重试
    expect(ctx.requestedMode).toBe("self");
    expect(ctx.mode).toBe("summary");
    // summary 由服务调用模型并落盘
    expect(agent.client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(ctx.handoffDoc).toContain("## 💬 对话断点");
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

  it("交接回合前清空 lastUsage（护栏/自动迁移的纵深防御）", async () => {
    const { service } = await makeService();
    let usageAtSend: unknown = "未执行";
    const agent = new FakeAgent({
      onSend: async (_c, _n, self) => {
        usageAtSend = self.lastUsage;
        const path = self.sent[0].match(/交接文档绝对路径：(.+)/)![1].trim();
        await fs.writeFile(path, docContent(), "utf-8");
      },
    });

    await service.handoff({ agent: asAgent(agent) });

    expect(usageAtSend).toBeUndefined();
  });

  it("交接回合期间守卫 armed，结束后 disarm", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent({
      onSend: async (_c, _n, self) => {
        const guard = self.plugins.find((p) => p instanceof HandoffGuardPlugin);
        expect(guard?.armed).toBe(true);
        const path = self.sent[0].match(/交接文档绝对路径：(.+)/)![1].trim();
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

  it("summary 模型不返回内容时抛错", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent({ writeTool: false });
    agent.client.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: null } }],
    });

    await expect(service.handoff({ agent: asAgent(agent) })).rejects.toThrow(
      "未能生成任务交接文档",
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
    await expect(nested).rejects.toThrow("交接流程已在进行中");
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
        const path = self.sent[0].match(/交接文档绝对路径：(.+)/)![1].trim();
        await fs.writeFile(path, docContent(), "utf-8");
      },
    });

    await service.handoff({ agent: asAgent(agent) });

    expect(migrating).toBe(false);
  });

  it("busy 在流程结束后复位", async () => {    const { service } = await makeService();
    const agent = new FakeAgent({
      onSend: async (_c, _n, self) => {
        const path = self.sent[0].match(/交接文档绝对路径：(.+)/)![1].trim();
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
// migrate：交接 + 开新会话
// ---------------------------------------------------------------------------

describe("migrate", () => {
  function selfAgent(): FakeAgent {
    return new FakeAgent({
      onSend: async (_c, _n, self) => {
        const path = self.sent[0].match(/交接文档绝对路径：(.+)/)![1].trim();
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

    await service.migrate({ agent: asAgent(agent), promptTokens: 80, maxTokens: 50 });

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
    expect(written).toContain("## 💬 对话断点");
    expect(agent.messages.at(-1)!.content).not.toContain("## 💬 对话断点");
  });
});

// ---------------------------------------------------------------------------
// 取消（AbortSignal）—— 用户按 Ctrl+C 必须真的停下，且**不降级、不重试**
// ---------------------------------------------------------------------------

describe("取消（AbortSignal）", () => {
  /** 造一个「请求一开始就被取消」的 OpenAI 错误（与 SDK 抛的形态一致） */
  const abortError = () => Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });

  it("summary 模式把 signal 作为 RequestOptions 传给模型请求", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent({ writeTool: false });
    const ac = new AbortController();

    await service.handoff({ agent: asAgent(agent), mode: "summary", signal: ac.signal });

    // 第二个参数才是 RequestOptions；放进 body 不会被 SDK 当成取消信号
    const [, requestOptions] = agent.client.chat.completions.create.mock.calls[0]!;
    expect(requestOptions).toEqual({ signal: ac.signal });
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
        const path = /交接文档绝对路径：(.+)/.exec(content)![1]!.trim();
        await fs.writeFile(path, "## 💬 对话断点\n只写了一半", "utf-8");
        ac.abort();
      },
    });

    await expect(
      service.handoff({ agent: asAgent(agent), mode: "self", signal: ac.signal }),
    ).rejects.toThrow(HandoffAbortedError);

    // 半成品必须清掉：否则下一轮接手方会把不完整内容当成真实交接读进去
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("migrate 被取消后不改动会话历史（不能留下已迁移的假象）", async () => {
    const { service } = await makeService({ strategy: "prune" });
    const ac = new AbortController();
    const agent = new FakeAgent({ onSend: () => void ac.abort() });
    const before = agent.messages.length;

    await expect(
      service.migrate({ agent: asAgent(agent), signal: ac.signal }),
    ).rejects.toThrow(HandoffAbortedError);

    // 断点消息没有被注入
    expect(agent.messages.at(-1)!.content).not.toContain("上一轮对话已交接");
    expect(agent.messages.length).toBeGreaterThanOrEqual(before);
  });

  it("signal 存在但未取消时行为不变（防止误伤正常路径）", async () => {
    const { service } = await makeService();
    const agent = new FakeAgent();
    const ac = new AbortController();

    const ctx = await service.handoff({ agent: asAgent(agent), mode: "summary", signal: ac.signal });

    expect(ctx.mode).toBe("summary");
    expect(existsSync(ctx.handoffPath)).toBe(true);
  });
});
