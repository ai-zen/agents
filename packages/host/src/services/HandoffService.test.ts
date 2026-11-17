/**
 * 交接的验收：谁写文档（自交接＝同一个驱动者 / 独立交接＝一次性驱动者）、文档真的落进
 * `<cwd>/.ai-zen/handoffs/`（D19）、模板来自磁盘上的 `handoff` Skill（读不到用兜底）、
 * 降级要说明（F-D7）、取消不报错（F-D7）、交接后新对话的身份与旧对话的存续（D18）、
 * 只产文档不换会话（F-D4）。
 *
 * 两件口径：
 *
 * 1. `start()` 只回「已经开始」，那一趟在后台跑。所以每个用例都靠一条 **`memory_replaced`**
 *    事件等它收尾 —— 提交与回滚都推它，于是「跑完了没有」这件事有一个确定的答案，
 *    而不是靠睡一会儿。
 * 2. 自交接「写完了没有」只看**那次写文档的工具调用的结果**（`toolFinished`）加一道落盘校验，
 *    不看状态事件，也不看模型说的话。
 * 3. 入口判据只有一条：**那段对话闲着才发起**。非空闲（忙 / 暂停 / 没有 agent）直接拒，
 *    交接全程不碰暂停、也不替谁放行。
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentNS } from "@ai-zen/agents-core";
import { completeOnce, ConfigManager } from "@ai-zen/agents-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ChatEventEmitter } from "../runtime/ChatRunner.js";
import { createFakeScope, FakeAgent } from "../runtime/TestSupport.js";
import type { FakeRound } from "../runtime/TestSupport.js";
import type { AgentBuildContext, AgentFactory } from "../runtime/ChatRunner.js";
import { AssetRepository } from "../storage/AssetRepository.js";
import { ConversationRepository } from "../storage/ConversationRepository.js";
import { Database } from "../storage/Database.js";
import { MessageRepository } from "../storage/MessageRepository.js";
import { NoticeRepository } from "../storage/NoticeRepository.js";
import { QuestionRepository } from "../storage/QuestionRepository.js";
import { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import { migrate } from "../storage/migrations.js";
import type { ConversationStatus } from "../wire/index.js";
import type { ConversationChangedPayload } from "../wire/events.js";
import type { ConversationRuntimePort } from "./ConversationService.js";
import { ConversationService } from "./ConversationService.js";
import {
  createSdkHandoffExecutor,
  HandoffCancelledError,
  HandoffService,
  handoffDirFor,
} from "./HandoffService.js";
import type {
  HandoffAgentHolder,
  HandoffExecutor,
  HandoffRunnerPort,
  ScopeProvider,
} from "./HandoffService.js";
import { NoticeService } from "./NoticeService.js";

/** 摘要模式用的假客户端：把「指令 + 正文」回声出来，于是一眼能看出模板来自哪一份 */
type SummaryClient = Parameters<typeof completeOnce>[0]["client"];

/** 文档正文（要过 400 字节那道坎，所以写长一点） */
const DOCUMENT_BODY = `## 任务目标\n\n把交接写完。\n\n${"正文。".repeat(200)}`;

function echoingClient(): SummaryClient {
  const client = {
    chat: {
      completions: {
        create: async (body: { messages: Array<{ role: string; content: string }> }) => ({
          choices: [
            {
              message: {
                content: `${body.messages[0]?.content ?? ""}\n\n## Handoff from the model\n\n${DOCUMENT_BODY}`,
              },
            },
          ],
        }),
      },
    },
  };
  return client as unknown as SummaryClient;
}

/** 对话服务要的那个窄接口：交接用例不需要临时模型 / 临时档位 */
class FakeRuntime implements ConversationRuntimePort {
  status(): ConversationStatus {
    return "dead";
  }
  inboxPending(): number {
    return 0;
  }
  forget(): void {}
}

/** 取 Scope 的记账实现：真 Scope（cwd 显式给），只记拿过哪些键（没有归还这回事） */
class RecordingScopes implements ScopeProvider {
  readonly acquired: string[] = [];

  constructor(private readonly cwd: string) {}

  async create(key: string) {
    this.acquired.push(key);
    return createFakeScope(this.cwd).scope;
  }
}

/** 记账的驱动者：它就是 core 的 `Agent`（真的循环、真的取件），把「翻上/翻回不取件开关」接过来记一笔 */
class RecordingAgent extends FakeAgent {
  readonly calls: string[] = [];

  override pauseConsumption(): void {
    this.calls.push("pauseConsumption");
    super.pauseConsumption();
  }

  override resumeConsumption(): void {
    this.calls.push("resumeConsumption");
    super.resumeConsumption();
  }
}

/** 一份事件记录（用例靠 `memory_replaced` 等交接收尾） */
interface EventLog {
  events: Array<{ name: string; payload: unknown }>;
  changed: ConversationChangedPayload[];
  settled: Promise<void>;
}

function watchEvents(): { log: EventLog; emit: ChatEventEmitter } {
  const events: Array<{ name: string; payload: unknown }> = [];
  const changed: ConversationChangedPayload[] = [];
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const emit: ChatEventEmitter = (name, payload) => {
    events.push({ name, payload });
    if (name === "conversation.changed") {
      const fact = payload as ConversationChangedPayload;
      changed.push(fact);
      // 提交与回滚都会推这一条：它就是这个服务「这一趟收尾了」的唯一信号
      if (fact.change === "memory_replaced") settle();
    }
  };
  return { log: { events, changed, settled }, emit };
}

/** 一次交接的跑法：起一趟、等它收尾 */
interface Built {
  service: HandoffService;
  driver: RecordingAgent;
  driverCalls: string[];
  runnerCalls: string[];
  /** 投出去的指令（自交接那条路：一条一条看得到） */
  instructions: string[];
  events: EventLog;
  /**
   * 自交接有没有写文档（`false` 时驱动者照旧调写工具，但盘上什么都没落 —— 验「降级」那条路）
   */
  writesDocument: boolean;
  settle(): Promise<void>;
}

interface Harness {
  dir: string;
  projectDir: string;
  skillsDir: string;
  db: Database;
  conversations: ConversationRepository;
  messages: MessageRepository;
  questions: QuestionRepository;
  conversationService: ConversationService;
  scopes: RecordingScopes;
  agentContexts: AgentBuildContext[];
  build(options?: {
    execute?: HandoffExecutor;
    notices?: NoticeService;
    driver?: RecordingAgent;
    /** 驱动者的持有者（缺省就是手上这个 driver；给 `{ get: () => undefined }` 验「没有 agent」那条） */
    holder?: HandoffAgentHolder;
    /** 驱动者调了写工具但不落盘（用来验「两道都不成立 → 降级」） */
    writesDocument?: boolean;
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
let conversations: ConversationRepository;
let messages: MessageRepository;
let questions: QuestionRepository;

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
  conversations = new ConversationRepository(db);
  messages = new MessageRepository(db);
  questions = new QuestionRepository(db);

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
 * 每用例那一份：项目行、一段有内容的对话，以及实例级状态（Scope 记账、agent 上下文、
 * 对话服务的草稿表）。库与配置不在这里重做。
 */
async function seedHarness(): Promise<Harness> {
  await workspaces.create({ id: "w1", name: "项目一", cwd: projectDir, createdAt: 1 });

  const conversationService = new ConversationService({
    conversations,
    messages,
    workspaces,
    assets: new AssetRepository(db),
    questions,
    configManager: new ConfigManager(configPath),
    runtime: new FakeRuntime(),
    now: () => 1_700_000_000_000,
  });

  const created = await conversationService.create({ workspaceId: "w1", agentId: "a1" });
  if (!created.conversation) throw new Error("conversation.create 没有建出对话");
  const conversationId = created.conversation.id;
  // R56：`create` 只发 id，落库发生在首次 `send`；夹具里直接落库（后面要往它名下写消息）
  await conversationService.ensurePersisted(conversationId);

  // 一段有内容的对话：用户说一句 + 助手回一句
  await messages.upsertMany([
    {
      id: "msg-user",
      conversationId,
      role: AgentNS.Role.User as string,
      status: AgentNS.MessageStatus.Completed as string,
      content: "帮我看看这个仓库的测试为什么慢",
      createdAt: 1_700_000_001_000,
    },
    {
      id: "msg-assistant",
      conversationId,
      role: AgentNS.Role.Assistant as string,
      status: AgentNS.MessageStatus.Completed as string,
      content: "慢在 storage 的每个用例都新开库。",
      createdAt: 1_700_000_002_000,
    },
  ]);

  const scopes = new RecordingScopes(projectDir);
  const agentContexts: AgentBuildContext[] = [];
  const createAgent: AgentFactory = async (context) => {
    agentContexts.push(context);
    return new FakeAgent([{ deltas: [{ content: "交接回合" }] }]);
  };

  const harness: Harness = {
    dir,
    projectDir,
    skillsDir,
    db,
    conversations,
    messages,
    questions,
    conversationService,
    scopes,
    agentContexts,
    build: (options = {}) => {
      /**
       * 驱动者的脚本：先要一次写工具调用（参数里的路径在投递那一刻按指令补上 —— 真实现里
       * 那是模型自己填的输入），工具跑完再回一句「写好了」。
       *
       * 「写完了没有」的事实来源就是这一次工具调用的结果 —— 不是状态，也不是那句话。
       */
      const rounds: FakeRound[] = [
        {
          deltas: [{ content: "这就写" }],
          toolCalls: [{ id: "call-write", name: "write", arguments: "{}" }],
        },
        { deltas: [{ content: "写好了" }] },
      ];
      const driver = options.driver ?? new RecordingAgent(rounds);
      const runnerCalls: string[] = [];
      const instructions: string[] = [];
      const writesDocument = options.writesDocument ?? true;
      let delivered = 0;

      /**
       * 投递口（真 `ChatRunner` 结构上就是它）：把指令塞进**这个驱动者**的队列，并让它跑起来。
       *
       * 「模型把它写到盘上」这一半由这里代劳（真实现里是 `write` 工具干的）：指令里带着绝对
       * 路径，所以把它同时填进那次写工具调用的参数（于是 core 会真的发一条 `toolFinished`）
       * 并写到那儿 —— 用例验的是「工具结果到了之后服务怎么办」，不是模型的手艺。
       */
      const runner: HandoffRunnerPort = {
        beginHandoff: (conversationId) => {
          runnerCalls.push(`begin:${conversationId}`);
        },
        endHandoff: (conversationId) => {
          runnerCalls.push(`end:${conversationId}`);
        },
        deliver: async (conversationId, input) => {
          delivered += 1;
          runnerCalls.push(`deliver:${conversationId}`);
          instructions.push(typeof input.content === "string" ? input.content : "");
          const path = documentPathFrom(input.content);
          const write = rounds[0]?.toolCalls?.[0];
          if (write && path !== "") {
            write.arguments = JSON.stringify({ path, content: DOCUMENT_BODY });
          }
          if (writesDocument) await writeDocumentAt(path);
          driver.push({
            content: input.content,
            priority: "high",
            source: input.source,
            messageId: `handoff-${delivered}`,
          });
          if (driver.state === "idle" && !driver.started) void driver.start();
          return { userMessageId: `handoff-${delivered}` };
        },
      };

      const agents: HandoffAgentHolder = options.holder ?? { get: () => driver };
      const { log, emit } = watchEvents();

      const service = new HandoffService({
        conversations,
        workspaces,
        messages,
        conversationViews: conversationService,
        scopes,
        createAgent,
        execute: options.execute ?? sdkExecutor(options.skillDirs ?? [join(skillsDir)]),
        agents,
        runner,
        ...(options.notices ? { notices: options.notices } : {}),
        questions,
        emit,
        skillDirs: [join(skillsDir)],
        now: () => 1_700_000_010_000,
      });

      return {
        service,
        driver,
        driverCalls: driver.calls,
        runnerCalls,
        instructions,
        events: log,
        writesDocument,
        settle: async () => {
          await log.settled;
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

/** 把文档写到那个路径（真实现里这一步是模型的 `write` 工具干的） */
async function writeDocumentAt(path: string): Promise<void> {
  if (path === "") return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, DOCUMENT_BODY, "utf-8");
}

/**
 * 真 SDK 执行者（客户端换成回声替身，不连网）。
 *
 * 走真执行者是为了让用例能看到「读不到 Writer 就降级 summary」这类 SDK 事实，
 * 而只换掉最外层的 HTTP 那一跳。
 */
function sdkExecutor(skillDirs: string[]): HandoffExecutor {
  return createSdkHandoffExecutor({
    skillDirs,
    client: echoingClient(),
    model: "handoff-model",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

let harness: Harness;
let conversationId: string;

// 整个文件共用一个库：`new + migrate` 每用例 55ms，清表只是一条 DELETE 批次。
beforeAll(async () => {
  await prepareStatic();
});

beforeEach(async () => {
  // 只清业务表；`meta` 绝不碰（migrate 靠 meta.schemaVersion 判断跑不跑）。
  // `workspaces` 级联 conversations → messages → conversation_assets，删完再删素材行。
  await db.tx((tx) => [
    tx.run("DELETE FROM notices"),
    tx.run("DELETE FROM questions"),
    tx.run("DELETE FROM workspaces"),
    tx.run("DELETE FROM assets"),
    tx.run("DELETE FROM credentials"),
  ]);
  // 项目目录里的 `.ai-zen/handoffs` 是用例写下的产物（有的用例还断言它「不存在」），
  // 共享目录下必须每个用例先回到干净状态；配置与 agents/ 、skills/ 是静态的，不动。
  await rm(join(projectDir, ".ai-zen"), { recursive: true, force: true });

  harness = await seedHarness();
  const rows = await harness.conversations.list();
  conversationId = rows[0]?.id ?? "";
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("自交接：同一个驱动者写（PRD 4.5）", () => {
  it("不另造驱动者：文档由这段对话自己的那个 agent 写出来", async () => {
    const built = harness.build();
    await built.service.start({ conversationId, mode: "self", then: "document_only" });
    await built.settle();

    // 没有「另起一个一次性驱动者」这回事
    expect(harness.agentContexts).toHaveLength(0);
    // 指令确实投给了它，而且带着磁盘上那份 Skill 的正文
    expect(built.instructions).toHaveLength(1);
    expect(built.instructions[0]).toContain(SKILL_MARKER);
    const dir = handoffDirFor(harness.projectDir);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it("读不到 Skill 时用 SDK 的兜底模板", async () => {
    const built = harness.build({ skillDirs: [] });
    await built.service.start({ conversationId, mode: "self", then: "document_only" });
    await built.settle();

    expect(built.instructions[0]).toContain("# Handoff Document");
    expect(built.instructions[0]).not.toContain(SKILL_MARKER);
  });

  it("交接期间挂牌、写完摘牌（只跳过写库，事件照推）", async () => {
    const built = harness.build();
    await built.service.start({ conversationId, mode: "self", then: "document_only" });
    await built.settle();

    // 挂牌在指令落地之前，摘牌在收尾那一处
    expect(built.runnerCalls).toEqual([
      `begin:${conversationId}`,
      `deliver:${conversationId}`,
      `end:${conversationId}`,
    ]);
  });

  it("「写完了」看那次写工具的结果：工具结果到了 + 盘上够长 → 当场提交", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    const built = harness.build({ notices });
    const toolFinished: string[] = [];
    built.driver.on("toolFinished", (payload) => {
      toolFinished.push(payload.toolCall?.function?.name ?? "?");
    });

    await built.service.start({ conversationId, mode: "self", then: "document_only" });
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

  it("空闲时投一条指令 → 它的工具结果说写了 → 提交（全程不碰暂停）", async () => {
    const built = harness.build();
    const outcomes: string[] = [];
    built.driver.on("toolFinished", (payload) => {
      outcomes.push(payload.toolCall?.function?.name ?? "?");
    });

    await built.service.start({ conversationId, mode: "self", then: "document_only" });
    await built.settle();

    // 一条指令、恰一次写工具的结果、盘上一份文档：这三个就是那一链的全部事实
    expect(built.instructions).toHaveLength(1);
    expect(outcomes).toEqual(["write"]);
    expect(await readdir(handoffDirFor(harness.projectDir))).toHaveLength(1);
    // 全程既没按暂停也没放行：入口「先闲着」已经够了
    expect(built.driverCalls).toEqual([]);
  });

  it("写不出来就单向降级到独立交接，并说清楚退了哪一档（F-D7）", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    // 写工具调用了，但盘上没有那份文档 → 落盘校验这一道不成立
    const built = harness.build({ notices, writesDocument: false });
    await built.service.start({ conversationId, mode: "self", then: "document_only" });
    await built.settle();

    // 同一档位再问了一次之后仍旧没写出来 → 另起一次性驱动者写（它写进了同一个目录）
    expect(built.instructions).toHaveLength(2);
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

  it("不收件的对话也不让跑：不替用户恢复收件", async () => {
    const built = harness.build();
    // 用户按过中断 / 让停下：不收件就是他的意愿，交接不得去开那个开关
    built.driver.pauseConsumption();
    built.driver.calls.length = 0;

    await expect(
      built.service.start({ conversationId, mode: "self", then: "document_only" }),
    ).rejects.toMatchObject({ code: "busy", detail: { reason: "not_idle" } });

    // 开关还开着（没人去动它）、一条指令未投
    expect(built.driver.consumptionPaused).toBe(true);
    expect(built.driverCalls).toEqual([]);
    expect(built.runnerCalls).toEqual([]);
  });

  it("中断（用户按了中断＝放弃交接）→ 回到交接前，并说不交接了", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    // 这一趟的第一片永远不来：于是「掐在途」必然落在正在跑的那一批上
    const driver = new RecordingAgent([{ gate: new Promise<void>(() => undefined) }]);
    const built = harness.build({ notices, driver });

    const working = new Promise<void>((resolve) => {
      driver.on("state:working", () => resolve());
    });
    await built.service.start({ conversationId, mode: "self", then: "document_only" });
    await working;
    driver.abort();
    await built.settle();

    expect(driver.consumptionPaused).toBe(true);
    const listed = await notices.list({});
    expect(
      listed.notices.some((notice) => notice.text.messageKey === "error.handoffDeclined"),
    ).toBe(true);
  });
});

describe("独立交接（一次性驱动者 + 记忆副本）", () => {
  it("文档真的落在 <cwd>/.ai-zen/handoffs/ 下，大小从磁盘取，写完落一条通知", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    const built = harness.build({ notices });
    await built.service.start({ conversationId, mode: "summary", then: "document_only" });
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
    expect(writtenNotice?.conversationId).toBe(conversationId);
    // 文件事实从磁盘取：大小与盘上那一份一致
    expect((await stat(path)).size).toBeGreaterThan(0);
  });

  it("拿的是这段对话的历史（omit 的不给）", async () => {
    await harness.messages.upsert({
      id: "msg-omit",
      conversationId,
      role: AgentNS.Role.User as string,
      status: AgentNS.MessageStatus.Completed as string,
      omit: true,
      content: "这条已经不在上下文里了",
      createdAt: 1_700_000_003_000,
    });
    const built = harness.build();
    await built.service.start({ conversationId, mode: "summary", then: "document_only" });
    await built.settle();

    const context = harness.agentContexts[0];
    expect(context?.conversationId).toBe(conversationId);
    expect(context?.history.map((message) => message.id)).toEqual(["msg-user", "msg-assistant"]);
  });

  it("交接之后开新对话（D18）：身份照抄，旧对话一行不动", async () => {
    const built = harness.build();
    const before = await harness.messages.listByConversation(conversationId);
    await built.service.start({ conversationId, mode: "summary", then: "new_conversation" });
    await built.settle();

    const rows = await harness.conversations.list();
    expect(rows).toHaveLength(2);
    const newRow = rows.find((row) => row.id !== conversationId);
    const oldRow = await harness.conversations.get(conversationId);
    expect(newRow?.workspaceId).toBe(oldRow?.workspaceId);
    expect(newRow?.agentId).toBe(oldRow?.agentId);
    expect(newRow?.modelId).toBe(oldRow?.modelId);

    // 旧的完整保留：消息与身份都没动
    const after = await harness.messages.listByConversation(conversationId);
    expect(after.map((message) => message.id)).toEqual(before.map((message) => message.id));

    // 新对话开场：先是会话创建时那条 hidden 的 cwd 消息，再是一条宿主注入的交接摘要
    const newId = newRow?.id ?? "";
    const seeded = await harness.messages.listByConversation(newId, undefined, {
      includeHidden: true,
    });
    expect(seeded).toHaveLength(2);
    expect(seeded[0]?.role).toBe(AgentNS.Role.User);
    expect(seeded[0]?.data).toMatchObject({ hidden: true });
    expect(seeded[1]?.role).toBe(AgentNS.Role.System);
    expect(seeded[1]?.data).toMatchObject({ hidden: true });

    // 开新对话这件事靠一条 `conversation.changed(created)` 告知界面
    expect(
      built.events.changed.some(
        (change) => change.change === "created" && change.conversationId === newId,
      ),
    ).toBe(true);
  });

  it("压缩标记落在被压的那一段上：`new_conversation` 记 manual，`document_only` 不记", async () => {
    const only = harness.build();
    await only.service.start({ conversationId, mode: "summary", then: "document_only" });
    await only.settle();
    expect(await harness.conversations.get(conversationId)).toMatchObject({
      compactedAt: null,
      compactionMode: null,
    });

    const next = harness.build();
    await next.service.start({ conversationId, mode: "summary", then: "new_conversation" });
    await next.settle();
    const row = await harness.conversations.get(conversationId);
    expect(row?.compactionMode).toBe("manual");
    expect(typeof row?.compactedAt).toBe("number");
  });

  it("只产文档不换会话（F-D4）", async () => {
    const built = harness.build();
    await built.service.start({ conversationId, mode: "summary", then: "document_only" });
    await built.settle();
    expect(await harness.conversations.list()).toHaveLength(1);
  });

  it("带 questionId 的那条路径：答完之后问题被标成已答", async () => {
    await harness.questions.create({
      id: "q1",
      conversationId,
      kind: "handoff",
      payload: {
        code: "question.handoff.prompt",
        prompt: { messageKey: "question.handoff.prompt", params: { percent: 90 } },
        options: [],
        blocking: true,
      },
      state: "pending",
      createdAt: 1,
    });

    const built = harness.build();
    await built.service.start({
      conversationId,
      mode: "summary",
      then: "document_only",
      questionId: "q1",
    });
    await built.settle();

    const row = await harness.questions.get("q1");
    expect(row?.state).toBe("answered");
    expect(row?.answer).toMatchObject({ value: "summary" });
  });
});

describe("取消与失败（F-D7）", () => {
  it("用户取消：说不交接了，不留文档、不开新对话", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    const built = harness.build({
      notices,
      execute: async () => {
        throw new HandoffCancelledError();
      },
    });

    await built.service.start({ conversationId, mode: "summary", then: "new_conversation" });
    await built.settle();

    expect(await harness.conversations.list()).toHaveLength(1);
    const dir = handoffDirFor(harness.projectDir);
    await expect(readdir(dir)).rejects.toBeTruthy();
    const listed = await notices.list({});
    expect(
      listed.notices.some((notice) => notice.text.messageKey === "error.handoffDeclined"),
    ).toBe(true);
  });

  it("真失败：说清楚没走通，并回到交接前", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    const built = harness.build({
      notices,
      execute: async () => {
        throw new Error("模型没写出来");
      },
    });

    await built.service.start({ conversationId, mode: "summary", then: "document_only" });
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
  it("在干的时候不让跑：handoff.start 直接拒（busy + not_idle）", async () => {
    // 第一片永远不来：它一直在干（手上的活没完，待办里也不该被插一条交接指令）
    const driver = new RecordingAgent([{ gate: new Promise<void>(() => undefined) }]);
    const built = harness.build({ driver });
    const working = new Promise<void>((resolve) => {
      driver.on("state:working", () => resolve());
    });
    driver.push({ content: "先聊一句", priority: "high", source: { kind: "user" } });
    void driver.start();
    await working;

    await expect(
      built.service.start({ conversationId, mode: "self", then: "document_only" }),
    ).rejects.toMatchObject({ code: "busy", detail: { reason: "not_idle" } });

    // 拒绝就是拒绝：没挂牌、没投递，驱动者也没被打断（掐在途那套编排已经作废）
    expect(built.runnerCalls).toEqual([]);
    expect(built.instructions).toEqual([]);
    expect(driver.abortCalls).toBe(0);
    expect(driver.state).toBe("working");
  });

  it("没有 agent 也不让跑：没有人可写", async () => {
    const built = harness.build({ holder: { get: () => undefined } });
    await expect(
      built.service.start({ conversationId, mode: "self", then: "document_only" }),
    ).rejects.toMatchObject({ code: "busy", detail: { reason: "not_idle" } });
    expect(built.runnerCalls).toEqual([]);
    // 什么都没开始：没有另起驱动者去写文档
    expect(harness.agentContexts).toHaveLength(0);
  });

  it("对话不存在报 not_found（这一条在返回「已经开始」之前）", async () => {
    const built = harness.build();
    await expect(
      built.service.start({ conversationId: "没有这段", mode: "summary", then: "document_only" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("执行者与后续动作不认识时按参数不对拒", async () => {
    const built = harness.build();
    await expect(
      built.service.start({
        conversationId,
        mode: "prune" as unknown as "summary",
        then: "document_only",
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      built.service.start({
        conversationId,
        mode: "summary",
        then: "migrate" as unknown as "document_only",
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("用完不还 Scope（没有借用这回事：它活到显式 dispose / 进程退出）", async () => {
    const built = harness.build();
    await built.service.start({ conversationId, mode: "summary", then: "document_only" });
    await built.settle();
    // 只拿过一次（幂等 get-or-create），而且拿完就没再动它
    expect(harness.scopes.acquired).toEqual(["w1"]);
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
