/**
 * 交接的验收：谁写文档（自交接＝同一个 agent 接着写 / 独立摘要＝拿这段记忆去问模型）、文档真的落进
 * `<cwd>/.ai-zen/handoffs/`（D19）、模板来自磁盘上的 `handoff` Skill（读不到用兜底）、
 * 降级要说明（F-D7）、取消不报错（F-D7）、换记忆与存档会话（PRD 4.5）、只产文档不另开会话（F-D4）。
 *
 * 四件口径：
 *
 * 1. `start()` 只回「已经开始」，那一趟在后台跑。所以每个用例都靠那条**摘牌**（`endHandoff`，
 *    `runToEnd` 的 `finally` 里最后一个动作）等它收尾 —— 提交与回滚都从那里过去，于是「跑完了没有」
 *    这件事有一个确定的答案，而不是靠睡一会儿。只看 `memory_replaced` 不够：那条在提交点就推了，
 *    后面还有 `afterCommit`（开新会话 / 标压缩 / 把题标已答）。
 * 2. 「写完了没有」由 SDK 判（那次写文档的工具调用的输入与结果）；宿主只做提交之后那一半 ——
 *    文档在盘上、够长，就换记忆。
 * 3. 入口判据只有一条：**那段会话闲着才发起**。非空闲（忙 / 暂停 / 没有 agent）直接拒，
 *    交接全程不碰暂停、也不替谁放行。
 * 4. 提交之后**旧记忆是另一段会话**（`已存档_<原名>`）、原会话只留「系统提示 + 断点消息」；
 *    而「换完之后记忆长什么样」是**SDK 算的**（宿主不拼断点、不量文档长短，PRD 4.5），
 *    库里那几条语句仍在同一批里，失败一段存档会话都不留。
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentNS, Message } from "@ai-zen/agents-core";
import { completeOnce, ConfigManager } from "@ai-zen/agents-sdk";
import { AutoMigratePlugin } from "@ai-zen/agents-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ChatEventEmitter, ChatAgent } from "../runtime/ChatRunner.js";
import { createFakeScope, FakeAgent, flushMicrotasks } from "../runtime/TestSupport.js";
import type { FakeRound } from "../runtime/TestSupport.js";
import type { AgentBuildContext, AgentFactory } from "../runtime/ChatRunner.js";
import { AssetRepository } from "../storage/AssetRepository.js";
import { SessionRepository } from "../storage/SessionRepository.js";
import { Database } from "../storage/Database.js";
import { MessageRepository } from "../storage/MessageRepository.js";
import { NoticeRepository } from "../storage/NoticeRepository.js";
import { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import { migrate } from "../storage/migrations.js";
import type { SessionPresence } from "../wire/index.js";
import type { SessionChangedPayload } from "../wire/events.js";
import type { SessionRuntimePort } from "./SessionService.js";
import { SessionService } from "./SessionService.js";
import {
  createSdkHandoffExecutor,
  createSdkHandoffService,
  HandoffCancelledError,
  HandoffDocumentService,
  handoffDirFor,
} from "./HandoffDocumentService.js";
import type {
  HandoffAgentHolder,
  HandoffExecutor,
  HandoffRunnerPort,
} from "./HandoffDocumentService.js";
import { NoticeService } from "./NoticeService.js";

/** 摘要模式用的假客户端：把「指令 + 正文」回声出来，于是一眼能看出模板来自哪一份 */
type SummaryClient = Parameters<typeof completeOnce>[0]["client"];

/** 文档正文（要过 400 字节那道坎，所以写长一点） */
const DOCUMENT_BODY = `## 任务目标\n\n把交接写完。\n\n${"正文。".repeat(200)}`;

/** agent 开局手里那条系统提示（来自助手定义）：换记忆之后它得还在 */
const DRIVER_SYSTEM_PROMPT = "你是这个项目的助手";

/** 摘要那一跳的请求体（用例据此看「拿的是什么记忆去问的」） */
type SummaryBody = { messages: Array<{ role: string; content: string }> };

function echoingClient(onRequest?: (body: SummaryBody) => void): SummaryClient {
  const client = {
    chat: {
      completions: {
        create: async (body: SummaryBody) => {
          onRequest?.(body);
          return {
          choices: [
            {
              message: {
                content: `${body.messages[0]?.content ?? ""}\n\n## Handoff from the model\n\n${DOCUMENT_BODY}`,
              },
            },
          ],
          };
        },
      },
    },
  };
  return client as unknown as SummaryClient;
}

/** 会话服务要的那个窄接口：交接用例不需要临时模型 / 临时档位，也没有活着的 agent */
class FakeRuntime implements SessionRuntimePort {
  presence(): SessionPresence {
    // 没有 agent（死的）：忙闲报 `idle`（没有人，手上当然没活）、两道闸没关着
    return { status: "idle", inputPaused: false, outputPaused: false, alive: false };
  }
  inboxPending(): number {
    return 0;
  }
  forget(): void {}
  /** 没有 agent（死格）：换模型 / 换档位那条路对这一段永远放行 */
  agentState(): AgentNS.AgentState | null {
    return null;
  }
  invalidateAgent(): void {}
}

/** 记账的 agent：它就是 core 的 `Agent`（真的循环、真的取件），把「翻上/翻回不取件开关」接过来记一笔 */
class RecordingAgent extends FakeAgent {
  readonly calls: string[] = [];
  /**
   * 助手定义（真实 SDK 里 `definition.messages` 就是 `messages` 开头那几条，`createAgent` 拷进去的）。
   *
   * 交接换记忆时 SDK 拿它当模板（换完还得在的那几条）；不提供就会把系统提示当成旧记忆剔掉。
   */
  readonly definition: { messages: AgentNS.Message[] };

  constructor(
    rounds: FakeRound[] = [],
    options: { system?: string } = {},
  ) {
    super(rounds, options);
    this.definition = { messages: this.messages.slice(0, options.system === undefined ? 0 : 1) };
  }

  override pauseOutput(): void {
    this.calls.push("pauseOutput");
    super.pauseOutput();
  }

  override resumeOutput(): void {
    this.calls.push("resumeOutput");
    super.resumeOutput();
  }
}

/** 一份事件记录（用例靠 `memory_replaced` 等交接收尾） */
interface EventLog {
  events: Array<{ name: string; payload: unknown }>;
  changed: SessionChangedPayload[];
  settled: Promise<void>;
}

function watchEvents(): { log: EventLog; emit: ChatEventEmitter } {
  const events: Array<{ name: string; payload: unknown }> = [];
  const changed: SessionChangedPayload[] = [];
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const emit: ChatEventEmitter = (name, payload) => {
    events.push({ name, payload });
    if (name === "session.changed") {
      const fact = payload as SessionChangedPayload;
      changed.push(fact);
      // 提交与回滚都会推这一条：它就是这个服务「这一趟收尾了」的唯一信号
      if (fact.change === "memory_replaced") settle();
    }
  };
  return { log: { events, changed, settled }, emit };
}

/** 一次交接的跑法：起一趟、等它收尾 */
interface Built {
  service: HandoffDocumentService;
  driver: RecordingAgent;
  driverCalls: string[];
  runnerCalls: string[];
  /** 投出去的指令（SDK 投的：从 agent 的消息里认出来，一条一条看得到） */
  instructions: string[];
  events: EventLog;
  /**
   * 一次交接的跑法：起一趟、等它收尾。
   *
   * 「收尾了」= 挂的那块牌子摘了（`endHandoff`）：它是 `runToEnd` 的 `finally` 里最后一步，
   * 四条结局（成功 / 降级 / 失败 / 取消）都从那里过。不能只看 `memory_replaced` —— 那条在**提交点**
   * 就推了，而它后面还有 `afterCommit`（开新会话 / 标压缩 / 把题标已答），以及在 `finally` 里的
   * 截记忆与摘牌：停在那里断言等于只测了一半（而 `afterCommit` 里的差错是吞掉上报的，看不见）。
   */
  settle(): Promise<void>;
}

interface Harness {
  dir: string;
  projectDir: string;
  skillsDir: string;
  db: Database;
  sessions: SessionRepository;
  messages: MessageRepository;
  sessionService: SessionService;
  build(options?: {
    execute?: HandoffExecutor;
    notices?: NoticeService;
    driver?: RecordingAgent;
    /** agent 的持有者（缺省就是手上这个 driver；给 `{ get: () => undefined }` 验「没有 agent」那条） */
    holder?: HandoffAgentHolder;
    /** 交接模板的查找目录（不给就用磁盘上那份 Skill） */
    skillDirs?: string[];
  }): Built;
}

const SKILL_MARKER = "SKILL-MARKER-交接规范";

let dir: string;
let projectDir: string;
let skillsDir: string;
let db: Database;
let configPath: string;
let workspaces: WorkspaceRepository;
let sessions: SessionRepository;
let messages: MessageRepository;

/**
 * 静态那一份：库 + `config.json` + `agents/a1.json` + 磁盘上的 handoff Skill。
 * 这些都是「一个文件一个库」下真正只需准备一次的东西。
 */
async function prepareStatic(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-handoff-"));
  projectDir = join(dir, "project");
  await mkdir(projectDir, { recursive: true });

  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);

  workspaces = new WorkspaceRepository(db);
  sessions = new SessionRepository(db);
  messages = new MessageRepository(db);

  configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      endpoints: [{ id: "e1", name: "端点一", baseUrl: "https://example.test/v1", apiKey: "k" }],
      models: [{ id: "m1", name: "模型一", endpointId: "e1" }],
      defaultModel: "m1",
      defaultAgent: "a1",
    }),
    "utf-8",
  );
  await mkdir(join(dir, "agents"), { recursive: true });
  await writeFile(
    join(dir, "agents", "a1.json"),
    JSON.stringify({
      id: "a1",
      name: "助手一",
      modelId: "m1",
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    "utf-8",
  );
  // 磁盘上的 handoff Skill：正常路径下模板来自它（读不到才用 SDK 的兜底模板）
  skillsDir = join(dir, "skills");
  await mkdir(join(skillsDir, "handoff"), { recursive: true });
  await writeFile(
    join(skillsDir, "handoff", "SKILL.md"),
    [
      "---",
      "name: handoff",
      "description: 交接规范",
      "---",
      "",
      SKILL_MARKER,
      "",
      "## 任务目标",
      "## 当前状态",
    ].join("\n"),
    "utf-8",
  );
}

/**
 * 每用例那一份：项目行、一段有内容的会话，以及实例级状态（Scope 记账、agent 上下文、
 * 会话服务的草稿表）。库与配置不在这里重做。
 */
async function seedHarness(): Promise<Harness> {
  await workspaces.create({ id: "w1", name: "项目一", cwd: projectDir, createdAt: 1 });

  const sessionService = new SessionService({
    sessions,
    messages,
    workspaces,
    assets: new AssetRepository(db),
    // 侧栏那一个数现读内存（题不落库）——这里只给一个「没有题挂着」的口
    questions: { countPending: () => 0 },
    configManager: new ConfigManager(configPath),
    runtime: new FakeRuntime(),
    now: () => 1_700_000_000_000,
  });

  const created = await sessionService.create({ workspaceId: "w1", agentId: "a1" });
  if (!created.session) throw new Error("session.create 没有建出会话");
  const sessionId = created.session.id;
  // R56：`create` 只发 id，落库发生在首次 `send`；夹具里直接落库（后面要往它名下写消息）
  await sessionService.ensurePersisted(sessionId);

  // 一段有内容的会话：用户说一句 + 助手回一句
  await messages.upsertMany([
    {
      id: "msg-user",
      sessionId,
      role: AgentNS.Role.User as string,
      status: AgentNS.MessageStatus.Completed as string,
      content: "帮我看看这个仓库的测试为什么慢",
      createdAt: 1_700_000_001_000,
    },
    {
      id: "msg-assistant",
      sessionId,
      role: AgentNS.Role.Assistant as string,
      status: AgentNS.MessageStatus.Completed as string,
      content: "慢在 storage 的每个用例都新开库。",
      createdAt: 1_700_000_002_000,
    },
  ]);

  const harness: Harness = {
    dir,
    projectDir,
    skillsDir,
    db,
    sessions,
    messages,
    sessionService,
    build: (options = {}) => {
      /**
       * agent 的脚本：先要一次写工具调用，工具跑完再回一句「写好了」。
       *
       * 那次调用的参数按**这一次请求体**现算：文档路径写在刚推进去的交接指令里，模型（脚本）
       * 那一刻才看得见它，于是它写的就是服务要的那一份。`write` 工具是真写盘的那个（见
       * `TestSupport`），所以「盘上有没有这份文档」是事实，不是演出来的。
       */
      const body = DOCUMENT_BODY;
      const rounds: FakeRound[] = [
        {
          deltas: [{ content: "这就写" }],
          toolCalls: [
            {
              id: "call-write",
              name: "write",
              arguments: (request: any) => {
                const path = documentPathFrom(String(request?.messages?.at(-1)?.content ?? ""));
                return JSON.stringify({ path, content: body });
              },
            },
          ],
        },
        { deltas: [{ content: "写好了" }] },
      ];
      const driver = options.driver ?? new RecordingAgent(rounds, { system: DRIVER_SYSTEM_PROMPT });
      const runnerCalls: string[] = [];
      const instructions: string[] = [];
      /**
       * 这一次交接投出去的指令（SDK 投的，宿主不居中转发）：从 agent 的消息里认出来 ——
       * 来源是「宿主 / handoff」的那条 user 消息就是它。正文前面会带一行来源注释（core 给非
       * 用户来源的消息加的），断言只看里面有没有那几段字。
       */
      driver.on("messageAdded", (payload) => {
        const message = (payload as { message?: AgentNS.Message }).message;
        if (message?.role !== AgentNS.Role.User) return;
        if (message.source?.kind !== "system" || message.source.label !== "handoff") return;
        instructions.push(typeof message.content === "string" ? message.content : "");
      });
      /** 这一趟真的走完了的记号（摘牌次数）与等着它的人（`settle` 一个一个等） */
      let ends = 0;
      const endWaiters: Array<() => void> = [];
      /** 这段在不在交接态（真 `ChatRunner` 自己记着，替身这里就记一格） */
      let handingOff = false;

      /**
       * 交接要的那两个口（真 `ChatRunner` 结构上就是它）。
       *
       * `canHandoffNow` 的四个答案里三个直接读那个 agent（没有 / 忙 / 暂停），第四个读这块牌子
       * —— 生产上这四条收在 `ChatRunner.canHandoffNow` 一处，这里只是把那个口的契约演出来。
       */
      const runner: HandoffRunnerPort = {
        canHandoffNow: (sessionId) => {
          if (handingOff) return { ok: false, reason: "handoff_in_progress" };
          const live = (options.holder ?? { get: () => driver }).get(sessionId);
          if (!live) return { ok: false, reason: "no_agent" };
          if (live.state !== "idle") return { ok: false, reason: "working" };
          if (live.isOutputPaused) return { ok: false, reason: "output_paused" };
          return { ok: true };
        },
        beginHandoff: (sessionId) => {
          runnerCalls.push(`begin:${sessionId}`);
          handingOff = true;
        },
        endHandoff: (sessionId) => {
          runnerCalls.push(`end:${sessionId}`);
          handingOff = false;
          ends += 1;
          for (const wake of endWaiters.splice(0)) wake();
        },
      };

      const agents: HandoffAgentHolder = options.holder ?? { get: () => driver };
      const { log, emit } = watchEvents();
      // 模板目录按 cwd 现算（生产上就是「项目里放一份同名 Skill 覆盖全局那份」）
      const templateDirs = options.skillDirs ?? [join(skillsDir)];

      const service = new HandoffDocumentService({
        sessions,
        workspaces,
        messages,
        sessionViews: sessionService,
        execute: options.execute ?? sdkExecutor(),
        agents,
        runner,
        ...(options.notices ? { notices: options.notices } : {}),
        emit,
        skillDirs: () => templateDirs,
        now: () => 1_700_000_010_000,
      });

      return {
        service,
        driver,
        driverCalls: driver.calls,
        runnerCalls,
        instructions,
        events: log,
        settle: async () => {
          // 「我是第几趟」在**起跑之前**就得数清楚：回滚那条路上摘牌紧跟在事件后面，
          // 等 await 回来时可能已经数过了
          const target = ends + 1;
          // 先确认这一趟真的跑起来了（`memory_replaced` 是提交与回滚都会推的那一条），再等摘牌
          await log.settled;
          while (ends < target) {
            await new Promise<void>((resolve) => endWaiters.push(resolve));
          }
        },
      };
    },
  };

  return harness;
}

/** 从交接指令里抠出文档路径（指令里给的就是绝对路径） */
function documentPathFrom(instruction: AgentNS.MessageContent): string {
  const text = typeof instruction === "string" ? instruction : JSON.stringify(instruction);
  return /(?:absolute path:|too small to deliver:)\s*(\S+\.md)/.exec(text)?.[1] ?? "";
}

/**
 * 真 SDK 执行者（客户端换成回声替身，不连网）。
 *
 * 走真执行者是为了让用例能看到「读不到 Writer 就降级 summary」这类 SDK 事实，
 * 而只换掉最外层的 HTTP 那一跳。
 */
function sdkExecutor(onRequest?: (body: SummaryBody) => void): HandoffExecutor {
  return createSdkHandoffExecutor({
    client: echoingClient(onRequest),
    model: "handoff-model",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

let harness: Harness;
let sessionId: string;

// 整个文件共用一个库：`new + migrate` 每用例 55ms，清表只是一条 DELETE 批次。
beforeAll(async () => {
  await prepareStatic();
});

beforeEach(async () => {
  // 只清业务表；`meta` 绝不碰（migrate 靠 meta.schemaVersion 判断跑不跑）。
  // `workspaces` 级联 sessions → messages → session_assets，删完再删素材行。
  await db.tx((tx) => [
    tx.run("DELETE FROM notices"),
    tx.run("DELETE FROM workspaces"),
    tx.run("DELETE FROM assets"),
    tx.run("DELETE FROM credentials"),
  ]);
  // 项目目录里的 `.ai-zen/handoffs` 是用例写下的产物（有的用例还断言它「不存在」），
  // 共享目录下必须每个用例先回到干净状态；配置与 agents/ 、skills/ 是静态的，不动。
  await rm(join(projectDir, ".ai-zen"), { recursive: true, force: true });

  harness = await seedHarness();
  const rows = await harness.sessions.list();
  sessionId = rows[0]?.id ?? "";
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("自交接：同一个agent写（PRD 4.5）", () => {
  it("不另造agent：文档由这段会话自己的那个 agent 写出来", async () => {
    const built = harness.build();
    await built.service.start({ sessionId, mode: "self", then: "document_only" });
    await built.settle();

    // 指令确实投给了它（宿主没有另起一个 agent），而且带着磁盘上那份 Skill 的正文
    expect(built.instructions).toHaveLength(1);
    expect(built.instructions[0]).toContain(SKILL_MARKER);
    const dir = handoffDirFor(harness.projectDir);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it("读不到 Skill 时用 SDK 的兜底模板", async () => {
    const built = harness.build({ skillDirs: [] });
    await built.service.start({ sessionId, mode: "self", then: "document_only" });
    await built.settle();

    expect(built.instructions[0]).toContain("# Handoff Document");
    expect(built.instructions[0]).not.toContain(SKILL_MARKER);
  });

  it("交接期间挂牌、写完摘牌（只跳过写库，事件照推）", async () => {
    const built = harness.build();
    await built.service.start({ sessionId, mode: "self", then: "document_only" });
    await built.settle();

    // 挂牌在指令落地之前，摘牌在收尾那一处（投递不经过宿主：写文档那条指令由 SDK 投）
    expect(built.runnerCalls).toEqual([`begin:${sessionId}`, `end:${sessionId}`]);
  });

  it("「写完了」看那次写工具的结果：工具结果到了 + 盘上够长 → 当场提交", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    const built = harness.build({ notices });
    const toolFinished: string[] = [];
    built.driver.on("toolFinished", (payload) => {
      toolFinished.push(payload.toolCall?.function?.name ?? "?");
    });

    await built.service.start({ sessionId, mode: "self", then: "document_only" });
    await built.settle();

    // 判定链：那次写文档的工具调用跑完 → 落盘校验 → 提交。不靠状态事件，也不看模型说的话
    expect(toolFinished).toEqual(["write"]);
    // 当场提交：只问了一次，降级没发生
    expect(built.instructions).toHaveLength(1);
    expect(await readdir(handoffDirFor(harness.projectDir))).toHaveLength(1);
    const listed = await notices.list({});
    expect(
      listed.notices.some((notice) => notice.text.messageKey === "notice.handoffWritten"),
    ).toBe(true);
    expect(listed.notices.some((notice) => notice.text.messageKey === "handoff.degraded")).toBe(
      false,
    );
  });

  it("空闲时投一条指令 → 它的工具结果说写了 → 提交（关闸一次、提交后开回来）", async () => {
    const built = harness.build();
    const outcomes: string[] = [];
    built.driver.on("toolFinished", (payload) => {
      outcomes.push(payload.toolCall?.function?.name ?? "?");
    });

    await built.service.start({ sessionId, mode: "self", then: "document_only" });
    await built.settle();

    // 一条指令、恰一次写工具的结果、盘上一份文档：这三个就是那一链的全部事实
    expect(built.instructions).toHaveLength(1);
    expect(outcomes).toEqual(["write"]);
    expect(await readdir(handoffDirFor(harness.projectDir))).toHaveLength(1);
    // 闸只动两下：这一批收口时关上（别人的话进不来），记忆换完开回来
    expect(built.driverCalls).toEqual(["pauseOutput", "resumeOutput"]);
    expect(built.driver.isOutputPaused).toBe(false);
  });

  it("自交接没写出来（模型压根没调写工具）→ 单向降级到独立摘要，并说清楚退了哪一档（F-D7）", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    // 脚本里没有那次写：第一批只有一句话。工具集里仍然有 `write`（自交接的前提成立），
    // 但这一趟一次都没调它 —— 判据落在「这一批收口了还没见到那次写」上。
    const driver = new RecordingAgent(
      [
        { deltas: [{ content: "我不想写" }] },
        { deltas: [{ content: "写好了" }], toolCalls: [{ id: "call-write", name: "write" }] },
      ],
      { system: DRIVER_SYSTEM_PROMPT },
    );
    const built = harness.build({ notices, driver });
    await built.service.start({ sessionId, mode: "self", then: "document_only" });
    await built.settle();

    // 只投一次：没写出来就是没写成 → 降级到摘要那一档（它把文档写进了同一个目录）
    expect(built.instructions).toHaveLength(1);
    const dir = handoffDirFor(harness.projectDir);
    expect(await readdir(dir)).toHaveLength(1);
    const listed = await notices.list({});
    const degraded = listed.notices.find((notice) => notice.text.messageKey === "handoff.degraded");
    expect(degraded?.level).toBe("warning");
    expect(degraded?.text.params.mode).toBe("summary");
    // 降级不是失败：文档写好了这件事照样有一条
    expect(
      listed.notices.some((notice) => notice.text.messageKey === "notice.handoffWritten"),
    ).toBe(true);
  });

  it("不收件的会话也不让跑：不替用户恢复收件", async () => {
    const built = harness.build();
    // 用户按过中断 / 让停下：不收件就是他的意愿，交接不得去开那个开关
    built.driver.pauseOutput();
    built.driver.calls.length = 0;

    await expect(
      built.service.start({ sessionId, mode: "self", then: "document_only" }),
    ).rejects.toMatchObject({ code: "busy", detail: { reason: "output_paused" } });

    // 开关还开着（没人去动它）、一条指令未投
    expect(built.driver.isOutputPaused).toBe(true);
    expect(built.driverCalls).toEqual([]);
    expect(built.runnerCalls).toEqual([]);
  });

  it("中断（用户按了中断＝放弃交接）→ 回到交接前，并说不交接了", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    // 这一趟的第一片永远不来：于是「掐在途」必然落在正在跑的那一批上。
    // 第二段只为让这个 agent 手里有 `write` 工具（自交接的前提），它走不到
    const driver = new RecordingAgent([
      { gate: new Promise<void>(() => undefined) },
      { deltas: [{ content: "写好了" }], toolCalls: [{ id: "call-write", name: "write" }] },
    ]);
    const built = harness.build({ notices, driver });

    const working = new Promise<void>((resolve) => {
      driver.on("state:working", () => resolve());
    });
    await built.service.start({ sessionId, mode: "self", then: "document_only" });
    await working;
    driver.abort();
    await built.settle();

    expect(driver.isOutputPaused).toBe(true);
    // 取消**不开闸**：用户按的中断开着的那道闸，回滚之后就该保持暂停（要接着跑是用户去按继续）
    expect(built.driverCalls).not.toContain("resumeOutput");
    const listed = await notices.list({});
    expect(
      listed.notices.some((notice) => notice.text.messageKey === "error.handoffDeclined"),
    ).toBe(true);
  });
});

describe("独立交接（一次性agent + 记忆副本）", () => {
  it("文档真的落在 <cwd>/.ai-zen/handoffs/ 下，大小从磁盘取，写完落一条通知", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    const built = harness.build({ notices });
    await built.service.start({ sessionId, mode: "summary", then: "document_only" });
    await built.settle();

    const dir = handoffDirFor(harness.projectDir);
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    const path = join(dir, names[0] ?? "");
    expect(path.endsWith(".md")).toBe(true);

    const listed = await notices.list({});
    const writtenNotice = listed.notices.find(
      (notice) => notice.text.messageKey === "notice.handoffWritten",
    );
    expect(writtenNotice?.text.params).toEqual({ path });
    expect(writtenNotice?.sessionId).toBe(sessionId);
    // 文件事实从磁盘取：大小与盘上那一份一致
    expect((await stat(path)).size).toBeGreaterThan(0);
  });

  it("摘要拿的是这段会话的记忆（omit 的不给）", async () => {
    // agent 的记忆就是这段会话的记忆（真实现里由 `ChatRunner` 装配时把历史装进去）
    const driver = new RecordingAgent([{ deltas: [{ content: "写好了" }] }], {
      system: DRIVER_SYSTEM_PROMPT,
    });
    driver.messages.push(Message.User("帮我看看这个仓库的测试为什么慢"));
    driver.messages.push(Message.Assistant("慢在 storage 的每个用例都新开库。"));
    const omitted = Message.User("这条已经不在上下文里了");
    omitted.omit = true;
    driver.messages.push(omitted);

    let asked = "";
    const built = harness.build({
      driver,
      execute: sdkExecutor((body) => {
        asked = String(body.messages[1]?.content ?? "");
      }),
    });
    await built.service.start({ sessionId, mode: "summary", then: "document_only" });
    await built.settle();

    // 发给模型的是这段记忆（序列化后那句一句都在），已经 omit 的那条不在里面
    expect(asked).toContain("帮我看看这个仓库的测试为什么慢");
    expect(asked).toContain("慢在 storage 的每个用例都新开库。");
    expect(asked).not.toContain("这条已经不在上下文里了");
  });

  it("交接之后开新会话（D18）：身份照抄，开场是那条交接摘要", async () => {
    const built = harness.build();
    await built.service.start({ sessionId, mode: "summary", then: "new_session" });
    await built.settle();

    const rows = await harness.sessions.list();
    const oldRow = await harness.sessions.get(sessionId);
    // 多出来的两段：存档（旧记忆）与交接新开的那一段
    const created = rows.filter((row) => row.id !== sessionId);
    expect(created).toHaveLength(2);
    const archived = created.find((row) => row.name.startsWith("已存档_"));
    const newRow = created.find((row) => row.id !== archived?.id);
    expect(archived).toBeDefined();
    expect(newRow?.workspaceId).toBe(oldRow?.workspaceId);
    expect(newRow?.agentId).toBe(oldRow?.agentId);
    expect(newRow?.modelId).toBe(oldRow?.modelId);

    // 新会话开场：先是会话创建时那条 hidden 的 cwd 消息，再是一条宿主注入的交接摘要
    const newId = newRow?.id ?? "";
    const seeded = await harness.messages.listBySession(newId, undefined, {
      includeHidden: true,
    });
    expect(seeded).toHaveLength(2);
    expect(seeded[0]?.role).toBe(AgentNS.Role.User);
    expect(seeded[0]?.data).toMatchObject({ hidden: true });
    expect(seeded[1]?.role).toBe(AgentNS.Role.System);
    expect(seeded[1]?.data).toMatchObject({ hidden: true });

    // 开新会话这件事靠一条 `session.changed(created)` 告知界面
    expect(
      built.events.changed.some(
        (change) => change.change === "created" && change.sessionId === newId,
      ),
    ).toBe(true);
  });

  it("压缩标记落在被压的那一段上：`new_session` 记 manual，`document_only` 不记", async () => {
    const only = harness.build();
    await only.service.start({ sessionId, mode: "summary", then: "document_only" });
    await only.settle();
    expect(await harness.sessions.get(sessionId)).toMatchObject({
      compactedAt: null,
      compactionMode: null,
    });

    const next = harness.build();
    await next.service.start({ sessionId, mode: "summary", then: "new_session" });
    await next.settle();
    const row = await harness.sessions.get(sessionId);
    expect(row?.compactionMode).toBe("manual");
    expect(typeof row?.compactedAt).toBe("number");
  });

  it("只产文档就只多出那段存档（F-D4）：不另开新会话", async () => {
    const built = harness.build();
    await built.service.start({ sessionId, mode: "summary", then: "document_only" });
    await built.settle();
    const rows = await harness.sessions.list();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.name.startsWith("已存档_"))).toHaveLength(1);
  });
});

describe("换记忆：旧记忆成为另一段会话（PRD 4.5）", () => {
  it("提交之后：原会话只剩 SDK 算好的那条断点，旧记忆整段挂到 `已存档_<原名>` 名下", async () => {
    const built = harness.build();
    const before = await harness.messages.listBySession(sessionId, undefined, {
      includeHidden: true,
    });
    const original = await harness.sessions.get(sessionId);
    await built.service.start({ sessionId, mode: "summary", then: "document_only" });
    await built.settle();

    // 原会话：库里只剩一条 `hidden` 消息 —— SDK 算出来的那条断点（交接后没有 cwd 消息）
    const left = await harness.messages.listBySession(sessionId, undefined, {
      includeHidden: true,
    });
    expect(left).toHaveLength(1);

    // 形状由 SDK 定：`role: system` + `hidden` + 正文只有那份文档的路径
    const breakpointRow = left[0];
    expect(breakpointRow?.role).toBe(AgentNS.Role.System);
    expect(breakpointRow?.data).toMatchObject({ hidden: true });
    const path = breakpointRow?.content as string;
    expect(path.startsWith(handoffDirFor(harness.projectDir))).toBe(true);
    expect(path.endsWith(".md")).toBe(true);
    // 文档正文一个字都不进记忆：断点带的是路径，正文由需要细节的一方自己去读
    expect(path.length).toBeLessThan(200);
    expect(await readFile(path, "utf-8")).toContain("任务目标");
    // `hidden` 的那一条也不进默认可见集（不进条数、不给人看，但照常进上下文）
    expect(await harness.messages.listBySession(sessionId)).toHaveLength(0);

    // 存档那段：名字加前缀、身份照抄、消息整段挂过去（`seq` / `createdAt` 原样不动）
    const archived = (await harness.sessions.list()).find(
      (row) => row.name === `已存档_${original?.name}`,
    );
    expect(archived).toBeDefined();
    expect(archived?.workspaceId).toBe(original?.workspaceId);
    expect(archived?.agentId).toBe(original?.agentId);
    expect(archived?.modelId).toBe(original?.modelId);
    expect(archived?.thinkingLevel).toBe(original?.thinkingLevel);
    // 它就是交接那一刻生成的（按自己的时间排在列表里）
    expect(archived?.createdAt).toBe(1_700_000_010_000);
    const moved = await harness.messages.listBySession(archived?.id ?? "", undefined, {
      includeHidden: true,
    });
    expect(moved.map((row) => [row.id, row.seq, row.createdAt])).toEqual(
      before.map((row) => [row.id, row.seq, row.createdAt]),
    );
  });

  it("内存里原地换：不重建 agent、不动队列与两个开关，系统提示还在、断点是 SDK 那一条", async () => {
    const built = harness.build();
    // 这段会话的记忆就是这个数组（换记忆是原地换，不是换一个数组、更不是换一个 agent）
    const memory = built.driver.messages;
    await built.service.start({ sessionId, mode: "self", then: "document_only" });
    await built.settle();

    expect(built.driver.messages).toBe(memory);
    // 系统提示 + 断点：内存那份与库里同一份（系统提示不是库里的行，所以库里只有一条）
    expect(built.driver.messages).toHaveLength(2);
    expect(built.driver.messages[0]?.content).toBe(DRIVER_SYSTEM_PROMPT);
    const breakpoint = built.driver.messages[1];
    expect(breakpoint?.role).toBe(AgentNS.Role.System);
    expect(breakpoint?.hidden).toBe(true);

    // 落库与内存必须一致：同一条（同 id、同正文）
    const rows = await harness.messages.listBySession(sessionId, undefined, {
      includeHidden: true,
    });
    expect(rows.map((row) => row.id)).toEqual([breakpoint?.id]);
    expect(rows[0]?.content).toBe(breakpoint?.content);

    // 换记忆不等于换人：闸只关过一次、开过一次，队列不重建；换完之后闸是开的
    expect(built.driverCalls).toEqual(["pauseOutput", "resumeOutput"]);
    expect(built.driver.isOutputPaused).toBe(false);
  });

  it("推两条变更：先「这段的记忆换过了」，再「那段已存档的出现了」", async () => {
    const built = harness.build();
    await built.service.start({ sessionId, mode: "summary", then: "document_only" });
    await built.settle();

    const archived = (await harness.sessions.list()).find((row) =>
      row.name.startsWith("已存档_"),
    );
    expect(
      built.events.changed.map((change) => `${change.change}:${change.sessionId}`),
    ).toEqual([`memory_replaced:${sessionId}`, `created:${archived?.id}`]);
  });

  it("存档是一段普通会话：能读、能删，删它不连坐原会话", async () => {
    const built = harness.build();
    await built.service.start({ sessionId, mode: "summary", then: "document_only" });
    await built.settle();

    const archived = (await harness.sessions.list()).find((row) =>
      row.name.startsWith("已存档_"),
    );
    const archivedId = archived?.id ?? "";
    // 它就是一段普通会话：消息照样取得出来
    expect((await harness.messages.listBySession(archivedId)).map((row) => row.id)).toEqual([
      "msg-user",
      "msg-assistant",
    ]);

    await harness.sessions.delete(archivedId);
    expect(await harness.sessions.get(archivedId)).toBeUndefined();
    expect(await harness.messages.listBySession(archivedId)).toHaveLength(0);
    // 删一段就是删那一段：原会话那条断点还在
    expect(
      await harness.messages.listBySession(sessionId, undefined, { includeHidden: true }),
    ).toHaveLength(1);
  });

  it("失败时不留存档会话，原会话的消息一条不动", async () => {
    const before = await harness.messages.listBySession(sessionId, undefined, {
      includeHidden: true,
    });
    const built = harness.build({
      execute: async () => {
        throw new Error("模型没写出来");
      },
    });
    await built.service.start({ sessionId, mode: "summary", then: "document_only" });
    await built.settle();

    // 库里本来就是交接前那一份：没有多出一段会话，也没有被换过的记忆
    expect(await harness.sessions.list()).toHaveLength(1);
    const after = await harness.messages.listBySession(sessionId, undefined, {
      includeHidden: true,
    });
    expect(after.map((row) => [row.id, row.seq, row.createdAt])).toEqual(
      before.map((row) => [row.id, row.seq, row.createdAt]),
    );
    // 内存里也没被换过
    expect(built.driver.messages).toHaveLength(1);
    expect(built.driver.messages[0]?.content).toBe(DRIVER_SYSTEM_PROMPT);
  });

  it("agent在这期间没了：按失败收尾，不留存档会话", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    // 入口判据那一次还看得见它，后台那一趟开始时它已经不在了（会话被删 / 被硬杀）
    const driver = new RecordingAgent();
    let lookups = 0;
    const built = harness.build({
      notices,
      driver,
      holder: { get: () => (lookups++ === 0 ? driver : undefined) },
    });
    await built.service.start({ sessionId, mode: "self", then: "document_only" });
    await built.settle();

    expect(await harness.sessions.list()).toHaveLength(1);
    const listed = await notices.list({});
    const failed = listed.notices.find(
      (notice) => notice.text.messageKey === "error.handoffFailed",
    );
    expect(String(failed?.text.params.reason)).toContain("the driver went away");
  });

  it("连着交接两次：系统提示不被搬走，旧断点也不被当成提示留下", async () => {
    const built = harness.build();
    await built.service.start({ sessionId, mode: "self", then: "document_only" });
    await built.settle();
    await waitIdle(built.driver);

    await built.service.start({ sessionId, mode: "self", then: "document_only" });
    await built.settle();

    // 记忆仍然是「系统提示 + 一条断点」：第一次那条属于旧记忆，不该留在原会话里
    expect(built.driver.messages).toHaveLength(2);
    expect(built.driver.messages[0]?.content).toBe(DRIVER_SYSTEM_PROMPT);
    expect(built.driver.messages[1]?.hidden).toBe(true);
    expect(built.driver.messages[1]?.role).toBe(AgentNS.Role.System);

    // 两段存档各自拿着交接前那一份：第一段是整段历史，第二段是上一次那条断点（库里一条行）
    const archived = (await harness.sessions.list()).filter((row) =>
      row.name.startsWith("已存档_"),
    );
    expect(archived).toHaveLength(2);
    const counts = await Promise.all(
      archived.map(async (row) =>
        (
          await harness.messages.listBySession(row.id, undefined, { includeHidden: true })
        ).length,
      ),
    );
    // 第一段是交接前那一整段（创建时的 cwd 消息 + 两条会话），第二段只有上一次那一条（断点）：
    // 系统提示不被搬走（它不在库里，也不是旧记忆的一部分），旧的那一条也没被当成提示留下
    expect(counts.sort((left, right) => left - right)).toEqual([1, 3]);
  });
});

describe("自动交接：平级会话越线（插件那一路）", () => {
  /**
   * 把**自动交接那条路**装起来：SDK 服务用宿主自己的 `createSdkHandoffService` 造（它会注入
   * 落库接缝），插件用真的 `AutoMigratePlugin`，两个回声照 `ChatRunner` + `app.ts` 那两格接 ——
   * 用例验的是它们背后的宿主事实（库、事件、闸、压缩标记），不是重演一遍接线。
   */
  function autoHandoff(
    built: ReturnType<Harness["build"]>,
    onMode?: (mode: string) => void,
  ): AutoMigratePlugin {
    const service = createSdkHandoffService(harness.projectDir, {
      skillDirs: [harness.skillsDir],
      client: echoingClient(),
      model: "handoff-model",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      // **两条路注入同一份落库回调**
      commitMemory: built.service.memoryCommitter(sessionId),
    });
    return new AutoMigratePlugin({
      service,
      handoffTokens: 1_000,
      // 平级会话：会话行上的自动交接开着，越线就自己交班（`resolveMode` 回 `self`）
      resolveMode: async () => "self" as const,
      onMigrated: async (info) => {
        onMode?.(info.mode);
        await harness.sessionService.markCompacted(sessionId, "auto");
        built.service.settleAutoHandoff(sessionId);
      },
      onFailed: async () => {
        built.service.settleAutoHandoff(sessionId);
      },
    });
  }

  /** 把「这一轮用了多少」摆到记忆里（插件从最后一条带 usage 的 assistant 消息上读） */
  function crossTheLine(driver: ChatAgent): void {
    driver.messages.push(
      new Message({
        role: AgentNS.Role.Assistant,
        content: "上一轮回复",
        usage: { prompt_tokens: 5_000, completion_tokens: 5, total_tokens: 5_005 },
      }),
    );
  }

  it("越线：记忆真的换了、闸开了、压缩标记记了", async () => {
    // 这一段的会话行上写着「自动交接开」（平级会话就是这么建出来的）
    await harness.sessions.setAutoHandoff(sessionId, true, 1_700_000_005_000);
    const before = await harness.messages.listBySession(sessionId, undefined, {
      includeHidden: true,
    });

    const built = harness.build();
    const modes: string[] = [];
    const plugin = autoHandoff(built, (mode) => modes.push(mode));
    crossTheLine(built.driver);

    // 交接那一批的批头由 `HandoffGuardPlugin` 关闸（真 core 的 `onOuterLoopStart` 会走到它），
    // 所以下面断言的那一对开关不是用例自己按的 —— 关在 SDK 的守卫、开在宿主的收口
    plugin.onOuterLoopStart({ agent: built.driver as unknown as any, entries: [] });
    await plugin.onIdle();

    // ① 记忆真的换了：旧记忆整段成了「已存档_」那段，原会话只剩 SDK 算好的那条断点
    const sessions = await harness.sessions.list();
    expect(sessions).toHaveLength(2);
    const archived = sessions.find((row) => row.name.startsWith("已存档_"));
    expect(
      (
        await harness.messages.listBySession(archived?.id ?? "", undefined, {
          includeHidden: true,
        })
      ).map((row) => row.id),
    ).toEqual(before.map((row) => row.id));
    const left = await harness.messages.listBySession(sessionId, undefined, {
      includeHidden: true,
    });
    expect(left).toHaveLength(1);
    // 只有断点（交接后没有 cwd 消息）
    expect(left[0]?.role).toBe(AgentNS.Role.System);
    expect(left[0]?.data).toMatchObject({ hidden: true });
    // 内存与库同一份
    expect(built.driver.messages.at(-1)?.id).toBe(left[0]?.id);

    // ② 两条会话变更都推了（先「这段换过了」再「那段出现了」）
    expect(built.events.changed.map((change) => change.change)).toEqual([
      "memory_replaced",
      "created",
    ]);

    // ③ 闸是开的（收口在宿主那一处）
    expect(built.driverCalls).toEqual(["pauseOutput", "resumeOutput"]);
    expect(built.driver.isOutputPaused).toBe(false);

    // ④ 压缩标记记了（`auto`：插件压的那条路）
    const row = await harness.sessions.get(sessionId);
    expect(row?.compactionMode).toBe("auto");
    expect(row?.compactedAt).not.toBeNull();
    expect(modes).toEqual(["self"]);
  });

  it("文档不到 400 字节 → 降级到独立摘要（不是静默成功）", async () => {
    await harness.sessions.setAutoHandoff(sessionId, true, 1_700_000_005_000);
    // 模型调了写工具，但只写了几个字：SDK 判「没写出来」，单向降级摘要
    const rounds: FakeRound[] = [
      {
        deltas: [{ content: "这就写" }],
        toolCalls: [
          {
            id: "call-write",
            name: "write",
            arguments: (request: any) =>
              JSON.stringify({
                path: documentPathFrom(String(request?.messages?.at(-1)?.content ?? "")),
                content: "too short",
              }),
          },
        ],
      },
      { deltas: [{ content: "写好了" }] },
    ];
    const built = harness.build({
      driver: new RecordingAgent(rounds, { system: DRIVER_SYSTEM_PROMPT }),
    });
    const modes: string[] = [];
    const plugin = autoHandoff(built, (mode) => modes.push(mode));
    crossTheLine(built.driver);

    plugin.onOuterLoopStart({ agent: built.driver as unknown as any, entries: [] });
    await plugin.onIdle();

    // 降级是事实：实际执行者是 `summary`（插件回声报的就是它，不报请求的那个）
    expect(modes).toEqual(["summary"]);
    // 换上去的那份文档是摘要那一次写的（降级之后照样换记忆，不是假装成功也不是什么都不做）
    const left = await harness.messages.listBySession(sessionId, undefined, {
      includeHidden: true,
    });
    expect(left).toHaveLength(1);
    const path = left[0]?.content as string;
    expect(await readFile(path, "utf-8")).toContain("## Handoff from the model");
    expect(await harness.sessions.list()).toHaveLength(2);
  });
});

describe("取消与失败（F-D7）", () => {
  it("用户取消：说不交接了，不留文档、不开新会话", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    const built = harness.build({
      notices,
      execute: async () => {
        throw new HandoffCancelledError();
      },
    });

    await built.service.start({ sessionId, mode: "summary", then: "new_session" });
    await built.settle();

    expect(await harness.sessions.list()).toHaveLength(1);
    const dir = handoffDirFor(harness.projectDir);
    await expect(readdir(dir)).rejects.toBeTruthy();
    const listed = await notices.list({});
    expect(
      listed.notices.some((notice) => notice.text.messageKey === "error.handoffDeclined"),
    ).toBe(true);
  });

  it("写文档失败后闸是开的（收口失败也开闸，否则这一段再也收不到件）", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    const built = harness.build({
      notices,
      // 这一趟按 SDK 的做法在批头关闸，然后写文档失败（没有文档、也没有提交）
      execute: async (input) => {
        input.agent.pauseOutput();
        throw new Error("模型没写出来");
      },
    });
    await built.service.start({ sessionId, mode: "self", then: "document_only" });
    await built.settle();

    // 失败也算收口：开闸在收口那一处（进来时闸必然是开的，所以不需要记它原来开着还是关着）
    expect(built.driverCalls).toEqual(["pauseOutput", "resumeOutput"]);
    expect(built.driver.isOutputPaused).toBe(false);
    const listed = await notices.list({});
    expect(
      listed.notices.some((notice) => notice.text.messageKey === "error.handoffFailed"),
    ).toBe(true);
  });

  it("执行者没把记忆交回来（一次都没叫落库接缝）→ 按失败收尾，不换记忆", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    const built = harness.build({
      notices,
      // 既不抛、也不叫 `commitMemory`：文档没交回来，这一趟不能算成
      execute: async () => ({ path: join(handoffDirFor(harness.projectDir), "不存在.md"), usedMode: "self" }),
    });
    await built.service.start({ sessionId, mode: "self", then: "document_only" });
    await built.settle();

    // 一次也没换记忆：旧记忆还在、没有存档会话
    expect(await harness.sessions.list()).toHaveLength(1);
    const listed = await notices.list({});
    const failed = listed.notices.find(
      (notice) => notice.text.messageKey === "error.handoffFailed",
    );
    expect(String(failed?.text.params.reason)).toContain("never came back");
  });

  it("换记忆那一拍没成（文档不在盘上）→ 按失败收尾，报的是那个错，不留存档会话", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    const built = harness.build({
      notices,
      // 执行者说「写好了」，但那个路径上什么也没有：提交点的盘上校验不成立
      execute: async (input) => {
        const path = join(handoffDirFor(harness.projectDir), "没写出来.md");
        await input.commitMemory?.({ memory: [], handoffPath: path, mode: "self" });
        return { path, usedMode: "self" };
      },
    });
    await built.service.start({ sessionId, mode: "self", then: "document_only" });
    await built.settle();

    // 没换过记忆：一段存档都不多、原会话的消息一条不动
    expect(await harness.sessions.list()).toHaveLength(1);
    const listed = await notices.list({});
    const failed = listed.notices.find(
      (notice) => notice.text.messageKey === "error.handoffFailed",
    );
    // 报的是那个真错（不是「文档没回来」）：校验在落库接缝之前，原错原样上来
    expect(String(failed?.text.params.reason)).toContain("not on disk");
  });

  it("真失败：说清楚没走通，并回到交接前", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    const built = harness.build({
      notices,
      execute: async () => {
        throw new Error("模型没写出来");
      },
    });

    await built.service.start({ sessionId, mode: "summary", then: "document_only" });
    await built.settle();

    const listed = await notices.list({});
    const failed = listed.notices.find(
      (notice) => notice.text.messageKey === "error.handoffFailed",
    );
    expect(failed?.level).toBe("error");
    expect(failed?.text.params).toMatchObject({ reason: "模型没写出来" });
    // 这一段仍能接着用：没人把它按住，也就不需要谁去放行
    expect(built.driver.state).not.toBe("working");
  });
});

describe("前置条件", () => {
  it("在干的时候不让跑：handoff.start 直接拒（busy + working）", async () => {
    // 第一片永远不来：它一直在干（手上的活没完，inbox 里也不该被插一条交接指令）
    const driver = new RecordingAgent([{ gate: new Promise<void>(() => undefined) }]);
    const built = harness.build({ driver });
    const working = new Promise<void>((resolve) => {
      driver.on("state:working", () => resolve());
    });
    driver.push({ content: "先聊一句", priority: "high", source: { kind: "user" } });
    void driver.start();
    await working;

    await expect(
      built.service.start({ sessionId, mode: "self", then: "document_only" }),
    ).rejects.toMatchObject({ code: "busy", detail: { reason: "working" } });

    // 拒绝就是拒绝：没挂牌、没投递，agent 也没被打断（掐在途那套编排已经作废）
    expect(built.runnerCalls).toEqual([]);
    expect(built.instructions).toEqual([]);
    expect(driver.abortCalls).toBe(0);
    expect(driver.state).toBe("working");
  });

  it("没有 agent 也不让跑：没有人可写（busy + no_agent）", async () => {
    const built = harness.build({ holder: { get: () => undefined } });
    await expect(
      built.service.start({ sessionId, mode: "self", then: "document_only" }),
    ).rejects.toMatchObject({ code: "busy", detail: { reason: "no_agent" } });
    // 什么都没开始：没挂牌、没投指令
    expect(built.runnerCalls).toEqual([]);
    expect(built.instructions).toEqual([]);
  });

  it("会话不存在报 not_found（这一条在返回「已经开始」之前）", async () => {
    const built = harness.build();
    await expect(
      built.service.start({ sessionId: "没有这段", mode: "summary", then: "document_only" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("执行者与后续动作不认识时按参数不对拒", async () => {
    const built = harness.build();
    await expect(
      built.service.start({
        sessionId,
        mode: "prune" as unknown as "summary",
        then: "document_only",
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      built.service.start({
        sessionId,
        mode: "summary",
        then: "migrate" as unknown as "document_only",
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

});

describe("项目里的交接文档（F-D6：可反复打磨同一份）", () => {
  it("列出目录里的 .md，按修改时间倒序，非 .md 不列", async () => {
    const dir = handoffDirFor(harness.projectDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "20260101-000000.md"), "第一份", "utf-8");
    await sleep(10);
    await writeFile(join(dir, "20260102-000000.md"), "第二份", "utf-8");
    await writeFile(join(dir, "notes.txt"), "不是交接文档", "utf-8");

    const built = harness.build();
    const listed = await built.service.listDocuments({ workspaceId: "w1" });
    expect(listed.documents.map((document) => document.name)).toEqual([
      "20260102-000000.md",
      "20260101-000000.md",
    ]);
    expect(listed.documents[0]?.path).toBe(join(dir, "20260102-000000.md"));
    expect(listed.documents[0]?.bytes).toBeGreaterThan(0);
    expect(listed.documents[0]?.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("目录还不存在时回空列表（第一次交接之前本来就没有它）", async () => {
    const built = harness.build();
    expect(await built.service.listDocuments({ workspaceId: "w1" })).toEqual({ documents: [] });
  });

  it("项目不存在报 not_found", async () => {
    const built = harness.build();
    await expect(built.service.listDocuments({ workspaceId: "没有这个项目" })).rejects.toMatchObject(
      { code: "not_found" },
    );
  });
});

/** 让两次写入的 mtime 不同（有些文件系统的时间精度是秒级） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等这个 agent 真的落到闲（再发起一次交接要它闲着，也要服务收完上一趟） */
async function waitIdle(agent: ChatAgent): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (agent.state === "idle") {
      await flushMicrotasks();
      return;
    }
    await flushMicrotasks();
  }
  throw new Error("agent没有回到空闲");
}
