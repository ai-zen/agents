/**
 * 对话服务的验收：项目与助手创建时定死（R18）、侧栏顺序（D13）、改名与置顶各管一件事、
 * 硬删与代价（D17）、撤回（D24）、会话级模型与思考档位（F-B4 / F-B6 / D20）。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigManager, HandoffService } from "@ai-zen/agents-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AssetRepository } from "../storage/AssetRepository.js";
import { ConversationRepository } from "../storage/ConversationRepository.js";
import { Database } from "../storage/Database.js";
import { MessageRepository } from "../storage/MessageRepository.js";
import { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import { migrate } from "../storage/migrations.js";
import { AgentNS } from "@ai-zen/agents-core";

import { HostError } from "../wire/errors.js";
import { ConversationService } from "./ConversationService.js";
import type { ConversationRuntimePort } from "./ConversationService.js";
import type { ConversationCreateParams, ConversationStatus, ConversationView } from "../wire/index.js";

/**
 * 运行时只提供四件事实：这一刻落在哪一格、队里压着几条、删掉之后丢现场、换完模型让驱动者退役
 * （模型与档位本身在会话行上）
 */
class FakeRuntime implements ConversationRuntimePort {
  /** 摆成「忙」的那几段（其余都是闲的） */
  readonly running = new Set<string>();
  /** 每段队里压着几条（不摆就是 0） */
  readonly pending = new Map<string, number>();
  readonly forgotten: string[] = [];
  /** 被要求「让这一段空闲的驱动者退役」的对话（换模型 / 换档位那一手） */
  readonly invalidated: string[] = [];

  status(conversationId: string): ConversationStatus {
    return this.running.has(conversationId) ? "busy" : "idle";
  }
  inboxPending(conversationId: string): number {
    return this.pending.get(conversationId) ?? 0;
  }
  forget(conversationId: string): void {
    this.forgotten.push(conversationId);
  }
  agentState(conversationId: string): AgentNS.AgentState | null {
    // 这一段没有驱动者时才是 `null`（死格）：用例里的 `running` 只表示忙
    return this.running.has(conversationId) ? "working" : "idle";
  }
  invalidateAgent(conversationId: string): void {
    this.invalidated.push(conversationId);
  }
}

/** 临时数据根 + 库 + 配置 + 助手定义，全都在 `mkdtemp` 里，不碰真实 `~/.ai-zen` */
interface Harness {
  dir: string;
  projectDir: string;
  db: Database;
  configPath: string;
  service: ConversationService;
  runtime: FakeRuntime;
  workspaces: WorkspaceRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  assets: AssetRepository;
  /** 挂在这段上的题（现读内存：题不落库） */
  questions: { countPending: (conversationId: string) => number; pending: Map<string, number> };
  /** 推出去的事件（`conversation.changed`，L5 / D22） */
  events: Array<{ name: string; payload: unknown }>;
  /** 交给素材层「归零清扫」的素材 id（每调一次记一笔） */
  sweeps: string[][];
}

const BASE_CONFIG = {
  endpoints: [{ id: "e1", name: "端点一", baseUrl: "https://example.test/v1", apiKey: "key" }],
  models: [
    {
      id: "m1",
      name: "模型一",
      endpointId: "e1",
      tokenThresholds: { handoff: 100, guard: 200 },
      vision: true,
      reasoningPreset: "test-preset",
    },
    {
      id: "m2",
      name: "模型二",
      endpointId: "e1",
      tokenThresholds: { handoff: 50, guard: 150 },
    },
    {
      id: "m3",
      name: "模型三",
      endpointId: "e1",
      tokenThresholds: { handoff: 60, guard: 160 },
      reasoningPreset: "test-preset",
    },
  ],
  defaultModel: "m3",
  defaultAgent: "a1",
};

let harness: Harness;
let clock: number;

// 静态部分（临时数据根 / 库 / 配置与助手文件）整个文件只建一次，见 beforeAll
let dir: string;
let projectDir: string;
let db: Database;
let configPath: string;
let workspaces: WorkspaceRepository;
let conversations: ConversationRepository;
let messages: MessageRepository;
let assets: AssetRepository;
/** 题的口：题不落库，只能问 `QuestionService`（这里给一个可以随意摆数的替身） */
let questions: { countPending: (conversationId: string) => number } & {
  pending: Map<string, number>;
};

/** 推理档位预设（静态文件，用例可能改写它，所以每个用例开头重写一遍） */
const REASONING_PRESETS = {
  "test-preset": {
    levels: {
      low: { reasoning_effort: "low" },
      high: { reasoning_effort: "high" },
    },
  },
};

/**
 * 写本用例的配置。
 *
 * `ConfigManager` 每次读盘、没有缓存：换一份配置不需要换库，写另一份 `config.json` 就够。
 */
async function writeConfig(config: Record<string, unknown> = BASE_CONFIG): Promise<void> {
  await writeFile(configPath, JSON.stringify(config), "utf-8");
}

/** 助手定义（有用例会改写 `agents/a1.json`，所以每个用例开头重写一遍） */
async function writeAgentFiles(): Promise<void> {
  await mkdir(join(dir, "agents"), { recursive: true });
  const agent = (id: string, name: string, extra: Record<string, unknown>) => ({
    id,
    name,
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  });
  await writeFile(
    join(dir, "agents", "a1.json"),
    JSON.stringify(agent("a1", "助手一", { modelId: "m1" })),
    "utf-8",
  );
  await writeFile(
    join(dir, "agents", "a2.json"),
    JSON.stringify(agent("a2", "没绑模型的助手", {})),
    "utf-8",
  );
}

/**
 * 一个用例的那一层内存状态（服务实例 / 假运行时 / 事件与清扫记录）。
 *
 * 库与磁盘上的静态文件是共用的，这一层每用例重建：用例之间的内存状态（草稿、`running`、
 * 推出去的事件）不互相串。
 */
async function buildHarness(): Promise<Harness> {
  const runtime = new FakeRuntime();
  clock = 1_700_000_000_000;
  const events: Array<{ name: string; payload: unknown }> = [];
  const sweeps: string[][] = [];
  const service = new ConversationService({
    conversations,
    messages,
    workspaces,
    assets,
    // 删完之后「还剩几张引用」归素材层判：这里只记下它被问过哪几个素材
    sweepAssets: async (assetIds) => {
      sweeps.push(assetIds);
      return [];
    },
    questions,
    configManager: new ConfigManager(configPath),
    runtime,
    emit: (name, payload) => {
      events.push({ name, payload });
    },
    now: () => (clock += 60_000),
  });

  const harnessValue: Harness = {
    dir,
    projectDir,
    db,
    configPath,
    service,
    runtime,
    workspaces,
    conversations,
    messages,
    assets,
    questions,
    events,
    sweeps,
  };
  await workspaces.create({ id: "w1", name: "项目一", cwd: projectDir, createdAt: 1 });
  return harnessValue;
}

/**
 * 建一段对话并让它落库。
 *
 * R56 之后 `create` 只发 id 与身份（草稿），落库发生在首次 `conversation.send`。这个文件里
 * 绝大多数用例要看的是「落库之后」的行为（排序、改名、撤回、换模型），所以造完直接
 * 用 `ensurePersisted` 落成真行。
 */
async function createPersisted(
  service: ConversationService,
  params: ConversationCreateParams,
): Promise<{ conversation: ConversationView }> {
  const created = await service.create(params);
  if (!created.conversation) throw new Error("conversation.create 没有建出对话");
  await service.ensurePersisted(created.conversation.id);
  return { conversation: created.conversation };
}

/**
 * 静态部分只建一次：临时数据根、库（`migrate` 只跑一次）、配置与助手文件、仓储。
 */
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-services-conversations-"));
  projectDir = join(dir, "project");
  await mkdir(projectDir, { recursive: true });

  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);

  configPath = join(dir, "config.json");
  await writeConfig();
  await writeFile(join(dir, "reasoning-presets.json"), JSON.stringify(REASONING_PRESETS), "utf-8");
  await writeAgentFiles();

  workspaces = new WorkspaceRepository(db);
  conversations = new ConversationRepository(db);
  messages = new MessageRepository(db);
  assets = new AssetRepository(db);
  questions = {
    pending: new Map<string, number>(),
    countPending(conversationId: string) {
      return questions.pending.get(conversationId) ?? 0;
    },
  };
});

beforeEach(async () => {
  // 清表：`meta` 不能清（`migrate` 靠 `meta.schemaVersion` 判断要不要跑迁移），
  // `messages_fts` 不用手动同步（`DELETE FROM messages` 的触发器自己维护索引）。
  await db.tx((tx) => [
    tx.run("DELETE FROM notices"),
    tx.run("DELETE FROM workspaces"), // 级联 conversations → messages → conversation_assets
    tx.run("DELETE FROM assets"), // 级联 asset_vendor_files
    tx.run("DELETE FROM credentials"),
  ]);
  // 上一个用例可能改过磁盘上的配置文件 / 助手定义：每个用例开头重写回基准那一份
  await writeConfig();
  await writeFile(join(dir, "reasoning-presets.json"), JSON.stringify(REASONING_PRESETS), "utf-8");
  await writeAgentFiles();

  // 题的口是进程内的一格：每个用例从「没有题挂着」开始
  questions.pending.clear();
  harness = await buildHarness();
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("ConversationService.create（身份创建时定死，L7 / R18）", () => {
  it("助手绑定的模型优先于配置里的兜底模型，三件身份都落库", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const conversation = created.conversation;

    expect(conversation.workspaceId).toBe("w1");
    expect(conversation.agentId).toBe("a1");
    expect(conversation.modelId).toBe("m1");
    expect(conversation.model).toMatchObject({
      modelId: "m1",
      name: "模型一",
      vision: true,
      // 没换过模型：助手定义绑的那个
      source: "agent",
    });
    const stored = await harness.conversations.get(conversation.id);
    expect(stored?.agentId).toBe("a1");
    expect(stored?.modelId).toBe("m1");
  });

  it("入参明确点名模型时以它为准", async () => {
    const created = await createPersisted(harness.service, {
      workspaceId: "w1",
      agentId: "a1",
      modelId: "m3",
    });
    expect(created.conversation.modelId).toBe("m3");
  });

  it("助手没绑模型时落到配置里的兜底模型", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a2" });
    expect(created.conversation.agentId).toBe("a2");
    expect(created.conversation.modelId).toBe("m3");
  });

  it("原名就是创建时间，所以 nameIsAuto 为真（D2）", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    expect(created.conversation.name).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(created.conversation.nameIsAuto).toBe(true);
  });

  it("项目不存在时报 not_found，不写半成品行", async () => {
    await expect(createPersisted(harness.service, { workspaceId: "没有这个项目", agentId: "a1" })).rejects.toMatchObject(
      { code: "not_found" },
    );
    expect(await harness.conversations.list()).toEqual([]);
  });

  it("助手不存在时报 not_found", async () => {
    await expect(createPersisted(harness.service, { workspaceId: "w1", agentId: "没有这个助手" })).rejects.toMatchObject(
      { code: "not_found" },
    );
    expect(await harness.conversations.list()).toEqual([]);
  });

  it("点名要的模型不存在时报 not_found", async () => {
    await expect(
      createPersisted(harness.service, { workspaceId: "w1", agentId: "a1", modelId: "没有这个模型" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("模型三级都解析不出来时报 config_invalid，文案是「给助手挑个模型」那条（R38），不写库", async () => {
    // 换一份配置不需要换库（`ConfigManager` 每次读盘），`beforeEach` 会把它写回基准那一份
    await writeConfig({ ...BASE_CONFIG, defaultModel: undefined });
    await expect(
      createPersisted(harness.service, { workspaceId: "w1", agentId: "a2" }),
    ).rejects.toMatchObject({
      code: "config_invalid",
      messageKey: "error.modelUnresolved",
      detail: { agentId: "a2", defaultModel: null },
    });
    expect(await harness.conversations.list()).toEqual([]);
  });

  it("配置指向不存在的模型时也用同一条文案，原因在 detail 里", async () => {
    await writeConfig({
      ...BASE_CONFIG,
      // 助手 a2 没绑模型，兜底层指向一个配置里没有的模型
      defaultModel: "不存在的模型",
    });
    await expect(
      createPersisted(harness.service, { workspaceId: "w1", agentId: "a2" }),
    ).rejects.toMatchObject({
      code: "config_invalid",
      messageKey: "error.modelUnresolved",
      detail: { modelId: "不存在的模型", level: "global", agentId: "a2" },
    });
    expect(await harness.conversations.list()).toEqual([]);
  });
});

describe("ConversationService.list（D13）", () => {
  it("置顶优先、再按创建时间倒序；改名与置顶都不改创建时间", async () => {
    const first = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const second = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const third = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });

    let listed = await harness.service.list({ workspaceId: "w1" });
    expect(listed.conversations.map((item) => item.id)).toEqual([
      third.conversation.id,
      second.conversation.id,
      first.conversation.id,
    ]);

    await harness.service.pin({ conversationId: first.conversation.id, pinned: true });
    await harness.service.rename({ conversationId: second.conversation.id, name: "改过名的" });

    listed = await harness.service.list({ workspaceId: "w1" });
    expect(listed.conversations.map((item) => item.id)).toEqual([
      first.conversation.id,
      third.conversation.id,
      second.conversation.id,
    ]);
    expect(listed.total).toBe(3);
  });

  it("按置顶筛、按 limit/offset 切页，total 是筛完的总数", async () => {
    const first = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    await harness.service.pin({ conversationId: first.conversation.id, pinned: true });

    const pinnedOnly = await harness.service.list({ workspaceId: "w1", pinned: true });
    expect(pinnedOnly.conversations.map((item) => item.id)).toEqual([first.conversation.id]);

    const page = await harness.service.list({ workspaceId: "w1", limit: 1, offset: 1 });
    expect(page.conversations).toHaveLength(1);
    expect(page.total).toBe(2);
  });

  it("status 与 hasPendingQuestion 都从注入的那一侧现取", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    harness.runtime.running.add(created.conversation.id);
    // 题是进程内对象：这里摆一道挂着的（数从注入的那一侧现取）
    harness.questions.pending.set(created.conversation.id, 1);

    const listed = await harness.service.list({ workspaceId: "w1" });
    expect(listed.conversations[0]).toMatchObject({ status: "busy", hasPendingQuestion: true });

    harness.runtime.running.delete(created.conversation.id);
    const again = await harness.service.get({ conversationId: created.conversation.id });
    expect(again.conversation.status).toBe("idle");
  });

  it("条目带 status 与 inboxPending：两格都是现读的（F-I3）", async () => {
    const busy = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const idle = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    harness.runtime.running.add(busy.conversation.id);
    harness.runtime.pending.set(busy.conversation.id, 2);

    const listed = await harness.service.list({ workspaceId: "w1" });
    const byId = new Map(listed.conversations.map((item) => [item.id, item]));

    expect(byId.get(busy.conversation.id)).toMatchObject({ status: "busy", inboxPending: 2 });
    expect(byId.get(idle.conversation.id)).toMatchObject({ status: "idle", inboxPending: 0 });
    // 再也没有「跑 + 开始时刻」那一格：那是对「一次运行」的记账
    expect("run" in (byId.get(busy.conversation.id) ?? {})).toBe(false);
    expect("running" in (byId.get(busy.conversation.id) ?? {})).toBe(false);
  });

  it("压缩标记出网：没压过的条目不带这两格，压过之后带时刻与来源", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });

    // 没压过：两格整对省略（空 = 没压过，不是「不知道」）
    const fresh = await harness.service.get({ conversationId: created.conversation.id });
    expect(fresh.conversation.compactedAt).toBeUndefined();
    expect(fresh.conversation.compactionMode).toBeUndefined();

    await harness.service.markCompacted(created.conversation.id, "auto");

    const after = await harness.service.get({ conversationId: created.conversation.id });
    expect(after.conversation.compactionMode).toBe("auto");
    expect(typeof after.conversation.compactedAt).toBe("string");
    // 侧栏摘要与视图是同一份口径（摘要 extends 自同一个形状）
    const listed = await harness.service.list({ workspaceId: "w1" });
    expect(listed.conversations[0]?.compactionMode).toBe("auto");
  });
});

describe("ConversationService.get / rename / pin", () => {
  it("get 带上目录事实与消息统计", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    await harness.messages.upsert({
      id: "msg-1",
      conversationId: created.conversation.id,
      role: "user",
      status: "completed",
      content: "你好",
      createdAt: 12_345,
    });

    const { conversation } = await harness.service.get({ conversationId: created.conversation.id });
    expect(conversation.folder).toEqual({ cwd: harness.projectDir, exists: true });
    expect(conversation.messageCount).toBe(1);
    expect(conversation.lastMessageAt).toBe(new Date(12_345).toISOString());
  });

  it("改名之后 nameIsAuto 翻假，身份不动", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const renamed = await harness.service.rename({
      conversationId: created.conversation.id,
      name: "  我的对话  ",
    });
    expect(renamed.conversation.name).toBe("我的对话");
    expect(renamed.conversation.nameIsAuto).toBe(false);
    expect(renamed.conversation.modelId).toBe("m1");
    expect(renamed.conversation.agentId).toBe("a1");
  });

  it("自动命名之后 nameIsAuto 仍为真（R35：读的是列，不是名字内容）", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;

    // 自动命名是 W4-H 的动作，这里直接走仓储那一条写入路径
    await harness.conversations.applyAutoName(id, "重写存储层", 2_000);

    const { conversation } = await harness.service.get({ conversationId: id });
    expect(conversation.name).toBe("重写存储层");
    expect(conversation.nameIsAuto).toBe(true);
  });

  it("用户改名之后再自动命名，又回到自动", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;

    await harness.service.rename({ conversationId: id, name: "我先自己起的名" });
    expect((await harness.service.get({ conversationId: id })).conversation.nameIsAuto).toBe(false);

    await harness.conversations.applyAutoName(id, "自动起的名字", 3_000);
    expect((await harness.service.get({ conversationId: id })).conversation.nameIsAuto).toBe(true);
  });
});

describe("ConversationService.delete（D17）", () => {
  it("dryRun 只算代价；真删后对话与消息消失，引用归零的素材交给素材层清", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    await harness.messages.upsert({
      id: "msg-1",
      conversationId: id,
      role: "user",
      status: "completed",
      content: "一句话",
      createdAt: 2,
    });
    await harness.assets.create({
      id: "as1",
      path: "assets/as1.png",
      mime: "image/png",
      bytes: 5,
      sha256: "sha256-1",
      createdAt: 3,
    });
    // 归属只在关系行上：素材行本身不记对话
    await harness.assets.linkAsset({
      conversationId: id,
      messageId: "msg-1",
      assetId: "as1",
      createdAt: 4,
    });

    const dry = await harness.service.delete({ conversationId: id, dryRun: true });
    expect(dry.removed).toBe(false);
    expect(dry.consequences).toEqual({ conversations: 1, messages: 1, assets: 1 });
    expect(dry.assetIds).toEqual(["as1"]);
    expect(await harness.conversations.get(id)).toBeDefined();
    // dryRun 不该真的去清字节
    expect(harness.sweeps).toEqual([]);

    const real = await harness.service.delete({ conversationId: id });
    expect(real.removed).toBe(true);
    expect(await harness.conversations.get(id)).toBeUndefined();
    expect(await harness.messages.countByConversation(id)).toBe(0);
    // 关系行随外键级联消失，素材行本身留给素材层判
    expect(await harness.assets.countReferences("as1")).toBe(0);
    expect(await harness.assets.get("as1")).toBeDefined();
    expect(harness.sweeps).toEqual([["as1"]]);
    expect(harness.runtime.forgotten).toContain(id);
    await expect(harness.service.get({ conversationId: id })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("R56：create 不落库，首次发消息才写行", () => {
  it("create 只发 id 与身份：库里 0 行、列表里也没有它", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const conversation = created.conversation;
    expect(conversation).not.toBeNull();
    if (!conversation) return;

    // 身份三件套已经定死（L7），但这一行还没有进库
    expect(conversation.workspaceId).toBe("w1");
    expect(conversation.agentId).toBe("a1");
    expect(conversation.modelId).toBe("m1");
    const rows = await harness.db.all<{ id: string }>("SELECT id FROM conversations");
    expect(rows).toEqual([]);

    // 但它不是一个「找不到的对话」：get 能拿到正确视图
    const opened = await harness.service.get({ conversationId: conversation.id });
    expect(opened.conversation.id).toBe(conversation.id);
    expect(opened.conversation.messageCount).toBe(0);
    expect(opened.conversation.workspaceId).toBe("w1");

    // 侧栏列表只给已经落库的（F-C2：否则一堆空会话）
    expect((await harness.service.list({ workspaceId: "w1" })).total).toBe(0);
  });

  it("首次发消息时用同一个 id 落库（ensurePersisted），之后与普通对话无差别", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const id = created.conversation?.id ?? "";

    const persisted = await harness.service.ensurePersisted(id);
    expect(persisted.id).toBe(id);
    expect(persisted.workspaceId).toBe("w1");
    expect(persisted.agentId).toBe("a1");
    expect(persisted.modelId).toBe("m1");
    expect(persisted.nameIsAuto).toBe(true);

    const listed = await harness.service.list({ workspaceId: "w1" });
    expect(listed.conversations.map((item) => item.id)).toEqual([id]);
    // 落库就是「第一次出现在其它窗口的侧栏里」：推一条 created（L5）
    expect(harness.events.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({ conversationId: id, change: "created" }),
    );

    // 幂等：再落一次不会插第二行
    await harness.service.ensurePersisted(id);
    expect(await harness.conversations.list()).toHaveLength(1);
  });

  it("并发调 ensurePersisted：只插一行、只写一条 cwd 消息（上传与发送可能同时撞上）", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const id = created.conversation?.id ?? "";

    const results = await Promise.all([
      harness.service.ensurePersisted(id),
      harness.service.ensurePersisted(id),
      harness.service.ensurePersisted(id),
    ]);

    expect(results.map((row) => row.id)).toEqual([id, id, id]);
    expect(await harness.conversations.list()).toHaveLength(1);
    const messages = await harness.messages.listByConversation(id, undefined, {
      includeHidden: true,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toMatchObject({ hidden: true });
  });

  it("草稿也能改名与置顶（只动内存），落库时带过去", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const id = created.conversation?.id ?? "";

    const renamed = await harness.service.rename({ conversationId: id, name: "我自己起的" });
    expect(renamed.conversation.name).toBe("我自己起的");
    expect(renamed.conversation.nameIsAuto).toBe(false);
    await harness.service.pin({ conversationId: id, pinned: true });

    await harness.service.ensurePersisted(id);
    const row = await harness.conversations.get(id);
    expect(row?.name).toBe("我自己起的");
    expect(row?.nameIsAuto).toBe(false);
    expect(row?.pinned).toBe(true);
  });

  it("没落库的草稿也能删，代价是零", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const id = created.conversation?.id ?? "";

    const removed = await harness.service.delete({ conversationId: id });
    expect(removed.removed).toBe(true);
    expect(removed.consequences).toEqual({ conversations: 1, messages: 0, assets: 0 });
    await expect(harness.service.get({ conversationId: id })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("多端在线同步（L5 / D22：conversation.changed）", () => {
  const changes = (): Array<Record<string, unknown>> =>
    harness.events
      .filter((event) => event.name === "conversation.changed")
      .map((event) => event.payload as Record<string, unknown>);

  it("改名 / 置顶 / 撤回 / 删除各推一条，带定位信息", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    await harness.messages.upsert({
      id: "u1",
      conversationId: id,
      role: "user",
      status: "completed",
      content: "第一句",
      createdAt: 10,
    });
    // 那一句引出的回答：撤回是「从锚点开始（含它）全删」，所以它也得在库里，两条各推一条 `message.removed`
    await harness.messages.upsert({
      id: "a1",
      conversationId: id,
      role: "assistant",
      status: "completed",
      content: "第一句的回答",
      createdAt: 11,
    });
    harness.events.length = 0;

    await harness.service.rename({ conversationId: id, name: "新名字" });
    await harness.service.pin({ conversationId: id, pinned: true });
    await harness.service.revert({ conversationId: id, beforeMessageId: "u1" });
    await harness.service.delete({ conversationId: id });

    // 撤回不在 `conversation.changed` 里：消息有自己的事件（下面单独看）
    expect(changes().map((payload) => payload.change)).toEqual([
      "renamed",
      "pinned",
      "deleted",
    ]);
    for (const payload of changes()) {
      expect(payload.conversationId).toBe(id);
      expect(payload.workspaceId).toBe("w1");
      expect(typeof payload.at).toBe("string");
      // 条数不在推送里：客户端自己数
      expect("messageCount" in payload).toBe(false);
    }
    // 撤回删掉的那几条各自推一条 `message.removed`（客户端按 id 摘掉它们）
    const removed = harness.events
      .filter((event) => event.name === "message.removed")
      .map((event) => event.payload as Record<string, unknown>);
    expect(removed.map((payload) => payload.messageId)).toEqual(["u1", "a1"]);
    for (const payload of removed) expect(payload.conversationId).toBe(id);
  });

  it("读路径不推；换模型与调档各推一条 settings_changed（它们会出现在别的窗口的状态栏上）", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    harness.events.length = 0;

    await harness.service.list({ workspaceId: "w1" });
    await harness.service.get({ conversationId: id });
    expect(changes()).toEqual([]);

    await harness.service.setModel({ conversationId: id, modelId: "m3" });
    await harness.service.setThinking({ conversationId: id, level: "low" });
    expect(changes().map((payload) => payload.change)).toEqual([
      "settings_changed",
      "settings_changed",
    ]);
    expect("messageCount" in (changes()[0] ?? {})).toBe(false);
  });
});

describe("ConversationService.revert（D24）", () => {
  it("删到指定用户消息之前（含它），回填它当时的内容与素材", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    for (const [messageId, role, content, createdAt] of [
      ["u1", "user", "第一句", 1_000],
      ["a1", "assistant", "第一句的回复", 1_100],
      ["u2", "user", "第二句", 1_200],
      ["a2", "assistant", "第二句的回复", 1_300],
    ] as const) {
      await harness.messages.upsert({
        id: messageId,
        conversationId: id,
        role,
        status: "completed",
        content,
        createdAt,
      });
    }
    await harness.assets.create({
      id: "as1",
      path: "assets/as1.png",
      mime: "image/png",
      bytes: 5,
      sha256: "sha256-2",
      createdAt: 1_250,
    });
    await harness.assets.linkAsset({
      conversationId: id,
      messageId: "u2",
      assetId: "as1",
      createdAt: 1_251,
    });

    const result = await harness.service.revert({ conversationId: id, beforeMessageId: "u2" });
    expect(result.removedMessageIds).toEqual(["u2", "a2"]);
    expect(result.restoredInput).toEqual({ content: "第二句", assetIds: ["as1"] });
    // 撤掉的消息引用的素材交给素材层清（还有别的引用就留下）
    expect(harness.sweeps).toEqual([["as1"]]);

    const left = await harness.messages.listByConversation(id);
    expect(left.map((message) => message.id)).toEqual(["u1", "a1"]);
    // 会话开头那条 cwd 消息排在撤回到的位置之前，不跟着没（不展示，但要还在）
    const leftAll = await harness.messages.listByConversation(id, undefined, {
      includeHidden: true,
    });
    expect(leftAll).toHaveLength(3);
    expect(leftAll[0]?.data).toMatchObject({ hidden: true });
  });

  it("撤回点不是用户消息时报参数错", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    await harness.messages.upsert({
      id: "a1",
      conversationId: id,
      role: "assistant",
      status: "completed",
      content: "回复",
      createdAt: 1,
    });

    await expect(
      harness.service.revert({ conversationId: id, beforeMessageId: "a1" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("消息不在这一段对话里时报 not_found", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    await expect(
      harness.service.revert({ conversationId: created.conversation.id, beforeMessageId: "别处的" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("回填只给纯文本 + assetIds：图片靠素材复原，不在正文里再给一遍（R62）", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    // 一条带图的用户消息：入库的内容段里已经有 image_url 与 file（发出去时转换好的）
    await harness.messages.upsert({
      id: "u1",
      conversationId: id,
      role: "user",
      status: "completed",
      content: [
        { type: "text", text: "看这两张" },
        { type: "image_url", image_url: { url: "https://example.test/a.png" } },
        { type: "file", file_id: "file-1", filename: "a.pdf" },
      ],
      createdAt: 10,
    });
    await harness.assets.create({
      id: "as1",
      path: "assets/as1.png",
      mime: "image/png",
      bytes: 5,
      sha256: "sha256-3",
      createdAt: 11,
    });
    await harness.assets.linkAsset({
      conversationId: id,
      messageId: "u1",
      assetId: "as1",
      createdAt: 12,
    });

    const result = await harness.service.revert({ conversationId: id, beforeMessageId: "u1" });
    expect(result.restoredInput).toEqual({
      content: [{ type: "text", text: "看这两张" }],
      assetIds: ["as1"],
    });
  });

  it("正在跑一轮时拒绝撤回", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    harness.runtime.running.add(created.conversation.id);
    await expect(
      harness.service.revert({
        conversationId: created.conversation.id,
        beforeMessageId: "随便一个",
      }),
    ).rejects.toMatchObject({ code: "busy" });
  });
});

/** 把助手定义写成带参数的那一份（档位的「跟随默认」靠定义上的参数认） */
async function writeAgentWithParams(params: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(harness.dir, "agents", "a1.json"),
    JSON.stringify({
      id: "a1",
      name: "助手一",
      messages: [],
      modelId: "m1",
      modelParams: params,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    "utf-8",
  );
}

describe("ConversationService.setModel（F-B4 / D20：会话级、落库）", () => {
  it("换模型写进会话行，重开这段对话读到的还是新模型", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;

    const result = await harness.service.setModel({ conversationId: id, modelId: "m3" });
    expect(result.conversation.model).toMatchObject({ modelId: "m3", source: "conversation" });
    expect(result.model.modelId).toBe("m3");
    // 上下文占用不在这里给：客户端按消息上的用量自己算（宿主不算、不存、不报）
    expect("context" in result).toBe(false);
    // 库里那一行就是新模型；再打开读到的也是它（不是内存里的临时值）
    expect((await harness.conversations.get(id))?.modelId).toBe("m3");
    const reopened = await harness.service.get({ conversationId: id });
    expect(reopened.conversation.model).toMatchObject({ modelId: "m3", source: "conversation" });
  });

  it("换模型把思考档位清成 null（档位属于模型）", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    await harness.service.setThinking({ conversationId: id, level: "high" });
    expect((await harness.conversations.get(id))?.thinkingLevel).toBe("high");

    await harness.service.setModel({ conversationId: id, modelId: "m3" });

    expect((await harness.conversations.get(id))?.thinkingLevel).toBeNull();
    const reopened = await harness.service.get({ conversationId: id });
    expect(reopened.conversation.thinking.selected).toBeNull();
    expect(reopened.conversation.thinking.source).toBe("following_default");
  });

  it("传 null 等于回到助手定义上那个模型（source 变回 agent）", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;

    await harness.service.setModel({ conversationId: id, modelId: "m3" });
    const cleared = await harness.service.setModel({ conversationId: id, modelId: null });
    expect(cleared.model).toMatchObject({ modelId: "m1", source: "agent" });
    expect((await harness.conversations.get(id))?.modelId).toBe("m1");
  });

  it("传回行上那个模型是个空操作：档位不被顺手清掉", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    await harness.service.setThinking({ conversationId: id, level: "low" });

    await harness.service.setModel({ conversationId: id, modelId: "m1" });
    expect((await harness.conversations.get(id))?.thinkingLevel).toBe("low");
  });

  it("历史里有图而新模型不看图时拒绝并说明原因", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    await harness.messages.upsert({
      id: "u1",
      conversationId: id,
      role: "user",
      status: "completed",
      content: "看这张",
      createdAt: 2,
    });
    await harness.assets.create({
      id: "as1",
      path: "assets/as1.png",
      mime: "image/png",
      bytes: 5,
      sha256: "sha256-4",
      createdAt: 3,
    });
    await harness.assets.linkAsset({
      conversationId: id,
      messageId: "u1",
      assetId: "as1",
      createdAt: 4,
    });

    await expect(
      harness.service.setModel({ conversationId: id, modelId: "m2" }),
    ).rejects.toMatchObject({ code: "model_unsupported", messageKey: "error.modelUnsupported" });
    // 被拒绝时什么都没改
    expect((await harness.conversations.get(id))?.modelId).toBe("m1");
  });

  it("历史里没有图时允许换到不看图的模型", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const result = await harness.service.setModel({
      conversationId: created.conversation.id,
      modelId: "m2",
    });
    expect(result.model).toMatchObject({ modelId: "m2", vision: false });
  });

  it("换到不存在的模型报 not_found", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    await expect(
      harness.service.setModel({ conversationId: created.conversation.id, modelId: "没有这个模型" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("还没落库的草稿也能换模型与调档：落库时按草稿里的写", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const id = created.conversation?.id ?? "";
    await harness.service.setModel({ conversationId: id, modelId: "m3" });
    await harness.service.setThinking({ conversationId: id, level: "low" });

    const row = await harness.service.ensurePersisted(id);
    expect(row.modelId).toBe("m3");
    expect(row.thinkingLevel).toBe("low");
  });
});

describe("ConversationService.setThinking（F-B6 / F-B7：会话级、落库）", () => {
  it("跟随助手定义：参数对上某一档就报那一档", async () => {
    await writeAgentWithParams({ reasoning_effort: "high", temperature: 0.2 });

    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    expect(created.conversation.thinking).toEqual({
      preset: "test-preset",
      levels: ["low", "high"],
      selected: "high",
      source: "following_default",
      params: { reasoning_effort: "high" },
    });
  });

  it("调档写进会话行，并回展开后的参数", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    const result = await harness.service.setThinking({ conversationId: id, level: "low" });

    expect(result.thinking).toMatchObject({
      selected: "low",
      source: "manual",
      params: { reasoning_effort: "low" },
    });
    expect((await harness.conversations.get(id))?.thinkingLevel).toBe("low");
    // 再打开这段对话读到的也是它（不是内存里的临时值）
    const reopened = await harness.service.get({ conversationId: id });
    expect(reopened.conversation.thinking.selected).toBe("low");
    expect(reopened.conversation.thinking.source).toBe("manual");
  });

  it("level: null 回到跟随助手定义（source: following_default）", async () => {
    await writeAgentWithParams({ reasoning_effort: "high" });
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    await harness.service.setThinking({ conversationId: id, level: "low" });

    const cleared = await harness.service.setThinking({ conversationId: id, level: null });
    expect((await harness.conversations.get(id))?.thinkingLevel).toBeNull();
    expect(cleared.thinking).toMatchObject({
      selected: "high",
      source: "following_default",
      params: { reasoning_effort: "high" },
    });
  });

  it("两段对话各设不同档位互不影响（一段关掉思考、一段开到最大）", async () => {
    const first = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const second = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });

    await harness.service.setThinking({ conversationId: first.conversation.id, level: "low" });
    await harness.service.setThinking({ conversationId: second.conversation.id, level: "high" });

    const a = await harness.service.get({ conversationId: first.conversation.id });
    const b = await harness.service.get({ conversationId: second.conversation.id });
    expect(a.conversation.thinking).toMatchObject({ selected: "low", source: "manual" });
    expect(b.conversation.thinking).toMatchObject({ selected: "high", source: "manual" });
    expect((await harness.conversations.get(first.conversation.id))?.thinkingLevel).toBe("low");
    expect((await harness.conversations.get(second.conversation.id))?.thinkingLevel).toBe("high");
  });

  it("档位不在策略表里时报参数错，detail 里给出可用档位", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    await expect(
      harness.service.setThinking({ conversationId: created.conversation.id, level: "超高" }),
    ).rejects.toMatchObject({
      code: "invalid_params",
      detail: { field: "level", level: "超高", levels: ["low", "high"] },
    });
    // 被拒绝时没有写库
    expect((await harness.conversations.get(created.conversation.id))?.thinkingLevel).toBeNull();
  });

  it("助手定义上的默认档改了，不影响已有会话的会话级档位", async () => {
    await writeAgentWithParams({ reasoning_effort: "high" });
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    await harness.service.setThinking({ conversationId: id, level: "low" });

    // 助手改成默认「high」：那是「以后的对话」的事
    await writeAgentWithParams({ reasoning_effort: "high", temperature: 0.1 });
    const existing = await harness.service.get({ conversationId: id });
    expect(existing.conversation.thinking).toMatchObject({
      selected: "low",
      source: "manual",
      params: { reasoning_effort: "low" },
    });

    // 新对话跟着助手定义走
    const fresh = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    expect(fresh.conversation.thinking).toMatchObject({
      selected: "high",
      source: "following_default",
    });
  });

  it("模型没有思考策略时报 unsupported", async () => {
    const created = await createPersisted(harness.service, {
      workspaceId: "w1",
      agentId: "a1",
      modelId: "m2",
    });
    await expect(
      harness.service.setThinking({ conversationId: created.conversation.id, level: "low" }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(created.conversation.thinking.source).toBe("not_adjustable");
    // 不可调的模型上「回到跟随助手」同样不成立
    await expect(
      harness.service.setThinking({ conversationId: created.conversation.id, level: null }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("ConversationService.setThresholds（PRD 1.4 / 4.7：会话行上的覆盖层）", () => {
  it("给数字：写进会话行，`ConversationView` 里读得到", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    // 新建的会话两格都是 NULL：跟模型走才是常态
    expect(created.conversation.handoffThreshold).toBeNull();
    expect(created.conversation.guardThreshold).toBeNull();

    const result = await harness.service.setThresholds({
      conversationId: id,
      handoffThreshold: 100_000,
      guardThreshold: 150_000,
    });
    expect(result.conversation.handoffThreshold).toBe(100_000);
    expect(result.conversation.guardThreshold).toBe(150_000);
    // 落的是库里的那一行（不是内存里的临时值）：另开一次读回来的还是这两个数
    const stored = await harness.conversations.get(id);
    expect(stored?.handoffThreshold).toBe(100_000);
    expect(stored?.guardThreshold).toBe(150_000);
    const reopened = await harness.service.get({ conversationId: id });
    expect(reopened.conversation).toMatchObject({
      handoffThreshold: 100_000,
      guardThreshold: 150_000,
    });
    // 会话行变了：推一条让别的窗口去拉（不推就有人拿着旧的那两格）
    expect(harness.events.at(-1)).toMatchObject({
      name: "conversation.changed",
      payload: { conversationId: id, change: "settings_changed" },
    });
  });

  it("显式 `null`：回到「跟模型走」，不是清成 0", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    await harness.service.setThresholds({ conversationId: id, handoffThreshold: 100_000 });

    const cleared = await harness.service.setThresholds({ conversationId: id, handoffThreshold: null });
    expect(cleared.conversation.handoffThreshold).toBeNull();
    expect((await harness.conversations.get(id))?.handoffThreshold).toBeNull();
  });

  it("只给一条：另一条一个字都不动（省略 = 不动）", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    await harness.service.setThresholds({
      conversationId: id,
      handoffThreshold: 100_000,
      guardThreshold: 150_000,
    });

    const onlyHandoff = await harness.service.setThresholds({
      conversationId: id,
      handoffThreshold: 90_000,
    });
    expect(onlyHandoff.conversation.handoffThreshold).toBe(90_000);
    expect(onlyHandoff.conversation.guardThreshold).toBe(150_000);

    const onlyGuard = await harness.service.setThresholds({ conversationId: id, guardThreshold: null });
    expect(onlyGuard.conversation.handoffThreshold).toBe(90_000);
    expect(onlyGuard.conversation.guardThreshold).toBeNull();
  });

  it("两格都不给：什么也不写，连修改时间都不动，也不推事件", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    const before = await harness.conversations.get(id);
    const events = harness.events.length;

    const unchanged = await harness.service.setThresholds({ conversationId: id });
    expect(unchanged.conversation.handoffThreshold).toBeNull();
    expect((await harness.conversations.get(id))?.updatedAt).toBe(before?.updatedAt);
    expect(harness.events.length).toBe(events);
  });

  it("非法值一律 invalid_params：0 / 负数 / 小数 / 硬线不大于软线", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;

    // `0` 不收：阈值是绝对 token 数，要「不设这条线」请给 `null`
    await expect(
      harness.service.setThresholds({ conversationId: id, handoffThreshold: 0 }),
    ).rejects.toMatchObject({
      code: "invalid_params",
      detail: { field: "handoffThreshold", reason: "not_positive_integer" },
    });
    await expect(
      harness.service.setThresholds({ conversationId: id, guardThreshold: -1 }),
    ).rejects.toMatchObject({
      code: "invalid_params",
      detail: { field: "guardThreshold", reason: "not_positive_integer" },
    });
    await expect(
      harness.service.setThresholds({ conversationId: id, guardThreshold: 1500.5 }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    // 硬线必须给软线留出余量（与建模型那条同口径：handoff < guard）
    await expect(
      harness.service.setThresholds({ conversationId: id, handoffThreshold: 1000, guardThreshold: 1000 }),
    ).rejects.toMatchObject({
      code: "invalid_params",
      detail: { field: "guardThreshold", reason: "handoff_not_below_guard" },
    });
    await expect(
      harness.service.setThresholds({ conversationId: id, handoffThreshold: 2000, guardThreshold: 1000 }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    // 被拒绝时什么都没写
    expect((await harness.conversations.get(id))?.handoffThreshold).toBeNull();
  });

  it("只动这两格：模型与思考档位不受影响（它们才是驱动者的装配事实）", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    await harness.service.setThinking({ conversationId: id, level: "high" });

    await harness.service.setThresholds({ conversationId: id, handoffThreshold: 100_000 });

    const stored = await harness.conversations.get(id);
    expect(stored?.modelId).toBe("m1");
    expect(stored?.thinkingLevel).toBe("high");
  });

  it("还没落库的草稿也能改：落库时按草稿里的写", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const id = created.conversation?.id ?? "";
    await harness.service.setThresholds({ conversationId: id, handoffThreshold: 100_000, guardThreshold: 150_000 });

    const row = await harness.service.ensurePersisted(id);
    expect(row.handoffThreshold).toBe(100_000);
    expect(row.guardThreshold).toBe(150_000);
  });
});

describe("会话创建时那条 hidden 的 cwd 消息（F-D9）", () => {
  it("落库时最先写一条 hidden 的 user 消息：正文就是项目目录、seq 在用户消息之前", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const id = created.conversation?.id ?? "";
    await harness.service.ensurePersisted(id);
    // 首次发送的那条用户消息（走仓储落行，`seq` 排在 cwd 消息之后）
    await harness.messages.upsert({
      id: "u1",
      conversationId: id,
      role: "user",
      status: "completed",
      content: "看看这个项目",
      createdAt: clock,
    });

    const visible = await harness.messages.listByConversation(id);
    expect(visible.map((message) => message.id)).toEqual(["u1"]);

    const all = await harness.messages.listByConversation(id, undefined, { includeHidden: true });
    expect(all.map((message) => message.id)).toHaveLength(2);
    const cwdMessage = all[0]!;
    expect(cwdMessage.role).toBe(AgentNS.Role.User);
    expect(cwdMessage.data).toMatchObject({ hidden: true });
    // 宿主注入的不是用户说的话（CORE §3；自动命名的判据看的就是它）
    expect(cwdMessage.source).toEqual({ kind: "system", label: "cwd" });
    // **正文就是那个路径**：不是一句渲染过的话（这条消息隐藏、用户看不见，模型要的就是路径）
    expect(cwdMessage.content).toBe(harness.projectDir);
    expect(cwdMessage.seq).toBeLessThan(all[1]!.seq);
    expect(all[1]?.id).toBe("u1");
  });

  it("与交接换完记忆时 SDK 生成的那一条逐字段同形同文（一个概念一种形状）", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const rows = await harness.messages.listByConversation(created.conversation.id, undefined, {
      includeHidden: true,
    });
    const seeded = rows[0]!;

    // 交接换完记忆那一份由 SDK 造（`HandoffService.createCwdMessage`，宿主只是把它写成行）
    const handedOver = HandoffService.createCwdMessage(harness.projectDir);

    // 直接把两者的 role / hidden / source / content 摆在一起比：一处不同都算「两种形状」
    expect({
      role: seeded.role,
      hidden: (seeded.data as { hidden?: unknown } | null)?.hidden,
      source: seeded.source,
      content: seeded.content,
    }).toEqual({
      role: handedOver.role,
      hidden: handedOver.hidden,
      source: handedOver.source,
      content: handedOver.content,
    });
    // 那一条的正文也是路径（两边都不是渲染过的话）
    expect(handedOver.content).toBe(harness.projectDir);
  });

  it("不进侧栏计数、也不进删除代价计数", async () => {
    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    await harness.messages.upsert({
      id: "u1",
      conversationId: id,
      role: "user",
      status: "completed",
      content: "一句话",
      createdAt: 2,
    });

    const { conversation } = await harness.service.get({ conversationId: id });
    expect(conversation.messageCount).toBe(1);
    const dry = await harness.service.delete({ conversationId: id, dryRun: true });
    expect(dry.consequences.messages).toBe(1);
    // 库里确实有两条（那条 hidden 的还在），只是两处计数都不算它
    const all = await harness.messages.listByConversation(id, undefined, { includeHidden: true });
    expect(all).toHaveLength(2);
  });

  it("换了 Workspace 打开同一段对话，那条会话的 cwd 仍是它原来的那个", async () => {
    const otherDir = join(harness.dir, "another-project");
    await mkdir(otherDir, { recursive: true });
    await harness.workspaces.create({ id: "w2", name: "项目二", cwd: otherDir, createdAt: 2 });

    const created = await createPersisted(harness.service, { workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    const readCwd = async (): Promise<string> => {
      const rows = await harness.messages.listByConversation(id, undefined, { includeHidden: true });
      const content = rows[0]?.content;
      return typeof content === "string" ? content : JSON.stringify(content);
    };
    const before = await readCwd();
    expect(before).toBe(harness.projectDir);

    // 在另一个项目里开一段新对话、并把两个项目都列一遍（「当前项目」变了）
    await createPersisted(harness.service, { workspaceId: "w2", agentId: "a1" });
    await harness.service.list({ workspaceId: "w2" });
    await harness.service.list({});

    // 原来那段对话的归属与那条 cwd 消息一个字都没变
    const opened = await harness.service.get({ conversationId: id });
    expect(opened.conversation.workspaceId).toBe("w1");
    expect(opened.conversation.folder.cwd).toBe(harness.projectDir);
    expect(await readCwd()).toBe(before);
  });
});

describe("对外失败一律是 HostError", () => {
  it("不存在的对话在每个方法上都报 HostError", async () => {
    const calls = [
      harness.service.get({ conversationId: "x" }),
      harness.service.rename({ conversationId: "x", name: "名字" }),
      harness.service.pin({ conversationId: "x", pinned: true }),
      harness.service.delete({ conversationId: "x" }),
      harness.service.revert({ conversationId: "x", beforeMessageId: "y" }),
      harness.service.setModel({ conversationId: "x", modelId: null }),
      harness.service.setThinking({ conversationId: "x", level: "low" }),
    ];
    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(HostError);
    }
  });
});
