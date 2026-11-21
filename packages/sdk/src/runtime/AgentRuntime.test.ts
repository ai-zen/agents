/**
 * 运行时的验收：**不 import 宿主**。
 *
 * 这里要守住的三件事（`dev-docs/PLAN.md` 第一段）：
 *   1. 常驻：一段会话登记一个执行体，叫醒就开始跑；杀死之后它不再回应，说过的话还在；
 *   2. 事件驱动：没有人 `await`，一条投递也把它从闲推到忙、跑完自己回到闲；
 *   3. 互相说话：一段会话把话寄给另一段，另一边收下、跑完、回一句落回发起方那边。
 *
 * 假的是**模型提供方**（`@ai-zen/agents-testing` 那个 OpenAI 兼容端点）与**库**（这里几张
 * Map）。凡是这一层真正的接线 —— 容器、定义文件、模型的 client、内核的事件 —— 都是真的。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentNS, Message, ToolCallContext, type Agent, type Tool } from "@ai-zen/agents-core";
import { startFakeLlm, type FakeLlmOptions, type FakeLlmRequest } from "@ai-zen/agents-testing";
import { Scope } from "../scope/Scope.js";
import { PeerSessionsScopePlugin } from "../scope/plugins/peers/PeerSessionsScopePlugin.js";
import {
  CREATE_SESSION_TOOL,
  POST_MESSAGE_TOOL,
  READ_SESSION_STATUS_TOOL,
} from "../scope/plugins/peers/peerSessionTools.js";
import type { AgentDefinition, AppConfig } from "../types/index.js";
import { until } from "../test-support/agent-round.js";
import {
  AgentRuntime,
  type RuntimeFact,
  type RuntimePorts,
  type WakeMaterials,
} from "./AgentRuntime.js";
import type { SdkAgent } from "./SdkAgent.js";

// ---------------------------------------------------------------------------
// 一套假的宿主：只有库与能力装配两件事是真的要人做
// ---------------------------------------------------------------------------

interface Harness {
  runtime: AgentRuntime;
  /** 这一段在哪个目录上干活（能力容器按它取） */
  cwd: string;
  /** 造过的容器，按目录顺序（同一个目录只该有一次） */
  opened: string[];
  /** 开的会话，按顺序 */
  created: Array<{ sessionId: string; agentId: string; lineage: string }>;
  /** 模型端点收到的请求，按到达顺序 */
  requests: FakeLlmRequest[];
  wake(sessionId: string, agentId: string, extra?: Partial<WakeMaterials>): Promise<SdkAgent>;
  /** 给这一段起个名字（假库里的那一格） */
  name(sessionId: string, label: string): void;
}

/** each 用完就收：断言失败时也不留下监听与临时目录 */
let disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  const all = disposers;
  disposers = [];
  for (const dispose of all) await dispose();
});

async function harness(options: { reply?: FakeLlmOptions["reply"] } = {}): Promise<Harness> {
  const llm = await startFakeLlm({ reply: options.reply ?? "收到" });
  const dir = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const agentsDir = join(dir, "agents");
  const cwd = join(dir, "project");
  await mkdir(agentsDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeDefinition(agentsDir, "lead", "Lead", "You are the lead.");
  await writeDefinition(agentsDir, "helper", "Helper", "You are the helper.");

  const config: AppConfig = {
    endpoints: [{ id: "e1", name: "fake", baseUrl: llm.baseUrl, apiKey: "fake-key" }],
    models: [
      {
        id: "m1",
        name: "fake-model",
        endpointId: "e1",
        tokenThresholds: { handoff: 100_000, guard: 200_000 },
      },
    ],
    defaultModel: "m1",
  };

  // 假库：只有「这一段叫什么」与「新开一段」两件事，其余都不落任何东西
  const names = new Map<string, string>();
  const opened: string[] = [];
  const created: Harness["created"] = [];
  let seq = 0;

  const ports: RuntimePorts = {
    openScope: async (scopeCwd, peers) => {
      opened.push(scopeCwd);
      // 真实的宿主在这里读能力路径、装一整套插件；这里只装平级会话那三个工具 ——
      // 端口随造容器的请求下来，正是要验的那一处接线
      const scope = new Scope({ getConfig: () => config, agentsDir, cwd: scopeCwd }).use(
        new PeerSessionsScopePlugin(peers),
      );
      await scope.init();
      return scope;
    },
    open: async (input) => {
      const sessionId = `peer-${++seq}`;
      created.push({ sessionId, agentId: input.agentId, lineage: input.lineage });
      names.set(sessionId, input.label ?? input.prompt.slice(0, 12));
      return {
        ok: true,
        sessionId,
        materials: {
          cwd,
          agentId: input.agentId,
          modelId: input.modelId,
          lineage: input.lineage,
          history: [],
          waiting: [],
        },
      };
    },
    nameOf: async (sessionId) => names.get(sessionId),
  };

  const runtime = new AgentRuntime(ports);

  const wake = async (
    sessionId: string,
    agentId: string,
    extra: Partial<WakeMaterials> = {},
  ): Promise<SdkAgent> => {
    if (!names.has(sessionId)) names.set(sessionId, sessionId);
    return runtime.wake(sessionId, {
      cwd,
      agentId,
      lineage: null,
      history: [],
      waiting: [],
      ...extra,
    });
  };

  disposers.push(async () => {
    await runtime.close();
    await llm.close();
    await rm(dir, { recursive: true, force: true });
  });

  return {
    runtime,
    cwd,
    opened,
    created,
    requests: llm.requests,
    wake,
    name: (sessionId, label) => names.set(sessionId, label),
  };
}

async function writeDefinition(
  agentsDir: string,
  id: string,
  name: string,
  system: string,
): Promise<void> {
  const definition: AgentDefinition = {
    id,
    name,
    messages: [Message.System(system)],
    modelId: "m1",
    // 定义上没有 permissions 就是四维全拒（`PermissionEvaluator` 的缺省），这里给的是一份
    // 什么都放行的：要验的是运行时的接线，不是权限
    permissions: { tools: { allow: ["*"] } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(agentsDir, `${id}.json`), JSON.stringify(definition), "utf8");
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 按 system 提示分派答复：两段会话各说各的，才判得出那句话落在谁那边 */
function bySystem(replies: { lead: string; helper: string }) {
  return (body: any): string => {
    const system = String(body?.messages?.[0]?.content ?? "");
    return system.includes("the lead") ? replies.lead : replies.helper;
  };
}

function text(message: AgentNS.Message): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (content === undefined) return "";
  return content.map((section) => (section.type === "text" ? section.text : "")).join("");
}

function words(agent: Agent, needle: string): AgentNS.Message[] {
  return agent.messages.filter((message) => text(message).includes(needle));
}

function toolOf(agent: Agent, name: string): Tool {
  const tool = agent.tools.find((item) => item.function.name === name);
  if (tool === undefined) throw new Error(`tool "${name}" is not on agent "${agent.id}"`);
  return tool;
}

/** 一条事实收窄之后的那一支：只按名字判别，不另造形状 */
type Appeared = Extract<RuntimeFact, { type: "resident:appeared" }>;
type Gone = Extract<RuntimeFact, { type: "resident:gone" }>;
type Added = Extract<RuntimeFact, { type: "inboxAdded" }>;
type Finished = Extract<RuntimeFact, { type: "responseFinished" }>;
type ScopeAppeared = Extract<RuntimeFact, { type: "scope:appeared" }>;
type ScopeRefreshed = Extract<RuntimeFact, { type: "scope:refreshed" }>;
type ScopeGone = Extract<RuntimeFact, { type: "scope:gone" }>;

/**
 * 某一段会话收到的事实，按到达顺序。
 *
 * 能力容器那三格没有会话身份（判据是目录，不是会话），不在这一份里 —— 所以先看它有没有这一格。
 */
function factsOf(facts: readonly RuntimeFact[], sessionId: string): RuntimeFact[] {
  return facts.filter((fact) => "sessionId" in fact && fact.sessionId === sessionId);
}

/** 直接调一次工具（模型那一侧的位置：`ctx.agent` 就是调用它的那个执行体） */
async function callTool(tool: Tool, agent: Agent, args: Record<string, unknown>) {
  const toolCall: AgentNS.ToolCall = {
    id: `call-${Math.random().toString(36).slice(2, 8)}`,
    type: "function",
    function: { name: tool.function.name, arguments: JSON.stringify(args) },
  };
  const ctx = new ToolCallContext({
    agent,
    tool_call: toolCall,
    tool,
    resultMessage: Message.Tool(toolCall),
  });
  return JSON.parse(String(await tool.exec(ctx)));
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("运行时：常驻与互相说话", () => {
  it("一段会话把话寄给另一段：收下了、跑完了、回的那句落在发起方那边", async () => {
    const h = await harness({ reply: bySystem({ lead: "lead 收到", helper: "helper 收到" }) });
    const a = await h.wake("a", "lead");
    const b = await h.wake("b", "helper");
    h.name("a", "会话甲");
    h.name("b", "会话乙");

    expect(await h.runtime.post({ from: "a", to: "b", content: "把测试跑一遍" })).toEqual({
      ok: true,
    });

    // 没有人 await，它自己从闲变成忙、跑完回到闲
    await until(() => b.state === "idle" && words(b, "helper 收到").length > 0, 5000);

    // 收下的是那句话，署名是发起方**现读**的名字
    const heard = words(b, "把测试跑一遍");
    expect(heard).toHaveLength(1);
    expect(text(heard[0]!)).toContain("会话甲");
    expect(heard[0]!.source).toEqual({ kind: "agent", label: "会话甲" });
    // 那句话落在 b 自己的记忆里，a 那边一个字都没多
    expect(words(a, "把测试跑一遍")).toHaveLength(0);

    // 反向：b 回一句，a 收到并回一句 —— 双向都通
    expect(await h.runtime.post({ from: "b", to: "a", content: "跑完了，全绿" })).toEqual({
      ok: true,
    });
    await until(() => a.state === "idle" && words(a, "lead 收到").length > 0, 5000);

    const back = words(a, "跑完了，全绿");
    expect(back).toHaveLength(1);
    expect(back[0]!.source).toEqual({ kind: "agent", label: "会话乙" });
  });

  it("三个工具在没有宿主时也能用：投一句、问一句状态", async () => {
    const h = await harness({ reply: bySystem({ lead: "lead 收到", helper: "helper 收到" }) });
    const a = await h.wake("a", "lead");
    const b = await h.wake("b", "helper");
    h.name("a", "会话甲");

    const sent = await callTool(toolOf(b, POST_MESSAGE_TOOL), b, {
      sessionId: "a",
      content: "从工具这条路寄过去",
    });
    expect(sent).toMatchObject({ accepted: true });

    await until(() => a.state === "idle" && words(a, "lead 收到").length > 0, 5000);
    expect(words(a, "从工具这条路寄过去")).toHaveLength(1);

    // 问状态：只有忙闲、名字与最近一句的摘要，没有全量消息
    const answer = await callTool(toolOf(b, READ_SESSION_STATUS_TOOL), b, { sessionId: "a" });
    expect(answer).toMatchObject({
      found: true,
      status: "idle",
      alive: true,
      label: "会话甲",
      lastMessage: "lead 收到",
    });
    expect(answer.messages).toBeUndefined();
    expect(answer.history).toBeUndefined();
  });

  it("agent 开的会话开不出第二层", async () => {
    const h = await harness({ reply: bySystem({ lead: "lead 收到", helper: "helper 收到" }) });
    const a = await h.wake("a", "lead");

    const created = await callTool(toolOf(a, CREATE_SESSION_TOOL), a, {
      prompt: "写一份报告",
      label: "报告",
    });
    expect(created.sessionId).toBe("peer-1");
    expect(created.label).toBe("报告");
    expect(h.created).toEqual([{ sessionId: "peer-1", agentId: "lead", lineage: "a" }]);

    // 新的一段自己跑起来了：它收到了那句 prompt 并说了一句话
    const child = h.runtime.get("peer-1")!;
    expect(child).toBeDefined();
    await until(() => child.state === "idle" && words(child, "lead 收到").length > 0, 5000);
    expect(words(child, "写一份报告")).toHaveLength(1);

    // 它自己再开一段：拒，而且没有多出第二段会话
    const refused = await callTool(toolOf(child, CREATE_SESSION_TOOL), child, {
      prompt: "再开一段",
    });
    expect(refused).toMatchObject({ rejected: "depth_exceeded" });
    expect(h.created).toHaveLength(1);
  });

  it("唤醒幂等：两个触发方同时叫醒同一段，装出来的只有一个", async () => {
    const h = await harness();

    const [first, second] = await Promise.all([h.wake("a", "lead"), h.wake("a", "lead")]);

    expect(first).toBe(second);
    expect(h.runtime.get("a")).toBe(first);
    expect(h.opened).toEqual([h.cwd]);
  });

  it("恢复：历史接在模板后面，已经在历史里的条目不再放回队列", async () => {
    const h = await harness();
    const landed: AgentNS.Message = {
      ...Message.User("早说过的话"),
      id: "m1",
    };
    const waiting: AgentNS.InboxEntryWithContent[] = [
      {
        messageId: "m1",
        createdAt: new Date().toISOString(),
        priority: "low",
        source: { kind: "user" },
        content: "早说过的话",
      },
      {
        messageId: "m2",
        createdAt: new Date().toISOString(),
        priority: "low",
        source: { kind: "user" },
        content: "还没处理的那句",
      },
    ];

    const a = await h.wake("a", "lead", { history: [landed], waiting });
    await until(
      () => a.state === "idle" && a.messages.some((m) => m.role === AgentNS.Role.Assistant),
      5000,
    );

    // 两句都在，各一份：m1 是历史里那条，不是又被投了一遍
    expect(a.messages.filter((message) => message.id === "m1")).toHaveLength(1);
    expect(a.messages.filter((message) => message.id === "m2")).toHaveLength(1);

    // 发出去的那一份请求里，那句旧话只出现一次
    const sent = JSON.stringify(h.requests[0]!.body.messages);
    expect(count(sent, "早说过的话")).toBe(1);
    expect(count(sent, "还没处理的那句")).toBe(1);
  });

  it("杀死之后不再回应，说过的话还在；投过去会说是哪一条路不通", async () => {
    const h = await harness({ reply: bySystem({ lead: "lead 收到", helper: "helper 收到" }) });
    const a = await h.wake("a", "lead");
    const b = await h.wake("b", "helper");
    h.name("b", "会话乙");

    await h.runtime.post({ from: "a", to: "b", content: "在吗" });
    await until(() => b.state === "idle" && words(b, "helper 收到").length > 0, 5000);
    const said = b.messages.length;

    h.runtime.kill("b");
    expect(h.runtime.get("b")).toBeUndefined();
    expect(h.runtime.aliveOn(h.cwd)).toEqual(["a"]);

    // 会话行还在、只是没人取件 → dead；行都没了 → gone
    expect(await h.runtime.post({ from: "a", to: "b", content: "还在吗" })).toEqual({
      ok: false,
      reason: "dead",
    });
    expect(await h.runtime.post({ from: "a", to: "没这一段", content: "在吗" })).toEqual({
      ok: false,
      reason: "gone",
    });

    // 说过的话还在，而且杀死之后它不再动
    expect(b.messages).toHaveLength(said);
    expect(await h.runtime.status("b")).toEqual({ found: false, status: null });
  });

  it("同一个目录上的两段会话共用一个容器；都杀掉之后才拆得掉", async () => {
    const h = await harness();
    await h.wake("a", "lead");
    await h.wake("b", "helper");

    expect(h.opened).toEqual([h.cwd]);
    expect(h.runtime.aliveOn(h.cwd)).toEqual(["a", "b"]);

    // 还有活执行体时不许拆：拆了就是把正在干活的会话静默杀掉
    await expect(h.runtime.scopes.dispose(h.cwd)).rejects.toThrow(/2 session/);

    h.runtime.kill("a");
    h.runtime.kill("b");
    await h.runtime.scopes.dispose(h.cwd);

    // 拆掉了：下一次要容器是重新造一个
    await h.runtime.scopes.for(h.cwd);
    expect(h.opened).toEqual([h.cwd, h.cwd]);
  });
});

describe("运行时：观察面（只订阅、不介入）", () => {
  it("第三方只订阅就能说清谁活着、谁在干、谁没了", async () => {
    const h = await harness({ reply: "假端点说的那句" });
    const seen: RuntimeFact[] = [];
    h.runtime.observe((fact) => seen.push(fact));

    const a = await h.wake("a", "lead");
    const b = await h.wake("b", "helper");

    // 谁活着：两段各一条「出现」，带目录、血缘（两段都是人建的，所以是 null）与执行体本身
    const appeared = seen.filter((fact): fact is Appeared => fact.type === "resident:appeared");
    expect(appeared.map((fact) => fact.sessionId)).toEqual(["a", "b"]);
    expect(appeared[0]).toMatchObject({ cwd: h.cwd, lineage: null, agent: a });
    expect(appeared[1]).toMatchObject({ cwd: h.cwd, lineage: null, agent: b });

    // 每一段会话的第一条事实就是它自己的「出现」：开跑之后那些一定排在后面
    expect(factsOf(seen, "a")[0]?.type).toBe("resident:appeared");
    expect(factsOf(seen, "b")[0]?.type).toBe("resident:appeared");

    // 谁在干：投一句给 b，入队、变忙、跑完回到闲都收到了
    h.name("a", "会话甲");
    expect(await h.runtime.post({ from: "a", to: "b", content: "把测试跑一遍" })).toEqual({
      ok: true,
    });
    await until(() => b.state === "idle" && words(b, "假端点说的那句").length > 0, 5000);

    const ofB = factsOf(seen, "b");
    expect(ofB.map((fact) => fact.type)).toContain("state:working");
    expect(ofB.map((fact) => fact.type)).toContain("state:idle");

    // 入队那一条的载荷就是寄过去的那句话本身（内核那一侧的形状，原样转出来的）
    const added = ofB.filter((fact): fact is Added => fact.type === "inboxAdded");
    expect(added.length).toBeGreaterThan(0);
    expect(added[0]!.entry.content).toBe("把测试跑一遍");
    expect(added[0]!.entry).toMatchObject({ source: { kind: "agent", label: "会话甲" } });

    // 跑完那一条里的消息正文就是假端点给的那句
    const finished = ofB.filter((fact): fact is Finished => fact.type === "responseFinished");
    expect(finished).toHaveLength(1);
    expect(text(finished[0]!.message)).toBe("假端点说的那句");

    // 谁没了：杀 b，报一条「没了」；此后 b 一条事实都不再有
    h.runtime.kill("b");
    const gone = seen.filter((fact): fact is Gone => fact.type === "resident:gone");
    expect(gone.map((fact) => fact.sessionId)).toEqual(["b"]);

    const marked = seen.length;
    // 让这一段再跑一句走的是用户说话那条路：用户说的话也是一条投递，进执行体的队列
    a.push({ content: "再跑一句", priority: "low", source: { kind: "user" } });
    await until(() => a.state === "idle" && words(a, "假端点说的那句").length > 0, 5000);

    expect(factsOf(seen.slice(marked), "b")).toEqual([]);
    // 对照：这一段的转发照常在，说明「没有 b 的事实」不是因为整条转发停了
    expect(factsOf(seen.slice(marked), "a").length).toBeGreaterThan(0);
  });

  it("退订之后不再收到，退订两次不炸", async () => {
    const h = await harness();
    const seen: RuntimeFact[] = [];
    const off = h.runtime.observe((fact) => seen.push(fact));
    off();
    off();

    const a = await h.wake("a", "lead");
    // 用户说的话也是一条投递，进执行体的队列
    a.push({ content: "跑一句", priority: "low", source: { kind: "user" } });
    await until(() => a.state === "idle" && words(a, "收到").length > 0, 5000);

    // 整个过程中一条事实都没收到
    expect(seen).toEqual([]);
  });

  it("一段会话没了不影响另一段的转发", async () => {
    const h = await harness();
    const seen: RuntimeFact[] = [];
    h.runtime.observe((fact) => seen.push(fact));

    await h.wake("a", "lead");
    const b = await h.wake("b", "helper");

    h.runtime.kill("a");
    const marked = seen.length;

    // 用户说的话也是一条投递，进执行体的队列
    b.push({ content: "跑一句", priority: "low", source: { kind: "user" } });
    await until(() => b.state === "idle" && words(b, "收到").length > 0, 5000);

    const ofB = factsOf(seen.slice(marked), "b").map((fact) => fact.type);
    expect(ofB).toContain("state:working");
    expect(ofB).toContain("state:idle");
  });

  it("订阅者抛错不影响叫醒，也不影响别的订阅者", async () => {
    const h = await harness();
    // 第一个订阅者：见到任何事实就抛。它炸在 `wake` 里面（「这一段出现了」也在同一条路上）
    h.runtime.observe(() => {
      throw new Error("旁路炸了");
    });
    // 第二个订阅者：只计数
    let counted = 0;
    h.runtime.observe(() => {
      counted += 1;
    });

    // 叫醒照常返回：拿得到执行体，而不是一个旁路者的错误
    const a = await h.wake("a", "lead");
    expect(a).toBeDefined();

    // 用户说的话也是一条投递，进执行体的队列 —— 它还活着，跑得完这一句
    a.push({ content: "跑一句", priority: "low", source: { kind: "user" } });
    await until(() => a.state === "idle" && words(a, "收到").length > 0, 5000);

    // 第二个订阅者照常收到事实（一个订阅者炸了不该让别人瞎）
    expect(counted).toBeGreaterThan(0);
    // 登记项就是那个执行体，而且它真的跑完了那一句
    expect(h.runtime.get("a")).toBe(a);
    expect(words(a, "收到").length).toBeGreaterThan(0);
  });
});

describe("运行时的观察面：能力容器", () => {
  it("容器造起来、刷新过、拆掉，三件事都听得见", async () => {
    const h = await harness();
    const seen: RuntimeFact[] = [];
    h.runtime.observe((fact) => seen.push(fact));

    // 出现：叫醒一段，容器随之造出来
    await h.wake("a", "lead");

    const appeared = seen.filter((fact): fact is ScopeAppeared => fact.type === "scope:appeared");
    expect(appeared).toHaveLength(1);
    expect(appeared[0]!.cwd).toBe(h.cwd);
    // 能力快照：这个容器装了平级会话插件，那三个工具都在里面（不必再摸容器去问）
    expect(appeared[0]!.capabilities.tools).toEqual(
      expect.arrayContaining([CREATE_SESSION_TOOL, READ_SESSION_STATUS_TOOL, POST_MESSAGE_TOOL]),
    );

    // 刷新完：配置改了这一侧刷一遍，刷成功之后才报
    await h.runtime.scopes.refreshAll();

    const refreshed = seen.filter(
      (fact): fact is ScopeRefreshed => fact.type === "scope:refreshed",
    );
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]!.cwd).toBe(appeared[0]!.cwd);
    // 形状一致：四个维度都在，而且这一次拿到的还是同一份能力
    expect(Object.keys(refreshed[0]!.capabilities).sort()).toEqual([
      "mcps",
      "skills",
      "subagents",
      "tools",
    ]);
    expect(refreshed[0]!.capabilities).toEqual(appeared[0]!.capabilities);

    // 拆掉：先杀掉这一段（还有活执行体时拆会被拒），再拆
    h.runtime.kill("a");
    await h.runtime.scopes.dispose(h.cwd);

    const gone = seen.filter((fact): fact is ScopeGone => fact.type === "scope:gone");
    expect(gone).toHaveLength(1);
    expect(gone[0]!.cwd).toBe(h.cwd);
  });

  it("同一个目录只报一次出现", async () => {
    const h = await harness();
    const seen: RuntimeFact[] = [];
    h.runtime.observe((fact) => seen.push(fact));

    // 同一个目录上两段会话：容器只有一份，于是「出现」也只有一条
    await h.wake("a", "lead");
    await h.wake("b", "helper");

    expect(h.opened).toEqual([h.cwd]);
    expect(
      seen.filter((fact): fact is ScopeAppeared => fact.type === "scope:appeared"),
    ).toHaveLength(1);
  });
});

/** 一个子串在文本里出现了几次（判「没有重复投递」用） */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
