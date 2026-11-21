/**
 * `session.transient`：一次性会话那条路（`dev-docs/prd/04-session.md`「一次性会话：唯一的逃生窗」）。
 *
 * 这条路是给「一次调用、一个答案、一个退出码」那种调用方（今天头一个是 CLI 的纯 stdio 模式）
 * 用的：投一句、等它跑到闲、把这一次跑出来的消息带回去。它**不是一段会话的第一次运行**，所以
 *
 * - 跑完就能拿到答案（`runOnce` 的返回值原样出去）；
 * - **一个字都不落库**：不建会话行、不建 inbox 行、不写消息表、**也不建项目行** —— 每敲一次
 *   命令行就在库里多一段会话，而一次性会话跑完就散，那些行没有谁会去删，库只增不减。那不是
 *   CLI 该兜的事。
 *
 * 入参因此是 `cwd`，不是 `workspaceId`：认项目的话，项目行必须先在，于是每敲一次 `ai "…"`
 * 就多出一条项目行（会话行没了，垃圾还在），而项目「只走显式添加」。这一条路只拿一个目录去装配
 * 能力容器 —— 下面那个「不查项目行」的用例就是这一条的判据。
 *
 * 台架是「真的那一部分尽量真」：真内存库、真 `SessionService` / `WorkspaceService`、**真的能力
 * 容器**（临时目录上现造，工具真的装得上）、真的 OpenAI 兼容端点（`@ai-zen/agents-testing`，
 * 一句话真的发出去、真的流回来）。只有 `runtime` 是替身 —— 这条路只用它的 `scopes.for` 一格，
 * 它**不该**走 `wake`（那造的是常驻执行体），所以那个口给的是一个调用即炸的函数：真被走到，
 * 用例当场红，而不是安静地又建出一段会话。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { AgentNS, Message } from "@ai-zen/agents-core";
import {
  Scope,
  allInOne,
  type AgentDefinition,
  type AgentRuntime,
  type AppConfig,
} from "@ai-zen/agents-sdk";
import { startFakeLlm, type FakeLlm } from "@ai-zen/agents-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import type { AgentDefinitionService } from "../config/agents.js";
import type { GeneralConfig } from "../config/general.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { inboxTable } from "../agent/inbox.js";
import { messageTable } from "../session/messages.js";
import { SessionService } from "../session/service.js";
import { sessionTable } from "../session/table.js";
import { workspaceTable } from "../workspace/table.js";
import { WorkspaceService } from "../workspace/service.js";
import type { HostApiDeps } from "./deps.js";
import { sessionRouter } from "./session.js";
import { createTrpc } from "./trpc.js";

const WORKSPACE_ID = "ws-1";
const AGENT_ID = "agent-1";

/** 假端点要说的话：回执里最后一条 assistant 的正文就该是它 */
const REPLY = "命令行里的一次性答案";

/**
 * 助手定义：模型绑在定义上（三级解析的第二级），模板里一条 system。
 *
 * 用例里它同时写进磁盘（`createAgent` 从磁盘读）与交给 `definitions` 替身（`modelAndParamsFor`
 * 读同一份）—— 真宿主上那两份本来就是同一份文件，读出来的东西也必须一样。
 */
const DEFINITION: AgentDefinition = {
  id: AGENT_ID,
  name: "助手一",
  modelId: "model-1",
  messages: [Message.System("你是一次性会话，答完就散。")],
  permissions: {
    tools: { allow: ["*"] },
    skills: { allow: ["*"] },
    mcps: { allow: ["*"] },
    subagents: { allow: ["*"] },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

let dir: string;
let fake: FakeLlm;

beforeEach(async () => {
  // 真的临时目录：能力容器的 `cwd` 与 `agentsDir` 都长在它下面，调用时递进去的 `cwd` 也是它
  dir = await mkdtemp(join(tmpdir(), "ai-zen-transient-"));
  fake = await startFakeLlm({ reply: REPLY });
});

afterEach(async () => {
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

/** 这份配置里只有一个模型，端点就是那个假端点 */
function configFor(): AppConfig {
  return {
    defaultModel: "model-1",
    models: [
      {
        id: "model-1",
        name: "模型一",
        endpointId: "ep-1",
        tokenThresholds: { handoff: 100_000, guard: 200_000 },
      },
    ],
    endpoints: [{ id: "ep-1", name: "端点一", baseUrl: fake.baseUrl, apiKey: "test" }],
  } as unknown as AppConfig;
}

/**
 * 这一条路上的几个域。`runtime` 是替身（只给 `scopes.for`），其余能真的都真。
 */
async function newHost() {
  const db = openDatabase(":memory:");
  // 库里一个项目也不建：这条路不查项目行，台架就干脆一行也不放 —— 四条用例全都跑在这个
  // 更严的前提上（少放一行是台架的让步，多了那一行就会把「其实还在认项目」遮住）

  const t = createTranslator(() => "zh");
  const events = createBus<HostEvent>();
  const sessions = new SessionService({ sessions: sessionTable(db), events, t });
  const messages = messageTable(db);
  const inbox = inboxTable(db);
  const workspaces = new WorkspaceService({ workspaces: workspaceTable(db), t });
  const config = configFor();

  // 助手定义真的写到磁盘上：`createAgent` 那一侧只认文件
  const agentsDir = join(dir, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, `${AGENT_ID}.json`), JSON.stringify(DEFINITION, null, 2));

  // 真的能力容器：这条路要造执行体，「工具装不装得上」不能是替身说了算
  const scope = new Scope({
    getConfig: () => config,
    agentsDir,
    cwd: dir,
    deps: { readAsset: () => undefined },
  }).use(...allInOne());
  await scope.init();

  /** 容器是按哪个目录取的：只可能来自入参那个 `cwd`，别的来源都算这一层自己发明了取法 */
  const asked: string[] = [];

  const runtime = {
    scopes: {
      for: async (cwd: string) => {
        asked.push(cwd);
        return scope;
      },
    },
    // 这条路不该唤醒常驻执行体：真被走到就当场红（而不是安静地建出一段会话）
    wake: () => {
      throw new Error("session.transient 不该走 runtime.wake：那造的是常驻执行体");
    },
  } as unknown as AgentRuntime;

  const deps = {
    sessions,
    workspaces,
    messages,
    inbox,
    runtime,
    events,
    t,
    config: { read: () => config, presets: async () => ({}) } as unknown as GeneralConfig,
    definitions: { get: async () => DEFINITION } as unknown as AgentDefinitionService,
    assetPort: { readAsset: () => undefined },
    // 一次性会话不装自动交接（它没有会话行），这一格一次都不该被碰到
    handoff: {} as never,
  } as unknown as HostApiDeps;

  const api = createTrpc(t);
  const router = api.router({ session: sessionRouter(deps, api) });
  const caller = router.createCaller({});

  return { db, sessions, messages, inbox, caller, scope, asked };
}

type Host = Awaited<ReturnType<typeof newHost>>;

/** 某张表现在有几行：这条路上要验的就是「零行」 */
function countRows(
  db: DatabaseSync,
  table: "messages" | "inbox" | "sessions" | "workspaces",
): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint };
  return Number(row.n);
}

describe("一次性会话跑一次", () => {
  it("答案回来：回执里最后一条 assistant 的正文就是假端点说的那句", async () => {
    const host = await newHost();

    const { messages } = await host.caller.session.transient({
      cwd: dir,
      agentId: AGENT_ID,
      content: "你好",
    });

    // 回执是 `runOnce` 的返回值原样：这一次跑出来的那几条（模板 + 这一句 + 答案）
    expect(messages.at(-1)?.role).toBe(AgentNS.Role.Assistant);
    expect(messages.at(-1)?.content).toBe(REPLY);
    // 那一句真的走出去了：假端点收到一次请求，正文里就是投进去的那句话
    expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(fake.requests[0]?.body.messages)).toContain("你好");
    // 容器是按入参那个 `cwd` 取的（能力容器按目录一份，这一步只能由宿主给）
    expect(host.asked).toEqual([dir]);
  });

  it("一个字都不落库：会话空、消息表空、排队表空", async () => {
    const host = await newHost();

    await host.caller.session.transient({
      cwd: dir,
      agentId: AGENT_ID,
      content: "你好",
    });

    // 这一段话没有产生任何一段会话：库里一张行都没有
    await expect(host.caller.session.list({ workspaceId: WORKSPACE_ID })).resolves.toEqual([]);
    expect(countRows(host.db, "sessions")).toBe(0);
    // 消息与排队区同样一个字都没有：这条路不建 inbox 行、不写消息表
    expect(countRows(host.db, "messages")).toBe(0);
    expect(countRows(host.db, "inbox")).toBe(0);
  });

  it("多模态照收：内容给成段数组也照跑（宿主不拦，正文原样发出去）", async () => {
    const host = await newHost();

    const content: AgentNS.MessageContentSection[] = [
      { type: "text", text: "看这张图" },
      // 一小段假字节：这一条验的是「段数组能过」，不是真发一张图（宿主不拦、也不读素材库）
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
    ];

    const { messages } = await host.caller.session.transient({
      cwd: dir,
      agentId: AGENT_ID,
      content,
    });

    expect(messages.at(-1)?.role).toBe(AgentNS.Role.Assistant);
    expect(messages.at(-1)?.content).toBe(REPLY);
    // 两段都到了端点那一侧：文字段与图片段都不许被宿主吞掉或改写
    const sent = JSON.stringify(fake.requests[0]?.body.messages);
    expect(sent).toContain("看这张图");
    expect(sent).toContain("iVBORw0KGgo=");
    // 多模态这一趟同样一个字都不落库
    expect(countRows(host.db, "messages")).toBe(0);
  });

  it("不查项目行：给一个没有项目的目录也照跑（库里一个项目都没有，会话表仍 0 行）", async () => {
    const host = await newHost();

    // 一个库里没有项目、磁盘上也不存在的目录（中间还夹了一段 `..`）：这条路既不该因此拒绝，
    // 也不该把两种写法当成两个目录
    const nowhere = join(dir, "没有项目的目录", "..", "没有项目的目录");

    const { messages } = await host.caller.session.transient({
      cwd: nowhere,
      agentId: AGENT_ID,
      content: "你好",
    });

    // 照跑：答案跟别的用例一样回来了
    expect(messages.at(-1)?.role).toBe(AgentNS.Role.Assistant);
    expect(messages.at(-1)?.content).toBe(REPLY);
    expect(fake.requests).toHaveLength(1);
    // 容器是按归一化之后的目录取的（与 `WorkspaceService.create` 同一个口径，只归一化一次）
    expect(host.asked).toEqual([join(dir, "没有项目的目录")]);
    // 库里一个项目都没有，却一个字都没多出来：会话 0 行，项目也 0 行
    expect(countRows(host.db, "sessions")).toBe(0);
    expect(countRows(host.db, "workspaces")).toBe(0);
  });
});
