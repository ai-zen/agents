/**
 * PeerSession 这条链路的宿主级验收：一段真的会话从自己的 Scope 里取出 `create_session`、真的执行它，
 * 再用 `post_message` 往新开的那一段会话投一句话；反过来也投一次；再验两条投递被拒，以及
 * 「agent 开出来的会话手上没有 `create_session`」。
 *
 * 为什么要这一条：sdk 的那两个文件分别验了「运行时怎么登记与投递」与「三个工具怎么认端口」，而
 * 宿主这一侧的接线（`app.ts` 里 `openScope` 与 `open` 这两个端口）此前没有任何用例走过 —— 端口
 * 接错、血缘与自动交接的初值写反、投递没落到排队区，sdk 那边照样是绿的。
 *
 * 模型不发起工具调用（假端点只回文本）：工具实例是从 Agent 手上取出来的，与 core 在模型发起工具
 * 调用时拿到的是同一个（`tool.exec(ctx)`），验的正是宿主的接线。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentNS } from "@ai-zen/agents-core";
import { Message, ToolCallContext } from "@ai-zen/agents-core";
import type { Agent, Tool } from "@ai-zen/agents-core";
import {
  CREATE_SESSION_TOOL,
  PEER_SESSION_TOOL_NAMES,
  POST_MESSAGE_TOOL,
  READ_SESSION_STATUS_TOOL,
} from "@ai-zen/agents-sdk";
import { startFakeLlm, type FakeLlm } from "@ai-zen/fake-llm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { HostApp } from "./app.js";
import { openDatabase } from "./infra/db.js";
import type { SessionRecord } from "./modules/session/types.js";
import { workspaceTable } from "./modules/workspace/table.js";

/** 假端点回的这句话：两段会话说同一句就够，判据是「话落在谁那边」 */
const REPLY = "收到。";

/** 开新会话时交给它的活 */
const PEER_TASK = "把这套测试跑一遍，全绿了告诉我。";
/** 发起方投给新那一段会话的内容 */
const TO_PEER = "顺带把类型检查也跑一下。";
/** 新那一段会话投回发起方的内容 */
const TO_LEAD = "跑完了，全绿。";

/** 两段会话各自的名字：正文里那一行署名按会话行上的名字解析，所以先给它们起个读得出来的名字 */
const LEAD_NAME = "会话甲";
const PEER_LABEL = "跑测试";

/** tRPC over WebSocket 的一帧。协议只有这么几格，`@trpc/client` 不在依赖里 */
interface Envelope {
  readonly id: number | null;
  readonly result?: { readonly type?: string; readonly data?: unknown };
  readonly error?: { readonly message?: string };
}

/**
 * 只做 query / mutation 的连接。
 *
 * 这条用例每一步都是「调一次、拿一次答复」；事件流那一侧有别的用例在看，这里不重复实现订阅。
 */
class HostClient {
  private id = 0;
  private readonly waiting = new Map<number, (message: Envelope) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Envelope;
      if (message.id === null) return;
      this.waiting.get(message.id)?.(message);
    });
  }

  static connect(port: number, token: string): Promise<HostClient> {
    // 带 `connectionParams=1` 时服务端才等握手帧再建上下文：凭证只在那一帧上
    const socket = new WebSocket(`ws://127.0.0.1:${port}?connectionParams=1`);
    return new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            id: null,
            jsonrpc: "2.0",
            method: "connectionParams",
            data: { token },
          }),
        );
        resolve(new HostClient(socket));
      });
    });
  }

  query<T>(path: string, input: unknown): Promise<T> {
    return this.call<T>("query", path, input);
  }

  mutation<T>(path: string, input: unknown): Promise<T> {
    return this.call<T>("mutation", path, input);
  }

  close(): void {
    this.socket.close();
  }

  private call<T>(method: "query" | "mutation", path: string, input: unknown): Promise<T> {
    this.id += 1;
    const id = this.id;
    const answered = new Promise<Envelope>((resolve) => this.waiting.set(id, resolve));
    this.socket.send(JSON.stringify({ id, jsonrpc: "2.0", method, params: { path, input } }));

    return answered.then((message) => {
      this.waiting.delete(id);
      if (message.error !== undefined) throw new Error(message.error.message ?? "调用被拒");
      return message.result?.data as T;
    });
  }
}

/** `session.open` 回来的那几格；用例只断言用得上的 */
interface Opened {
  readonly session: SessionRecord;
  readonly live: {
    readonly state: string;
    readonly inputPaused: boolean;
    readonly outputPaused: boolean;
  } | null;
  readonly messages: AgentNS.Message[];
  readonly inbox: readonly AgentNS.InboxEntry[];
}

/** 消息正文可能是多模态段数组，这条用例投的都是纯文本 */
function textOf(message: AgentNS.Message): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (content === undefined) return "";
  return content.map((section) => (section.type === "text" ? section.text : "")).join("");
}

/** 排队区 InboxEntry 的正文：与消息同一种形状 */
function entryText(entry: AgentNS.InboxEntry): string {
  return typeof entry.content === "string" ? entry.content : "";
}

/** Agent 手上那一个工具；不在就是装配错了，当场说清是哪一个 */
function toolOf(agent: Agent, name: string): Tool {
  const tool = agent.tools.find((item) => item.function.name === name);
  if (tool === undefined) throw new Error(`Agent手上没有 "${name}" 这个工具`);
  return tool;
}

/** Agent 手上这批工具的名字 */
function toolNamesOf(agent: Agent): string[] {
  return agent.tools.map((tool) => tool.function.name);
}

/**
 * 调一次工具：`ctx` 与 core 在模型发起工具调用时造的是同一个形状，`ctx.agent` 就是那个 Agent
 * （端口据此认领「哪一段会话在说话」）。
 */
async function callTool(tool: Tool, agent: Agent, args: Record<string, unknown>): Promise<any> {
  const toolCall: AgentNS.ToolCall = {
    id: `call-${randomUUID()}`,
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

describe("平级会话：工具从容器里出来，话真的投到了对面", () => {
  const workspaceId = randomUUID();
  /** 另一个项目：新开的那一段会话跟的是开出它的那一段，不该跑到这里来 */
  const otherWorkspaceId = randomUUID();
  let dataRoot: string;
  let previousHome: string | undefined;
  let llm: FakeLlm;
  let app: HostApp;
  let client: HostClient;
  /** 先有的那一段会话（扮演人建的那一段） */
  let leadId: string;
  /** 由它开出来的那一段会话 */
  let peerId: string;

  /** 这一段此刻什么样：有 Agent 时消息与排队区从它的内存读，没有才读库 */
  const opened = (sessionId: string): Promise<Opened> =>
    client.query<Opened>("session.open", { sessionId });

  /** 这一段 Agent 的工具（宿主装配出来的那一份，不是替身） */
  const agentOf = (sessionId: string): Agent => {
    const agent = app.runtime.get(sessionId);
    if (agent === undefined) throw new Error(`会话 "${sessionId}" 没有Agent`);
    return agent;
  };

  /** 等到这次探查看得见的东西出现（不固定 sleep，超时就抛） */
  const until = (probe: () => Promise<void>, timeout = 20_000): Promise<void> =>
    vi.waitFor(probe, { timeout, interval: 20 });

  beforeAll(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ai-zen-peer-"));
    llm = await startFakeLlm({ reply: REPLY });

    writeFileSync(
      join(dataRoot, "config.json"),
      JSON.stringify(
        {
          endpoints: [
            { id: "local", name: "Local", baseUrl: llm.baseUrl, apiKey: "local-test-key" },
          ],
          models: [
            {
              id: "local-model",
              name: "Local",
              endpointId: "local",
              modelName: "local-model",
              tokenThresholds: { handoff: 250_000, guard: 375_000 },
              custom: true,
            },
          ],
          defaultModel: "local-model",
          language: "zh",
        },
        null,
        2,
      ),
    );

    mkdirSync(join(dataRoot, "agents"), { recursive: true });
    writeFileSync(
      join(dataRoot, "agents", "default.json"),
      JSON.stringify(
        {
          id: "default",
          name: "Default Assistant",
          modelId: "local-model",
          messages: [Message.System("You are a test assistant.")],
          permissions: {
            tools: { allow: ["*"] },
            skills: { allow: ["*"] },
            mcps: { allow: ["*"] },
            subagents: { allow: ["*"] },
          },
          custom: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    // 项目行直接写进表（不走 `workspace.create`）：这条用例要看的是 PeerSession 落哪一行，
    // 从 procedure 建项目只会让这一串里多绕一层与它无关的东西
    const db = openDatabase(join(dataRoot, "ai-zen.db"));
    for (const [id, name] of [
      [workspaceId, "用例项目"],
      [otherWorkspaceId, "另一个项目"],
    ] as const) {
      const cwd = join(dataRoot, id);
      mkdirSync(cwd, { recursive: true });
      workspaceTable(db).put({ id, name, cwd, createdAt: Date.now() });
    }
    db.close();

    process.env.AI_ZEN_DIR = dataRoot;
    // 主目录那几层也指到临时目录：否则会去读开发机的 `~/.agents`，结果跟着机器变
    previousHome = process.env.HOME;
    process.env.HOME = join(dataRoot, "home");

    app = await HostApp.open({ port: 0, exit: () => undefined });
    await app.start();
    const token = readFileSync(join(dataRoot, "run", "token"), "utf8").trim();
    client = await HostClient.connect(app.address.port, token);
  }, 60_000);

  afterAll(async () => {
    client?.close();
    await app?.stop();
    await llm?.close();
    delete process.env.AI_ZEN_DIR;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dataRoot, { recursive: true, force: true });
  }, 60_000);

  it("先有一段真的会话：一行落库、Agent在跑、它手上有那三个工具", async () => {
    // 建行、叫起来、投一句：三件事各有一条口
    const created = await client.mutation<{ session: { id: string } }>("session.create", {
      workspaceId,
      agentId: "default",
    });
    leadId = created.session.id;
    await client.mutation("runtime.agent.wake", { sessionId: leadId });
    await client.mutation("runtime.agent.send", {
      workspaceId,
      agentId: "default",
      sessionId: leadId,
      content: "先在这儿说一句话。",
      messageId: randomUUID(),
    });

    // 等到模型真的答过一句：只看 `state` 的话，投递与取走之间那一拍也会报闲
    await until(async () => {
      const view = await opened(leadId);
      expect(view.messages.some((message) => textOf(message) === REPLY)).toBe(true);
    });

    const view = await opened(leadId);
    // 人建的这一段：没有血缘，自动交接默认关
    expect(view.session.lineage).toBeNull();
    expect(view.session.autoHandoff).toBe(false);

    // 名字按会话行上的那一格解析（投递的署名读的就是它），先给它起一个读得出来的
    await client.mutation("session.rename", { sessionId: leadId, name: LEAD_NAME });

    // 宿主真的把端口装成了工具：三个都在
    const names = toolNamesOf(agentOf(leadId));
    for (const name of PEER_SESSION_TOOL_NAMES) expect(names).toContain(name);
  }, 60_000);

  it("执行 create_session：新的一段会话落库、血缘指回来、自动交接为真、项目跟着走", async () => {
    const lead = agentOf(leadId);
    const created = await callTool(toolOf(lead, CREATE_SESSION_TOOL), lead, {
      prompt: PEER_TASK,
      label: PEER_LABEL,
    });

    // 回执只有两格：新那一段会话的 id 与可读的名字
    expect(created.rejected).toBeUndefined();
    expect(created.label).toBe(PEER_LABEL);
    peerId = String(created.sessionId);

    // 会话行真的落了库（`session.list` 读的就是库里的表）
    const rows = await client.query<SessionRecord[]>("session.list", { workspaceId });
    const peer = rows.find((row) => row.id === peerId);
    expect(peer).toBeDefined();
    expect(peer!.lineage).toBe(leadId);
    expect(peer!.autoHandoff).toBe(true);
    // 项目跟着开出它的那一段会话走，不是跟着客户端手里那个项目走
    expect(peer!.workspaceId).toBe(workspaceId);
    expect(peer!.name).toBe(PEER_LABEL);
    expect(peer!.nameIsAuto).toBe(false);
    // 另一个项目里一行都没有多出来
    expect(
      await client.query<SessionRecord[]>("session.list", { workspaceId: otherWorkspaceId }),
    ).toEqual([]);

    // 那一段自己跑起来了：交给它的那句话成了它的第一条用户消息
    await until(async () => {
      const view = await opened(peerId);
      expect(view.live).not.toBeNull();
      expect(
        view.messages.some(
          (message) => message.role === "user" && textOf(message).includes(PEER_TASK),
        ),
      ).toBe(true);
    });
  }, 60_000);

  it("agent 开出来的会话手上没有 create_session：投递与问状态那两个还在", async () => {
    const names = toolNamesOf(agentOf(peerId));

    // 防套娃的判据是「没有那个工具」，不是「调了会被拒」
    expect(names).not.toContain(CREATE_SESSION_TOOL);
    expect(names).toContain(POST_MESSAGE_TOOL);
    expect(names).toContain(READ_SESSION_STATUS_TOOL);
  }, 60_000);

  it("投给那一段会话的一句话进它的排队区，取走之后成了一条署名的用户消息", async () => {
    const lead = agentOf(leadId);

    // 关掉它的输出开关：这句话就停在排队区里，看得见（开着的时候它一取就走）
    await client.mutation("runtime.agent.pauseOutput", { sessionId: peerId });
    expect((await opened(peerId)).live?.outputPaused).toBe(true);

    const accepted = await callTool(toolOf(lead, POST_MESSAGE_TOOL), lead, {
      sessionId: peerId,
      content: TO_PEER,
    });
    // 回执只有「收下了」这一件事
    expect(accepted).toMatchObject({ accepted: true });
    expect(accepted.hint).toContain("inbox");

    // 排队区里有它：这一段有 Agent，所以读的是它的内存（`session.open` 就是这么读的）
    const paused = await opened(peerId);
    expect(paused.inbox.map(entryText)).toContain(TO_PEER);

    await client.mutation("runtime.agent.resumeOutput", { sessionId: peerId });

    // 开开关之后它取走，这句话成了它自己记忆里的一条用户消息，署名是发起方那一格现读的名字
    await until(async () => {
      const view = await opened(peerId);
      const heard = view.messages.filter((message) => textOf(message).includes(TO_PEER));
      expect(heard).toHaveLength(1);
      expect(heard[0]!.role).toBe("user");
      expect(heard[0]!.source).toEqual({ kind: "agent", label: LEAD_NAME });
    });

    // 取走之后排队区里就没有了
    const after = await opened(peerId);
    expect(after.inbox.map(entryText)).not.toContain(TO_PEER);
  }, 60_000);

  it("反向：那一段会话也能投回开它的那一段", async () => {
    await client.mutation("runtime.agent.pauseOutput", { sessionId: leadId });
    expect((await opened(leadId)).live?.outputPaused).toBe(true);

    const peer = agentOf(peerId);
    const accepted = await callTool(toolOf(peer, POST_MESSAGE_TOOL), peer, {
      sessionId: leadId,
      content: TO_LEAD,
    });
    expect(accepted).toMatchObject({ accepted: true });

    const paused = await opened(leadId);
    expect(paused.inbox.map(entryText)).toContain(TO_LEAD);

    await client.mutation("runtime.agent.resumeOutput", { sessionId: leadId });

    await until(async () => {
      const view = await opened(leadId);
      const heard = view.messages.filter((message) => textOf(message).includes(TO_LEAD));
      expect(heard).toHaveLength(1);
      expect(heard[0]!.role).toBe("user");
      expect(heard[0]!.source).toEqual({ kind: "agent", label: PEER_LABEL });
    });
  }, 60_000);

  it("投不出去的两条都回给发起方那一次工具调用：没有这一段 / 这一段已经死了", async () => {
    const lead = agentOf(leadId);
    const post = toolOf(lead, POST_MESSAGE_TOOL);

    // 没有这一段：随手的 id 在库里找不着
    const gone = await callTool(post, lead, { sessionId: randomUUID(), content: "在吗" });
    expect(gone).toMatchObject({ rejected: "gone" });
    expect(gone.hint).toContain("Nothing was sent");

    // 这一段已经死了：行还在，Agent 没了
    const doomed = await callTool(toolOf(lead, CREATE_SESSION_TOOL), lead, {
      prompt: "这一段会被杀掉。",
      label: "待杀",
    });
    const doomedId = String(doomed.sessionId);
    await client.mutation("runtime.agent.kill", { sessionId: doomedId });
    const rows = await client.query<SessionRecord[]>("session.list", { workspaceId });
    expect(rows.some((row) => row.id === doomedId)).toBe(true);

    const dead = await callTool(post, lead, { sessionId: doomedId, content: "还在吗" });
    expect(dead).toMatchObject({ rejected: "dead" });
    expect(dead.hint).toContain("Nothing was sent");

    // 那句话没有落进它的排队区（拒不是静默收下）：这一段没有 Agent，读的就是库里那几行
    const after = await opened(doomedId);
    expect(after.live).toBeNull();
    expect(after.inbox.map(entryText)).not.toContain("还在吗");
  }, 60_000);
});
