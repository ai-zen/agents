/**
 * 交接的验收：三种选择（自交接 / 独立摘要 / 不交接由问题对象那边管）、文档真的落进
 * `<cwd>/.ai-zen/handoffs/`（D19）、模板来自磁盘上的 `handoff` Skill（读不到用兜底）、
 * 降级要说明（F-D7）、取消不报错（F-D7）、交接后新对话的身份与旧对话的存续（D18）、
 * 只产文档不换会话（F-D4）。
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentNS } from "@ai-zen/agents-core";
import { completeOnce, ConfigManager } from "@ai-zen/agents-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeAgent } from "../runtime/TestSupport.js";
import { createFakeScope } from "../runtime/TestSupport.js";
import type { AgentBuildContext, AgentFactory } from "../runtime/ChatRunner.js";
import { AssetRepository } from "../storage/AssetRepository.js";
import { ConversationRepository } from "../storage/ConversationRepository.js";
import { Database } from "../storage/Database.js";
import { MessageRepository } from "../storage/MessageRepository.js";
import { QuestionRepository } from "../storage/QuestionRepository.js";
import { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import { migrate } from "../storage/migrations.js";
import type { ConversationRuntimePort } from "./ConversationService.js";
import { ConversationService } from "./ConversationService.js";
import { HandoffCancelledError, createSdkHandoffExecutor, HandoffService, handoffDirFor } from "./HandoffService.js";
import type { HandoffExecutor, ScopeBorrower } from "./HandoffService.js";
import { NoticeService } from "./NoticeService.js";
import { NoticeRepository } from "../storage/NoticeRepository.js";

/** 摘要模式用的假客户端：把「指令 + 正文」回声出来，于是一眼能看出模板来自哪一份 */
type SummaryClient = Parameters<typeof completeOnce>[0]["client"];

function echoingClient(): SummaryClient {
  const client = {
    chat: {
      completions: {
        create: async (body: { messages: Array<{ role: string; content: string }> }) => ({
          choices: [
            {
              message: {
                content: `${body.messages[0]?.content ?? ""}\n\n## Handoff from the model\n\n正文。`,
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
  isRunning(): boolean {
    return false;
  }
  getModelOverride(): string | null {
    return null;
  }
  setModelOverride(): void {}
  getThinkingOverride(): string | null {
    return null;
  }
  setThinkingOverride(): void {}
  forget(): void {}
}

/** 借 Scope 的记账实现：真 Scope（cwd 显式给），只记借还与用哪个鍵 */
class RecordingScopes implements ScopeBorrower {
  readonly acquired: string[] = [];
  readonly released: string[] = [];

  constructor(private readonly cwd: string) {}

  async acquire(key: string) {
    this.acquired.push(key);
    return createFakeScope(this.cwd).scope;
  }

  release(key: string): void {
    this.released.push(key);
  }
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
  buildService(options?: {
    execute?: HandoffExecutor;
    skillDirs?: string[];
    runs?: { isRunning(conversationId: string): boolean };
    notices?: NoticeService;
  }): HandoffService;
}

const SKILL_MARKER = "SKILL-MARKER-交接规范";

async function setup(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "ai-zen-handoff-"));
  const projectDir = join(dir, "project");
  await mkdir(projectDir, { recursive: true });

  const db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);

  const workspaces = new WorkspaceRepository(db);
  const conversations = new ConversationRepository(db);
  const messages = new MessageRepository(db);
  const assets = new AssetRepository(db);
  const questions = new QuestionRepository(db);
  const notices = new NoticeRepository(db);
  void notices;

  const configPath = join(dir, "config.json");
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
  const skillsDir = join(dir, "skills");
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

  await workspaces.create({ id: "w1", name: "项目一", cwd: projectDir, createdAt: 1 });

  const conversationService = new ConversationService({
    conversations,
    messages,
    workspaces,
    assets,
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

  // 一段有内容的对话：一轮「用户 + 助手」
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
    buildService: (options = {}) =>
      new HandoffService({
        conversations,
        workspaces,
        messages,
        conversationViews: conversationService,
        scopes,
        createAgent,
        execute: options.execute ?? sdkExecutor(options.skillDirs ?? []),
        ...(options.runs ? { runs: options.runs } : {}),
        ...(options.notices ? { notices: options.notices } : {}),
        questions,
        now: () => 1_700_000_010_000,
      }),
  };

  return harness;
}

/**
 * 真 SDK 执行者（客户端换成回声替身，不连网）。
 *
 * 走真执行者是为了让用例能看到「读不到 Writer 就降级 summary」这类 SDK 事实，
 * 而只换掉最外层的 HTTP 那一跳。
 */
function sdkExecutor(skillDirs: string[]): HandoffExecutor {
  const executor = createSdkHandoffExecutor({
    skillDirs,
    client: echoingClient(),
    model: "handoff-model",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return executor;
}

let harness: Harness;
let conversationId: string;

beforeEach(async () => {
  harness = await setup();
  const rows = await harness.conversations.list();
  conversationId = rows[0]?.id ?? "";
});

afterEach(async () => {
  await harness.db.close();
  await rm(harness.dir, { recursive: true, force: true });
});

describe("交接文档写进项目（D19 / F-D6）", () => {
  it("文档真的落在 <cwd>/.ai-zen/handoffs/ 下，大小从磁盘取", async () => {
    const service = harness.buildService({
      execute: sdkExecutor([join(harness.dir, "skills")]),
    });
    const result = await service.start({ conversationId, mode: "summary", then: "document_only" });

    const dir = handoffDirFor(harness.projectDir);
    expect(result.document.path.startsWith(dir)).toBe(true);
    expect(result.document.path.endsWith(".md")).toBe(true);
    expect(result.document.mode).toBe("summary");

    const stat0 = await stat(result.document.path);
    expect(stat0.isFile()).toBe(true);
    expect(result.document.bytes).toBe(stat0.size);
    expect(result.document.bytes).toBeGreaterThan(0);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it("模板来自磁盘上的 handoff Skill（readSkill）", async () => {
    const service = harness.buildService({
      execute: sdkExecutor([join(harness.dir, "skills")]),
    });
    const result = await service.start({ conversationId, mode: "summary", then: "document_only" });
    const written = await readFile(result.document.path, "utf-8");
    expect(written).toContain(SKILL_MARKER);
  });

  it("读不到 Skill 时用 SDK 的兜底模板", async () => {
    const service = harness.buildService({ execute: sdkExecutor([]) });
    const result = await service.start({ conversationId, mode: "summary", then: "document_only" });
    const written = await readFile(result.document.path, "utf-8");
    expect(written).toContain("# Handoff Document");
    expect(written).not.toContain(SKILL_MARKER);
  });

  it("这一轮拿到的是这段对话的历史（omit 的不给）", async () => {
    await harness.messages.upsert({
      id: "msg-omit",
      conversationId,
      role: AgentNS.Role.User as string,
      status: AgentNS.MessageStatus.Completed as string,
      omit: true,
      content: "这条已经不在上下文里了",
      createdAt: 1_700_000_003_000,
    });
    const service = harness.buildService({ execute: sdkExecutor([]) });
    await service.start({ conversationId, mode: "summary", then: "document_only" });

    const context = harness.agentContexts[0];
    expect(context?.conversationId).toBe(conversationId);
    expect(context?.history.map((message) => message.id)).toEqual(["msg-user", "msg-assistant"]);
  });
});

describe("降级要说明（F-D7）", () => {
  it("选了自交接但助手写不出文档 → 退到独立摘要，并说明为什么", async () => {
    const service = harness.buildService({ execute: sdkExecutor([]) });
    const result = await service.start({ conversationId, mode: "self", then: "document_only" });

    expect(result.requestedMode).toBe("self");
    expect(result.usedMode).toBe("summary");
    expect(result.degraded).toBe(true);
    expect(result.problem?.messageKey).toBe("handoff.degraded");
    expect(result.problem?.params.mode).toBe("summary");
    expect(result.problem?.message.length).toBeGreaterThan(0);
    // 降级也算成功：文档在
    const written = await readFile(result.document.path, "utf-8");
    expect(written.length).toBeGreaterThan(0);
  });

  it("没降级时 problem 为空", async () => {
    const service = harness.buildService({ execute: sdkExecutor([]) });
    const result = await service.start({ conversationId, mode: "summary", then: "document_only" });
    expect(result.degraded).toBe(false);
    expect(result.problem).toBeNull();
  });
});

describe("取消是「不交接」，不是失败（F-D7）", () => {
  it("用户取消：回 handoff_declined，不留文档、不开新对话", async () => {
    const service = harness.buildService({
      execute: async () => {
        throw new HandoffCancelledError();
      },
    });

    await expect(
      service.start({ conversationId, mode: "self", then: "new_conversation" }),
    ).rejects.toMatchObject({ code: "handoff_declined" });

    expect(await harness.conversations.list()).toHaveLength(1);
    const dir = handoffDirFor(harness.projectDir);
    await expect(readdir(dir)).rejects.toBeTruthy();
  });

  it("真失败：报 internal + 「交接没走通」那条文案", async () => {
    const service = harness.buildService({
      execute: async () => {
        throw new Error("模型没写出来");
      },
    });
    await expect(
      service.start({ conversationId, mode: "summary", then: "document_only" }),
    ).rejects.toMatchObject({
      code: "internal",
      messageKey: "error.handoffFailed",
      detail: { reason: "模型没写出来" },
    });
  });
});

describe("交接之后开新对话（D18）", () => {
  it("新对话与旧对话同 Workspace 同助手，旧对话完整保留", async () => {
    const service = harness.buildService({ execute: sdkExecutor([]) });
    const before = await harness.messages.listByConversation(conversationId);

    const result = await service.start({
      conversationId,
      mode: "summary",
      then: "new_conversation",
    });

    expect(result.newConversationId).not.toBeNull();
    const newId = result.newConversationId ?? "";
    expect(newId).not.toBe(conversationId);

    const oldRow = await harness.conversations.get(conversationId);
    const newRow = await harness.conversations.get(newId);
    expect(newRow?.workspaceId).toBe(oldRow?.workspaceId);
    expect(newRow?.agentId).toBe(oldRow?.agentId);
    expect(newRow?.modelId).toBe(oldRow?.modelId);

    // 旧的完整保留：消息与身份都没动
    const after = await harness.messages.listByConversation(conversationId);
    expect(after.map((message) => message.id)).toEqual(before.map((message) => message.id));
    expect(await harness.conversations.list()).toHaveLength(2);

    // 新对话开场：先是会话创建时那条 hidden 的 cwd 消息，再是一条服务端注入的交接摘要
    // （两条都 `hidden`，所以读取时要显式要）
    const seeded = await harness.messages.listByConversation(newId, undefined, {
      includeHidden: true,
    });
    expect(seeded).toHaveLength(2);
    expect(seeded[0]?.role).toBe(AgentNS.Role.User);
    expect(seeded[0]?.data).toMatchObject({ hidden: true });
    expect(seeded[1]?.role).toBe(AgentNS.Role.System);
    expect(seeded[1]?.data).toMatchObject({ hidden: true });
    const content = seeded[1]?.content;
    expect(typeof content === "string" ? content : JSON.stringify(content)).toContain(
      result.document.path,
    );
    // 返回的旧对话形状：旧对话还是旧对话，不被新对话顶掉
    expect(result.conversation.id).toBe(conversationId);
  });

  it("只产文档不换会话（F-D4）", async () => {
    const service = harness.buildService({ execute: sdkExecutor([]) });
    const result = await service.start({ conversationId, mode: "summary", then: "document_only" });
    expect(result.newConversationId).toBeNull();
    expect(await harness.conversations.list()).toHaveLength(1);
  });

  it("答完那道题之后，问题被标成已答（带 questionId 的那条路径）", async () => {
    const asked = await harness.questions.create({
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
    void asked;

    const service = harness.buildService({ execute: sdkExecutor([]) });
    await service.start({
      conversationId,
      mode: "summary",
      then: "document_only",
      questionId: "q1",
    });

    const row = await harness.questions.get("q1");
    expect(row?.state).toBe("answered");
    expect(row?.answer).toMatchObject({ value: "summary" });
  });
});

describe("前置条件", () => {
  it("对话正在跑一轮时拒绝交接（D22：停下之后才交接）", async () => {
    const service = harness.buildService({
      execute: sdkExecutor([]),
      runs: { isRunning: () => true },
    });
    await expect(
      service.start({ conversationId, mode: "summary", then: "document_only" }),
    ).rejects.toMatchObject({ code: "busy" });
    expect(harness.scopes.acquired).toEqual([]);
  });

  it("对话不存在报 not_found", async () => {
    const service = harness.buildService({ execute: sdkExecutor([]) });
    await expect(
      service.start({ conversationId: "没有这段", mode: "summary", then: "document_only" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("执行者与后续动作不认识时按参数不对拒", async () => {
    const service = harness.buildService({ execute: sdkExecutor([]) });
    await expect(
      service.start({ conversationId, mode: "summary", then: "document_only" }),
    ).resolves.toBeTruthy();
    await expect(
      service.start({
        conversationId,
        mode: "prune" as unknown as "summary",
        then: "document_only",
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      service.start({
        conversationId,
        mode: "summary",
        then: "migrate" as unknown as "document_only",
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("用完把 Scope 还回去（借还各一次）", async () => {
    const service = harness.buildService({ execute: sdkExecutor([]) });
    await service.start({ conversationId, mode: "summary", then: "document_only" });
    expect(harness.scopes.acquired).toEqual(["w1"]);
    expect(harness.scopes.released).toEqual(["w1"]);
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

    const service = harness.buildService({ execute: sdkExecutor([]) });
    const listed = await service.listDocuments({ workspaceId: "w1" });
    expect(listed.documents.map((document) => document.name)).toEqual([
      "20260102-000000.md",
      "20260101-000000.md",
    ]);
    expect(listed.documents[0]?.path).toBe(join(dir, "20260102-000000.md"));
    expect(listed.documents[0]?.bytes).toBeGreaterThan(0);
    expect(listed.documents[0]?.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("目录还不存在时回空列表（第一次交接之前本来就没有它）", async () => {
    const service = harness.buildService({ execute: sdkExecutor([]) });
    expect(await service.listDocuments({ workspaceId: "w1" })).toEqual({ documents: [] });
  });

  it("项目不存在报 not_found", async () => {
    const service = harness.buildService({ execute: sdkExecutor([]) });
    await expect(service.listDocuments({ workspaceId: "没有这个项目" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

/** 让两次写入的 mtime 不同（有些文件系统的时间精度是秒级） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 通知通道单独一条：文档写好后要有一条「写好了」的提示（F-I8） */
describe("交接完成的通知（F-I8）", () => {
  it("文档写好后落一条 info 通知，指到文件路径", async () => {
    const notices = new NoticeService({ notices: new NoticeRepository(harness.db) });
    const service = new HandoffService({
      conversations: harness.conversations,
      workspaces: new WorkspaceRepository(harness.db),
      messages: harness.messages,
      conversationViews: harness.conversationService,
      scopes: harness.scopes,
      createAgent: async (context) => {
        harness.agentContexts.push(context);
        return new FakeAgent([{ deltas: [{ content: "交接" }] }]);
      },
      execute: sdkExecutor([]),
      notices,
      now: () => 1_700_000_010_000,
    });

    const result = await service.start({ conversationId, mode: "summary", then: "document_only" });
    const listed = await notices.list({});
    expect(listed.notices).toHaveLength(1);
    expect(listed.notices[0]?.level).toBe("info");
    expect(listed.notices[0]?.text.messageKey).toBe("notice.handoffWritten");
    expect(listed.notices[0]?.text.params).toEqual({ path: result.document.path });
    expect(listed.notices[0]?.conversationId).toBe(conversationId);
  });
});
