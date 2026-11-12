/**
 * 对话服务的验收：身份创建时定死（L7 / R18）、侧栏顺序（D13）、改名与置顶各管一件事、
 * 硬删与代价（D17）、撤回（D24）、临时换模型只在内存且拒绝降级（D20）、思考档位（F-B6）。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigManager } from "@ai-zen/agents-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AssetRepository } from "../storage/AssetRepository.js";
import { ConversationRepository } from "../storage/ConversationRepository.js";
import { Database } from "../storage/Database.js";
import { MessageRepository } from "../storage/MessageRepository.js";
import { QuestionRepository } from "../storage/QuestionRepository.js";
import { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import { migrate } from "../storage/migrations.js";
import { ServerError } from "../wire/errors.js";
import { ConversationService } from "./ConversationService.js";
import type { ConversationRuntimePort } from "./ConversationService.js";

/** 内存里的临时状态都放这里：服务层只通过这个窄接口读写，自己不留一份 */
class FakeRuntime implements ConversationRuntimePort {
  readonly running = new Set<string>();
  readonly models = new Map<string, string>();
  readonly thinking = new Map<string, string>();
  readonly forgotten: string[] = [];

  isRunning(conversationId: string): boolean {
    return this.running.has(conversationId);
  }
  getModelOverride(conversationId: string): string | null {
    return this.models.get(conversationId) ?? null;
  }
  setModelOverride(conversationId: string, modelId: string | null): void {
    if (modelId === null) this.models.delete(conversationId);
    else this.models.set(conversationId, modelId);
  }
  getThinkingOverride(conversationId: string): string | null {
    return this.thinking.get(conversationId) ?? null;
  }
  setThinkingOverride(conversationId: string, level: string | null): void {
    if (level === null) this.thinking.delete(conversationId);
    else this.thinking.set(conversationId, level);
  }
  forget(conversationId: string): void {
    this.forgotten.push(conversationId);
    this.models.delete(conversationId);
    this.thinking.delete(conversationId);
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
  questions: QuestionRepository;
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

async function setup(config: Record<string, unknown> = BASE_CONFIG): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "ai-zen-services-conversations-"));
  const projectDir = join(dir, "project");
  await mkdir(projectDir, { recursive: true });

  const db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);

  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config), "utf-8");
  await writeFile(
    join(dir, "reasoning-presets.json"),
    JSON.stringify({
      "test-preset": {
        levels: {
          low: { reasoning_effort: "low" },
          high: { reasoning_effort: "high" },
        },
      },
    }),
    "utf-8",
  );

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

  const runtime = new FakeRuntime();
  const workspaces = new WorkspaceRepository(db);
  const conversations = new ConversationRepository(db);
  const messages = new MessageRepository(db);
  const assets = new AssetRepository(db);
  const questions = new QuestionRepository(db);
  clock = 1_700_000_000_000;
  const service = new ConversationService({
    conversations,
    messages,
    workspaces,
    assets,
    questions,
    configManager: new ConfigManager(configPath),
    runtime,
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
  };
  await workspaces.create({ id: "w1", name: "项目一", cwd: projectDir, createdAt: 1 });
  return harnessValue;
}

beforeEach(async () => {
  harness = await setup();
});

afterEach(async () => {
  await harness.db.close();
  await rm(harness.dir, { recursive: true, force: true });
});

describe("ConversationService.create（身份创建时定死，L7 / R18）", () => {
  it("助手绑定的模型优先于配置里的兜底模型，三件身份都落库", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const conversation = created.conversation;

    expect(conversation.workspaceId).toBe("w1");
    expect(conversation.agentId).toBe("a1");
    expect(conversation.modelId).toBe("m1");
    expect(conversation.model).toMatchObject({
      modelId: "m1",
      name: "模型一",
      vision: true,
      overriddenThisSession: false,
    });
    const stored = await harness.conversations.get(conversation.id);
    expect(stored?.agentId).toBe("a1");
    expect(stored?.modelId).toBe("m1");
  });

  it("入参明确点名模型时以它为准", async () => {
    const created = await harness.service.create({
      workspaceId: "w1",
      agentId: "a1",
      modelId: "m3",
    });
    expect(created.conversation.modelId).toBe("m3");
  });

  it("助手没绑模型时落到配置里的兜底模型", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a2" });
    expect(created.conversation.agentId).toBe("a2");
    expect(created.conversation.modelId).toBe("m3");
  });

  it("原名就是创建时间，所以 nameIsAuto 为真（D2）", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    expect(created.conversation.name).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(created.conversation.nameIsAuto).toBe(true);
  });

  it("项目不存在时报 not_found，不写半成品行", async () => {
    await expect(harness.service.create({ workspaceId: "没有这个项目", agentId: "a1" })).rejects.toMatchObject(
      { code: "not_found" },
    );
    expect(await harness.conversations.list()).toEqual([]);
  });

  it("助手不存在时报 not_found", async () => {
    await expect(harness.service.create({ workspaceId: "w1", agentId: "没有这个助手" })).rejects.toMatchObject(
      { code: "not_found" },
    );
    expect(await harness.conversations.list()).toEqual([]);
  });

  it("点名要的模型不存在时报 not_found", async () => {
    await expect(
      harness.service.create({ workspaceId: "w1", agentId: "a1", modelId: "没有这个模型" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("模型三级都解析不出来时报 config_invalid，文案是「给助手挑个模型」那条（R38），不写库", async () => {
    const bare = await setup({ ...BASE_CONFIG, defaultModel: undefined });
    try {
      await expect(
        bare.service.create({ workspaceId: "w1", agentId: "a2" }),
      ).rejects.toMatchObject({
        code: "config_invalid",
        messageKey: "error.modelUnresolved",
        detail: { agentId: "a2", defaultModel: null },
      });
      expect(await bare.conversations.list()).toEqual([]);
    } finally {
      await bare.db.close();
      await rm(bare.dir, { recursive: true, force: true });
    }
  });

  it("配置指向不存在的模型时也用同一条文案，原因在 detail 里", async () => {
    const broken = await setup({
      ...BASE_CONFIG,
      // 助手 a2 没绑模型，兜底层指向一个配置里没有的模型
      defaultModel: "不存在的模型",
    });
    try {
      await expect(
        broken.service.create({ workspaceId: "w1", agentId: "a2" }),
      ).rejects.toMatchObject({
        code: "config_invalid",
        messageKey: "error.modelUnresolved",
        detail: { modelId: "不存在的模型", level: "global", agentId: "a2" },
      });
      expect(await broken.conversations.list()).toEqual([]);
    } finally {
      await broken.db.close();
      await rm(broken.dir, { recursive: true, force: true });
    }
  });
});

describe("ConversationService.list（D13）", () => {
  it("置顶优先、再按创建时间倒序；改名与置顶都不改创建时间", async () => {
    const first = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const second = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const third = await harness.service.create({ workspaceId: "w1", agentId: "a1" });

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
    const first = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    await harness.service.pin({ conversationId: first.conversation.id, pinned: true });

    const pinnedOnly = await harness.service.list({ workspaceId: "w1", pinned: true });
    expect(pinnedOnly.conversations.map((item) => item.id)).toEqual([first.conversation.id]);

    const page = await harness.service.list({ workspaceId: "w1", limit: 1, offset: 1 });
    expect(page.conversations).toHaveLength(1);
    expect(page.total).toBe(2);
  });

  it("running 与 hasPendingQuestion 都从注入的那一侧现取", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    harness.runtime.running.add(created.conversation.id);
    await harness.questions.create({
      id: "q1",
      conversationId: created.conversation.id,
      kind: "confirmation",
      payload: {},
      state: "pending",
      createdAt: 1,
    });

    const listed = await harness.service.list({ workspaceId: "w1" });
    expect(listed.conversations[0]).toMatchObject({ running: true, hasPendingQuestion: true });

    harness.runtime.running.delete(created.conversation.id);
    const again = await harness.service.get({ conversationId: created.conversation.id });
    expect(again.conversation.running).toBe(false);
  });
});

describe("ConversationService.get / rename / pin", () => {
  it("get 带上目录事实与消息统计", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
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
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
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
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;

    // 自动命名是 W4-H 的动作，这里直接走仓储那一条写入路径
    await harness.conversations.applyAutoName(id, "重写存储层", 2_000);

    const { conversation } = await harness.service.get({ conversationId: id });
    expect(conversation.name).toBe("重写存储层");
    expect(conversation.nameIsAuto).toBe(true);
  });

  it("用户改名之后再自动命名，又回到自动", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;

    await harness.service.rename({ conversationId: id, name: "我先自己起的名" });
    expect((await harness.service.get({ conversationId: id })).conversation.nameIsAuto).toBe(false);

    await harness.conversations.applyAutoName(id, "自动起的名字", 3_000);
    expect((await harness.service.get({ conversationId: id })).conversation.nameIsAuto).toBe(true);
  });
});

describe("ConversationService.delete（D17）", () => {
  it("dryRun 只算代价，真删后对话与消息一起消失，并回要清的文件清单", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
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
      conversationId: id,
      path: "assets/as1.png",
      mime: "image/png",
      bytes: 5,
      createdAt: 3,
    });

    const dry = await harness.service.delete({ conversationId: id, dryRun: true });
    expect(dry.removed).toBe(false);
    expect(dry.consequences).toEqual({ conversations: 1, messages: 1, assets: 1 });
    expect(dry.assetPaths).toEqual(["assets/as1.png"]);
    expect(await harness.conversations.get(id)).toBeDefined();

    const real = await harness.service.delete({ conversationId: id });
    expect(real.removed).toBe(true);
    expect(await harness.conversations.get(id)).toBeUndefined();
    expect(await harness.messages.countByConversation(id)).toBe(0);
    expect(harness.runtime.forgotten).toContain(id);
    await expect(harness.service.get({ conversationId: id })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("ConversationService.revert（D24）", () => {
  it("删到指定用户消息之前（含它），回填它当时的内容与素材", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
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
      conversationId: id,
      messageId: "u2",
      path: "assets/as1.png",
      mime: "image/png",
      bytes: 5,
      createdAt: 1_250,
    });

    const result = await harness.service.revert({ conversationId: id, beforeMessageId: "u2" });
    expect(result.removedMessageIds).toEqual(["u2", "a2"]);
    expect(result.restoredInput).toEqual({ content: "第二句", assetIds: ["as1"] });

    const left = await harness.messages.listByConversation(id);
    expect(left.map((message) => message.id)).toEqual(["u1", "a1"]);
  });

  it("撤回点不是用户消息时报参数错", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
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
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    await expect(
      harness.service.revert({ conversationId: created.conversation.id, beforeMessageId: "别处的" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("正在跑一轮时拒绝撤回", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    harness.runtime.running.add(created.conversation.id);
    await expect(
      harness.service.revert({
        conversationId: created.conversation.id,
        beforeMessageId: "随便一个",
      }),
    ).rejects.toMatchObject({ code: "busy" });
  });
});

describe("ConversationService.setModel（L7 / D20）", () => {
  it("临时换模型只交给运行时，库里的 modelId 不变", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;

    const result = await harness.service.setModel({ conversationId: id, modelId: "m3" });
    expect(result.conversation.model).toMatchObject({
      modelId: "m3",
      overriddenThisSession: true,
    });
    expect(result.model.modelId).toBe("m3");
    // 阈值跟着新模型走
    expect(result.context.handoffThreshold).toBe(60);
    expect(result.context.guardThreshold).toBe(160);
    // 库里的身份没有被动过
    expect((await harness.conversations.get(id))?.modelId).toBe("m1");
    expect(harness.runtime.models.get(id)).toBe("m3");
  });

  it("传 null 或传回身份上的那个模型都等于「回到默认」", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;

    await harness.service.setModel({ conversationId: id, modelId: "m3" });
    const cleared = await harness.service.setModel({ conversationId: id, modelId: null });
    expect(cleared.model).toMatchObject({ modelId: "m1", overriddenThisSession: false });
    expect(harness.runtime.models.has(id)).toBe(false);

    await harness.service.setModel({ conversationId: id, modelId: "m3" });
    const same = await harness.service.setModel({ conversationId: id, modelId: "m1" });
    expect(same.model.overriddenThisSession).toBe(false);
    expect(harness.runtime.models.has(id)).toBe(false);
  });

  it("历史里有图而新模型不看图时拒绝并说明原因", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    await harness.assets.create({
      id: "as1",
      conversationId: id,
      path: "assets/as1.png",
      mime: "image/png",
      bytes: 5,
      createdAt: 3,
    });

    await expect(
      harness.service.setModel({ conversationId: id, modelId: "m2" }),
    ).rejects.toMatchObject({ code: "model_unsupported", messageKey: "error.modelUnsupported" });
    // 被拒绝时什么都没改
    expect(harness.runtime.models.has(id)).toBe(false);
    expect((await harness.conversations.get(id))?.modelId).toBe("m1");
  });

  it("历史里没有图时允许换到不看图的模型", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const result = await harness.service.setModel({
      conversationId: created.conversation.id,
      modelId: "m2",
    });
    expect(result.model).toMatchObject({ modelId: "m2", vision: false });
  });

  it("换到不存在的模型报 not_found", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    await expect(
      harness.service.setModel({ conversationId: created.conversation.id, modelId: "没有这个模型" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("上下文占用取最近一次请求的用量", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    await harness.messages.upsert({
      id: "a1",
      conversationId: id,
      role: "assistant",
      status: "completed",
      content: "回复",
      data: { usage: { prompt_tokens: 120, completion_tokens: 10, total_tokens: 130 } },
      createdAt: 5,
    });

    const result = await harness.service.setModel({ conversationId: id, modelId: "m3" });
    expect(result.context.usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 10,
      total_tokens: 130,
    });
    // 120 过了 m3 的交接线（60）与硬线（160）之间
    expect(result.context.overHandoff).toBe(true);
    expect(result.context.overGuard).toBe(false);
  });
});

describe("ConversationService.setThinking（F-B6 / F-B7）", () => {
  it("跟随助手定义：参数对上某一档就报那一档", async () => {
    await writeFile(
      join(harness.dir, "agents", "a1.json"),
      JSON.stringify({
        id: "a1",
        name: "助手一",
        messages: [],
        modelId: "m1",
        modelParams: { reasoning_effort: "high", temperature: 0.2 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf-8",
    );

    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    expect(created.conversation.thinking).toEqual({
      preset: "test-preset",
      levels: ["low", "high"],
      selected: "high",
      source: "following_default",
      params: { reasoning_effort: "high" },
    });
  });

  it("临时调档写进运行时，并回展开后的参数", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    const id = created.conversation.id;
    const result = await harness.service.setThinking({ conversationId: id, level: "low" });

    expect(result.thinking).toMatchObject({
      selected: "low",
      source: "manual",
      params: { reasoning_effort: "low" },
    });
    expect(harness.runtime.thinking.get(id)).toBe("low");
  });

  it("档位不在策略表里时报参数错", async () => {
    const created = await harness.service.create({ workspaceId: "w1", agentId: "a1" });
    await expect(
      harness.service.setThinking({ conversationId: created.conversation.id, level: "超高" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("模型没有思考策略时报 unsupported", async () => {
    const created = await harness.service.create({
      workspaceId: "w1",
      agentId: "a1",
      modelId: "m2",
    });
    await expect(
      harness.service.setThinking({ conversationId: created.conversation.id, level: "low" }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(created.conversation.thinking.source).toBe("not_adjustable");
  });
});

describe("对外失败一律是 ServerError", () => {
  it("不存在的对话在每个方法上都报 ServerError", async () => {
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
      await expect(call).rejects.toBeInstanceOf(ServerError);
    }
  });
});
