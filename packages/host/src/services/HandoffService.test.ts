/**
 * 交接的验收：谁写文档（自交接＝同一个驱动者接着写 / 独立摘要＝拿这段记忆去问模型）、文档真的落进
 * `<cwd>/.ai-zen/handoffs/`（D19）、模板来自磁盘上的 `handoff` Skill（读不到用兜底）、
 * 降级要说明（F-D7）、取消不报错（F-D7）、换记忆与存档会话（PRD 4.5）、只产文档不另开对话（F-D4）。
 *
 * 四件口径：
 *
 * 1. `start()` 只回「已经开始」，那一趟在后台跑。所以每个用例都靠那条**摘牌**（`endHandoff`，
 *    `runToEnd` 的 `finally` 里最后一个动作）等它收尾 —— 提交与回滚都从那里过去，于是「跑完了没有」
 *    这件事有一个确定的答案，而不是靠睡一会儿。只看 `memory_replaced` 不够：那条在提交点就推了，
 *    后面还有 `afterCommit`（开新对话 / 标压缩 / 把题标已答）。
 * 2. 「写完了没有」由 SDK 判（那次写文档的工具调用的输入与结果）；宿主只做提交之后那一半 ——
 *    文档在盘上、够长，就换记忆。
 * 3. 入口判据只有一条：**那段对话闲着才发起**。非空闲（忙 / 暂停 / 没有 agent）直接拒，
 *    交接全程不碰暂停、也不替谁放行。
 * 4. 提交之后**旧记忆是另一段会话**（`已存档_<原名>`）、原会话只留「系统提示 + cwd 消息 +
 *    断点消息」（cwd 在前：换完记忆这一段还得知道自己站在哪个目录里）；库里那几条语句
 *    在同一批里，失败一段存档会话都不留。
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentNS, Message } from "@ai-zen/agents-core";
import { completeOnce, ConfigManager } from "@ai-zen/agents-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ChatEventEmitter, ChatAgent } from "../runtime/ChatRunner.js";
import { createFakeScope, FakeAgent, flushMicrotasks } from "../runtime/TestSupport.js";
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
} from "./HandoffService.js";
import { NoticeService } from "./NoticeService.js";

/** 摘要模式用的假客户端：把「指令 + 正文」回声出来，于是一眼能看出模板来自哪一份 */
type SummaryClient = Parameters<typeof completeOnce>[0]["client"];

/** 文档正文（要过 400 字节那道坎，所以写长一点） */
const DOCUMENT_BODY = `## 任务目标\n\n把交接写完。\n\n${"正文。".repeat(200)}`;

/** 驱动者开局手里那条系统提示（来自助手定义）：换记忆之后它得还在 */
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

/** 对话服务要的那个窄接口：交接用例不需要临时模型 / 临时档位，也没有活着的驱动者 */
class FakeRuntime implements ConversationRuntimePort {
  status(): ConversationStatus {
    return "dead";
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

/** 记账的驱动者：它就是 core 的 `Agent`（真的循环、真的取件），把「翻上/翻回不取件开关」接过来记一笔 */
class RecordingAgent extends FakeAgent {
  readonly calls: string[] = [];

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
  /** 投出去的指令（SDK 投的：从驱动者的消息里认出来，一条一条看得到） */
  instructions: string[];
  events: EventLog;
  /**
   * 一次交接的跑法：起一趟、等它收尾。
   *
   * 「收尾了」= 挂的那块牌子摘了（`endHandoff`）：它是 `runToEnd` 的 `finally` 里最后一步，
   * 四条结局（成功 / 降级 / 失败 / 取消）都从那里过。不能只看 `memory_replaced` —— 那条在**提交点**
   * 就推了，而它后面还有 `afterCommit`（开新对话 / 标压缩 / 把题标已答），以及在 `finally` 里的
   * 截记忆与摘牌：停在那里断言等于只测了一半（而 `afterCommit` 里的差错是吞掉上报的，看不见）。
   */
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
  build(options?: {
    execute?: HandoffExecutor;
    notices?: NoticeService;
    driver?: RecordingAgent;
    /** 驱动者的持有者（缺省就是手上这个 driver；给 `{ get: () => undefined }` 验「没有 agent」那条） */
    holder?: HandoffAgentHolder;
    /** 驱动者写出来的正文（给短的就能验「写得太小 → 退到摘要」那条） */
    documentBody?: string;
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

  const harness: Harness = {
    dir,
    projectDir,
    skillsDir,
    db,
    conversations,
    messages,
    questions,
    conversationService,
    build: (options = {}) => {
      /**
       * 驱动者的脚本：先要一次写工具调用，工具跑完再回一句「写好了」。
       *
       * 那次调用的参数按**这一次请求体**现算：文档路径写在刚推进去的交接指令里，模型（脚本）
       * 那一刻才看得见它，于是它写的就是服务要的那一份。`write` 工具是真写盘的那个（见
       * `TestSupport`），所以「盘上有没有这份文档」是事实，不是演出来的。
       */
      const body = options.documentBody ?? DOCUMENT_BODY;
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
       * 这一次交接投出去的指令（SDK 投的，宿主不居中转发）：从驱动者的消息里认出来 ——
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

      /** 交接态那两个开关（真 `ChatRunner` 结构上就是它） */
      const runner: HandoffRunnerPort = {
        beginHandoff: (conversationId) => {
          runnerCalls.push(`begin:${conversationId}`);
        },
        endHandoff: (conversationId) => {
          runnerCalls.push(`end:${conversationId}`);
          ends += 1;
          for (const wake of endWaiters.splice(0)) wake();
        },
      };

      const agents: HandoffAgentHolder = options.holder ?? { get: () => driver };
      const { log, emit } = watchEvents();
      // 模板目录按 cwd 现算（生产上就是「项目里放一份同名 Skill 覆盖全局那份」）
      const templateDirs = options.skillDirs ?? [join(skillsDir)];

      const service = new HandoffService({
        conversations,
        workspaces,
        messages,
        conversationViews: conversationService,
        execute: options.execute ?? sdkExecutor(),
        agents,
        runner,
        ...(options.notices ? { notices: options.notices } : {}),
        questions,
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

    // 指令确实投给了它（宿主没有另起一个驱动者），而且带着磁盘上那份 Skill 的正文
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

    // 挂牌在指令落地之前，摘牌在收尾那一处（投递不经过宿主：写文档那条指令由 SDK 投）
    expect(built.runnerCalls).toEqual([`begin:${conversationId}`, `end:${conversationId}`]);
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

  it("写不出来就单向降级到独立摘要，并说清楚退了哪一档（F-D7）", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    // 写工具真调了、也真落盘了，但写出来的那一份太小 → 盘上这道校验不成立
    const built = harness.build({ notices, documentBody: "太短" });
    await built.service.start({ conversationId, mode: "self", then: "document_only" });
    await built.settle();

    // 同一档再问了一次之后仍旧不够 → 降级到摘要那一档（它写进了同一个目录）
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
    built.driver.pauseOutput();
    built.driver.calls.length = 0;

    await expect(
      built.service.start({ conversationId, mode: "self", then: "document_only" }),
    ).rejects.toMatchObject({ code: "busy", detail: { reason: "not_idle" } });

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
    await built.service.start({ conversationId, mode: "self", then: "document_only" });
    await working;
    driver.abort();
    await built.settle();

    expect(driver.isOutputPaused).toBe(true);
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

  it("摘要拿的是这段对话的记忆（omit 的不给）", async () => {
    // 驱动者的记忆就是这段对话的记忆（真实现里由 `ChatRunner` 装配时把历史装进去）
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
    await built.service.start({ conversationId, mode: "summary", then: "document_only" });
    await built.settle();

    // 发给模型的是这段记忆（序列化后那句一句都在），已经 omit 的那条不在里面
    expect(asked).toContain("帮我看看这个仓库的测试为什么慢");
    expect(asked).toContain("慢在 storage 的每个用例都新开库。");
    expect(asked).not.toContain("这条已经不在上下文里了");
  });

  it("交接之后开新对话（D18）：身份照抄，开场是那条交接摘要", async () => {
    const built = harness.build();
    await built.service.start({ conversationId, mode: "summary", then: "new_conversation" });
    await built.settle();

    const rows = await harness.conversations.list();
    const oldRow = await harness.conversations.get(conversationId);
    // 多出来的两段：存档（旧记忆）与交接新开的那一段
    const created = rows.filter((row) => row.id !== conversationId);
    expect(created).toHaveLength(2);
    const archived = created.find((row) => row.name.startsWith("已存档_"));
    const newRow = created.find((row) => row.id !== archived?.id);
    expect(archived).toBeDefined();
    expect(newRow?.workspaceId).toBe(oldRow?.workspaceId);
    expect(newRow?.agentId).toBe(oldRow?.agentId);
    expect(newRow?.modelId).toBe(oldRow?.modelId);

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

  it("只产文档就只多出那段存档（F-D4）：不另开新对话", async () => {
    const built = harness.build();
    await built.service.start({ conversationId, mode: "summary", then: "document_only" });
    await built.settle();
    const rows = await harness.conversations.list();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.name.startsWith("已存档_"))).toHaveLength(1);
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

describe("换记忆：旧记忆成为另一段会话（PRD 4.5）", () => {
  it("提交之后：原会话剩「cwd + 断点」两条，旧记忆整段挂到 `已存档_<原名>` 名下", async () => {
    const built = harness.build();
    const before = await harness.messages.listByConversation(conversationId, undefined, {
      includeHidden: true,
    });
    const original = await harness.conversations.get(conversationId);
    await built.service.start({ conversationId, mode: "summary", then: "document_only" });
    await built.settle();

    // 原会话：库里剩两条 `hidden` 消息 —— cwd 在前、断点在后
    const left = await harness.messages.listByConversation(conversationId, undefined, {
      includeHidden: true,
    });
    expect(left).toHaveLength(2);

    // 第一条：cwd 消息（旧记忆里那条创建时的已经随旧记忆搬走了，换完得重新知道自己在哪个目录）
    const cwdRow = left[0];
    expect(cwdRow?.role).toBe(AgentNS.Role.User);
    expect(cwdRow?.data).toMatchObject({ hidden: true });
    // 宿主注入的，所以来源是「宿主 / cwd」，不落成用户说的话
    expect(cwdRow?.source).toMatchObject({ kind: "system", label: "cwd" });
    expect(String(cwdRow?.content)).toContain(harness.projectDir);

    // 第二条：断点消息，正文只有那份文档的路径
    const breakpointRow = left[1];
    expect(breakpointRow?.role).toBe(AgentNS.Role.System);
    expect(breakpointRow?.data).toMatchObject({ hidden: true });
    // 顺序是硬要求：cwd 排在断点之前（与创建时「cwd 最先写」同一口径）
    expect(cwdRow?.seq).toBeLessThan(breakpointRow?.seq ?? 0);
    const path = breakpointRow?.content as string;
    expect(path.startsWith(handoffDirFor(harness.projectDir))).toBe(true);
    expect(path.endsWith(".md")).toBe(true);
    // 文档正文一个字都不进记忆：断点带的是路径，正文由需要细节的一方自己去读
    expect(path.length).toBeLessThan(200);
    expect(await readFile(path, "utf-8")).toContain("任务目标");
    // `hidden` 的两条也不进默认可见集（不进条数、不给人看，但照常进上下文）
    expect(await harness.messages.listByConversation(conversationId)).toHaveLength(0);

    // 存档那段：名字加前缀、身份照抄、消息整段挂过去（`seq` / `createdAt` 原样不动）
    const archived = (await harness.conversations.list()).find(
      (row) => row.name === `已存档_${original?.name}`,
    );
    expect(archived).toBeDefined();
    expect(archived?.workspaceId).toBe(original?.workspaceId);
    expect(archived?.agentId).toBe(original?.agentId);
    expect(archived?.modelId).toBe(original?.modelId);
    expect(archived?.thinkingLevel).toBe(original?.thinkingLevel);
    // 它就是交接那一刻生成的（按自己的时间排在列表里）
    expect(archived?.createdAt).toBe(1_700_000_010_000);
    const moved = await harness.messages.listByConversation(archived?.id ?? "", undefined, {
      includeHidden: true,
    });
    expect(moved.map((row) => [row.id, row.seq, row.createdAt])).toEqual(
      before.map((row) => [row.id, row.seq, row.createdAt]),
    );
  });

  it("内存里原地换：不重建 agent、不动队列与两个开关，系统提示与 cwd 都还在", async () => {
    const built = harness.build();
    // 这段对话的记忆就是这个数组（换记忆是原地换，不是换一个数组、更不是换一个 agent）
    const memory = built.driver.messages;
    await built.service.start({ conversationId, mode: "self", then: "document_only" });
    await built.settle();

    expect(built.driver.messages).toBe(memory);
    // 系统提示 + cwd 消息 + 断点消息：内存那份与库里同一份，cwd 同样在断点之前
    expect(built.driver.messages).toHaveLength(3);
    expect(built.driver.messages[0]?.content).toBe(DRIVER_SYSTEM_PROMPT);
    const cwdMessage = built.driver.messages[1];
    expect(cwdMessage?.role).toBe(AgentNS.Role.User);
    expect(cwdMessage?.hidden).toBe(true);
    expect(String(cwdMessage?.content)).toContain(harness.projectDir);
    const breakpoint = built.driver.messages[2];
    expect(breakpoint?.role).toBe(AgentNS.Role.System);
    expect(breakpoint?.hidden).toBe(true);

    // 落库与内存必须一致：同样的两条（同 id、同正文、同顺序）
    const rows = await harness.messages.listByConversation(conversationId, undefined, {
      includeHidden: true,
    });
    expect(rows.map((row) => row.id)).toEqual([cwdMessage?.id, breakpoint?.id]);
    expect(rows[0]?.content).toBe(cwdMessage?.content);
    expect(rows[1]?.content).toBe(breakpoint?.content);

    // 换记忆不等于换人：没按过暂停、也没替谁恢复
    expect(built.driverCalls).toEqual([]);
    expect(built.driver.isOutputPaused).toBe(false);
  });

  it("推两条变更：先「这段的记忆换过了」，再「那段已存档的出现了」", async () => {
    const built = harness.build();
    await built.service.start({ conversationId, mode: "summary", then: "document_only" });
    await built.settle();

    const archived = (await harness.conversations.list()).find((row) =>
      row.name.startsWith("已存档_"),
    );
    expect(
      built.events.changed.map((change) => `${change.change}:${change.conversationId}`),
    ).toEqual([`memory_replaced:${conversationId}`, `created:${archived?.id}`]);
  });

  it("存档是一段普通会话：能读、能删，删它不连坐原会话", async () => {
    const built = harness.build();
    await built.service.start({ conversationId, mode: "summary", then: "document_only" });
    await built.settle();

    const archived = (await harness.conversations.list()).find((row) =>
      row.name.startsWith("已存档_"),
    );
    const archivedId = archived?.id ?? "";
    // 它就是一段普通会话：消息照样取得出来
    expect((await harness.messages.listByConversation(archivedId)).map((row) => row.id)).toEqual([
      "msg-user",
      "msg-assistant",
    ]);

    await harness.conversations.delete(archivedId);
    expect(await harness.conversations.get(archivedId)).toBeUndefined();
    expect(await harness.messages.listByConversation(archivedId)).toHaveLength(0);
    // 删一段就是删那一段：原会话的 cwd 消息与断点消息都还在
    expect(
      await harness.messages.listByConversation(conversationId, undefined, { includeHidden: true }),
    ).toHaveLength(2);
  });

  it("失败时不留存档会话，原会话的消息一条不动", async () => {
    const before = await harness.messages.listByConversation(conversationId, undefined, {
      includeHidden: true,
    });
    const built = harness.build({
      execute: async () => {
        throw new Error("模型没写出来");
      },
    });
    await built.service.start({ conversationId, mode: "summary", then: "document_only" });
    await built.settle();

    // 库里本来就是交接前那一份：没有多出一段会话，也没有被换过的记忆
    expect(await harness.conversations.list()).toHaveLength(1);
    const after = await harness.messages.listByConversation(conversationId, undefined, {
      includeHidden: true,
    });
    expect(after.map((row) => [row.id, row.seq, row.createdAt])).toEqual(
      before.map((row) => [row.id, row.seq, row.createdAt]),
    );
    // 内存里也没被换过
    expect(built.driver.messages).toHaveLength(1);
    expect(built.driver.messages[0]?.content).toBe(DRIVER_SYSTEM_PROMPT);
  });

  it("驱动者在这期间没了：按失败收尾，不留存档会话", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    // 入口判据那一次还看得见它，后台那一趟开始时它已经不在了（对话被删 / 被硬杀）
    const driver = new RecordingAgent();
    let lookups = 0;
    const built = harness.build({
      notices,
      driver,
      holder: { get: () => (lookups++ === 0 ? driver : undefined) },
    });
    await built.service.start({ conversationId, mode: "self", then: "document_only" });
    await built.settle();

    expect(await harness.conversations.list()).toHaveLength(1);
    const listed = await notices.list({});
    const failed = listed.notices.find(
      (notice) => notice.text.messageKey === "error.handoffFailed",
    );
    expect(String(failed?.text.params.reason)).toContain("the driver went away");
  });

  it("连着交接两次：系统提示不被搬走，旧 cwd 与旧断点也不被当成提示留下", async () => {
    const built = harness.build();
    await built.service.start({ conversationId, mode: "self", then: "document_only" });
    await built.settle();
    await waitIdle(built.driver);

    await built.service.start({ conversationId, mode: "self", then: "document_only" });
    await built.settle();

    // 记忆仍然是「系统提示 + 一条 cwd + 一条断点」：第一次那两条属于旧记忆，不该留在原会话里
    expect(built.driver.messages).toHaveLength(3);
    expect(built.driver.messages[0]?.content).toBe(DRIVER_SYSTEM_PROMPT);
    expect(built.driver.messages[1]?.role).toBe(AgentNS.Role.User);
    expect(built.driver.messages[1]?.hidden).toBe(true);
    expect(built.driver.messages[2]?.hidden).toBe(true);
    // cwd 仍然只有一条（第一次那条随旧记忆搬去存档了），而且仍然排在断点之前
    expect(
      built.driver.messages.filter((message) => message.role === AgentNS.Role.User),
    ).toHaveLength(1);

    // 两段存档各自拿着交接前那一份：第一段是整段历史，第二段是上一次的 cwd + 断点
    const archived = (await harness.conversations.list()).filter((row) =>
      row.name.startsWith("已存档_"),
    );
    expect(archived).toHaveLength(2);
    const counts = await Promise.all(
      archived.map(async (row) =>
        (
          await harness.messages.listByConversation(row.id, undefined, { includeHidden: true })
        ).length,
      ),
    );
    expect(counts.sort((left, right) => left - right)).toEqual([2, 3]);
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
    // 什么都没开始：没挂牌、没投指令
    expect(built.runnerCalls).toEqual([]);
    expect(built.instructions).toEqual([]);
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

/** 等这个驱动者真的落到闲（再发起一次交接要它闲着，也要服务收完上一趟） */
async function waitIdle(agent: ChatAgent): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (agent.state === "idle") {
      await flushMicrotasks();
      return;
    }
    await flushMicrotasks();
  }
  throw new Error("驱动者没有回到空闲");
}
