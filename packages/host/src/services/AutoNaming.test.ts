/**
 * 自动命名的验收（D2 / F-C4 / R35）：只在「第一轮结束之后 + 用户没改过名字 + 开关开着」时才起名；
 * 用取名模型（缺省回落兜底模型）；起不出名就保持原名；写回时 `nameIsAuto` 继续为真。
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentNS } from "@ai-zen/agents-core";
import { ConfigManager } from "@ai-zen/agents-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConversationRepository } from "../storage/ConversationRepository.js";
import { Database } from "../storage/Database.js";
import { MessageRepository } from "../storage/MessageRepository.js";
import { NoticeRepository } from "../storage/NoticeRepository.js";
import { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import { migrate } from "../storage/migrations.js";
import { AutoNaming } from "./AutoNaming.js";
import type { TitleCompleter } from "./AutoNaming.js";
import { NoticeService } from "./NoticeService.js";

interface CompletionCall {
  system: string;
  user: string;
  modelId: string;
}

interface Harness {
  dir: string;
  db: Database;
  conversations: ConversationRepository;
  messages: MessageRepository;
  notices: NoticeRepository;
  service: AutoNaming;
  calls: CompletionCall[];
  behaviour: { reply: () => Promise<string> };
  events: Array<{ name: string; payload: unknown }>;
}

const BASE_CONFIG = {
  endpoints: [{ id: "e1", name: "端点一", baseUrl: "https://example.test/v1", apiKey: "k" }],
  models: [
    { id: "m-big", name: "大模型", endpointId: "e1" },
    { id: "m-small", name: "小模型", endpointId: "e1" },
  ],
  defaultModel: "m-big",
  namingModel: "m-small",
  defaultAgent: "a1",
};

async function setup(config: Record<string, unknown> = BASE_CONFIG): Promise<Harness> {
  const configPath = await writeConfig(config);
  return buildHarness(configPath);
}

let dir: string;
let db: Database;
let workspaces: WorkspaceRepository;
let conversations: ConversationRepository;
let messages: MessageRepository;
let notices: NoticeRepository;
/** 这个用例里已经写过几份配置文件（每次 `setup` 一份，互不覆盖） */
let configSeq = 0;

/** 写一份配置到自己的文件：`ConfigManager` 每次读盘、无缓存，换配置不用换库 */
async function writeConfig(config: Record<string, unknown>): Promise<string> {
  configSeq += 1;
  const configPath = join(dir, `config-${configSeq}.json`);
  await writeFile(configPath, JSON.stringify(config), "utf-8");
  return configPath;
}

/** 一套服务实例（收集调用、可换行为、事件数组、时钟都只活在实例上） */
function buildHarness(configPath: string): Harness {
  const calls: CompletionCall[] = [];
  const events: Array<{ name: string; payload: unknown }> = [];
  const behaviour = { reply: async (): Promise<string> => "  修复登录页  " };
  const complete: TitleCompleter = async (input) => {
    calls.push(input);
    return await behaviour.reply();
  };

  const noticeService = new NoticeService({ notices, now: () => 1_700_000_100_000 });
  const service = new AutoNaming({
    conversations,
    messages,
    configManager: new ConfigManager(configPath),
    complete,
    notices: noticeService,
    now: () => 1_700_000_100_000,
    emit: (name, payload) => {
      events.push({ name, payload });
    },
  });

  return { dir, db, conversations, messages, notices, service, calls, behaviour, events };
}

/** 落一轮「用户 + 助手」 */
async function seedFirstTurn(harness: Harness, conversationId = "c1"): Promise<void> {
  await harness.messages.upsertMany([
    {
      id: `${conversationId}-u1`,
      conversationId,
      role: AgentNS.Role.User as string,
      status: AgentNS.MessageStatus.Completed as string,
      content: "登录页点提交没反应",
      createdAt: 2,
    },
    {
      id: `${conversationId}-a1`,
      conversationId,
      role: AgentNS.Role.Assistant as string,
      status: AgentNS.MessageStatus.Completed as string,
      content: "表单的 submit 事件没绑上，我加上了。",
      createdAt: 3,
    },
  ]);
}

let harness: Harness;

// 整个文件共用一个库：`new + migrate` 每用例 55ms，清表只是一条 DELETE 批次。
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-autonaming-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);

  workspaces = new WorkspaceRepository(db);
  conversations = new ConversationRepository(db);
  messages = new MessageRepository(db);
  notices = new NoticeRepository(db);
});

beforeEach(async () => {
  // 只清业务表；`meta` 绝不碰（migrate 靠 meta.schemaVersion 判断跑不跑）
  await db.tx((tx) => [
    tx.run("DELETE FROM notices"),
    tx.run("DELETE FROM questions"),
    tx.run("DELETE FROM workspaces"),
    tx.run("DELETE FROM assets"),
    tx.run("DELETE FROM credentials"),
  ]);
  // 配置是写进磁盘的：把上一条用例留下的那份（连同变体配置）全部清掉，再回到基准
  for (const name of await readdir(dir)) {
    if (name.startsWith("config") && name.endsWith(".json")) {
      await rm(join(dir, name), { force: true });
    }
  }
  configSeq = 0;

  await workspaces.create({ id: "w1", name: "项目一", cwd: join(dir, "project"), createdAt: 1 });
  await conversations.create({
    id: "c1",
    workspaceId: "w1",
    name: "2026-01-01 00:00",
    agentId: "a1",
    modelId: "m-big",
    createdAt: 1,
    updatedAt: 1,
  });

  harness = await setup();
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("自动命名的触发条件（D2 / F-C4）", () => {
  it("第一轮之后、没改过名、开关开着 → 起名并写回（nameIsAuto 保持为真）", async () => {
    await seedFirstTurn(harness);
    const outcome = await harness.service.afterTurn("c1");

    expect(outcome).toMatchObject({ named: true, name: "修复登录页", skipped: null, problem: null });
    const row = await harness.conversations.get("c1");
    expect(row?.name).toBe("修复登录页");
    expect(row?.nameIsAuto).toBe(true);
  });

  it("用「取名模型」：配了 namingModel 就用它", async () => {
    await seedFirstTurn(harness);
    await harness.service.afterTurn("c1");
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.modelId).toBe("m-small");
    // 喂给模型的是第一轮那两句
    expect(harness.calls[0]?.user).toContain("登录页点提交没反应");
    expect(harness.calls[0]?.user).toContain("表单的 submit 事件没绑上");
  });

  it("没配取名模型就回落兜底模型", async () => {
    // 换一份配置不需要换库：`ConfigManager` 每次读盘，换个 config 文件就够
    const bare = await setup({ ...BASE_CONFIG, namingModel: undefined });
    await seedFirstTurn(bare);
    await bare.service.afterTurn("c1");
    expect(bare.calls[0]?.modelId).toBe("m-big");
  });

  it("用户改过名字就不动它（nameIsAuto 为假）", async () => {
    await seedFirstTurn(harness);
    await harness.conversations.renameByUser("c1", "我自己起的名字", 10);

    const outcome = await harness.service.afterTurn("c1");
    expect(outcome).toMatchObject({ named: false, skipped: "renamed_by_user" });
    expect(harness.calls).toHaveLength(0);
    expect((await harness.conversations.get("c1"))?.name).toBe("我自己起的名字");
  });

  it("开关关掉就一次请求都不发", async () => {
    const off = await setup({ ...BASE_CONFIG, autoTitle: false });
    await seedFirstTurn(off);
    const outcome = await off.service.afterTurn("c1");
    expect(outcome).toMatchObject({ named: false, skipped: "disabled" });
    expect(off.calls).toHaveLength(0);
    expect((await off.conversations.get("c1"))?.name).toBe("2026-01-01 00:00");
  });

  it("第二轮之后不再起名（第一轮这个条件不成立了）", async () => {
    await seedFirstTurn(harness);
    await harness.messages.upsert({
      id: "c1-u2",
      conversationId: "c1",
      role: AgentNS.Role.User as string,
      status: AgentNS.MessageStatus.Completed as string,
      content: "再帮我看看样式",
      createdAt: 4,
    });

    const outcome = await harness.service.afterTurn("c1");
    expect(outcome).toMatchObject({ named: false, skipped: "not_first_turn" });
    expect(harness.calls).toHaveLength(0);
  });

  it("同一轮里连着调两次只起一次名", async () => {
    await seedFirstTurn(harness);
    await harness.service.afterTurn("c1");
    const again = await harness.service.afterTurn("c1");
    expect(again).toMatchObject({ named: false, skipped: "already_named" });
    expect(harness.calls).toHaveLength(1);
  });

  it("没有可用的取名模型就保持原名", async () => {
    const noModel = await setup({
      ...BASE_CONFIG,
      namingModel: undefined,
      defaultModel: undefined,
    });
    await seedFirstTurn(noModel);
    const outcome = await noModel.service.afterTurn("c1");
    expect(outcome).toMatchObject({ named: false, skipped: "no_model" });
    expect(noModel.calls).toHaveLength(0);
    expect((await noModel.conversations.get("c1"))?.name).toBe("2026-01-01 00:00");
  });

  it("配置指向一个不存在的模型也等于没有取名模型", async () => {
    const broken = await setup({ ...BASE_CONFIG, namingModel: "没有这个模型" });
    await seedFirstTurn(broken);
    expect(await broken.service.afterTurn("c1")).toMatchObject({
      named: false,
      skipped: "no_model",
    });
  });
});

describe("起不出名就保持原名（D2）", () => {
  it("模型回了个空串：名字一动不动，也不报错", async () => {
    await seedFirstTurn(harness);
    harness.behaviour.reply = async () => "   \n  ";
    const outcome = await harness.service.afterTurn("c1");

    expect(outcome).toMatchObject({ named: false, name: "2026-01-01 00:00", skipped: "empty_title" });
    expect((await harness.conversations.get("c1"))?.name).toBe("2026-01-01 00:00");
  });

  it("调用失败：保持原名，事实记在 problem 里", async () => {
    await seedFirstTurn(harness);
    harness.behaviour.reply = async () => {
      throw new Error("端点 401");
    };
    const outcome = await harness.service.afterTurn("c1");

    expect(outcome.named).toBe(false);
    expect(outcome.skipped).toBe("call_failed");
    expect(outcome.problem?.messageKey).toBe("autoName.failed");
    expect(outcome.problem?.detail).toMatchObject({ reason: "端点 401" });
    expect((await harness.conversations.get("c1"))?.name).toBe("2026-01-01 00:00");
  });

  it("对话不存在时给个明确原因，不抛错（这是后台钩子）", async () => {
    expect(await harness.service.afterTurn("没有这段")).toMatchObject({
      named: false,
      skipped: "conversation_missing",
    });
  });
});

describe("标题清洗", () => {
  it("去掉引号、Title: 前缀、换行里的解释、结尾标点，并限长", async () => {
    await seedFirstTurn(harness);
    harness.behaviour.reply = async () => 'Title: "修复登录页。"\n\n理由是用户说提交没反应';
    expect((await harness.service.afterTurn("c1")).name).toBe("修复登录页");
  });

  it("超长的名字截到侧栏放得下", async () => {
    await seedFirstTurn(harness);
    harness.behaviour.reply = async () => "很".repeat(200);
    const outcome = await harness.service.afterTurn("c1");
    expect(outcome.name).toHaveLength(60);
  });
});

describe("起名之后的副作用", () => {
  it("推一条 conversation.changed(renamed) 与一条 info 通知", async () => {
    await seedFirstTurn(harness);
    await harness.service.afterTurn("c1", "zh");

    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]?.name).toBe("conversation.changed");
    expect(harness.events[0]?.payload).toMatchObject({ conversationId: "c1", change: "renamed" });

    const notices = new NoticeService({ notices: harness.notices, now: () => 1_700_000_100_000 });
    const listed = await notices.list({}, "zh");
    expect(listed.notices).toHaveLength(1);
    expect(listed.notices[0]?.text.messageKey).toBe("notice.autoNamed");
    expect(listed.notices[0]?.text.params).toEqual({ name: "修复登录页" });
    expect(listed.notices[0]?.level).toBe("info");
  });
});
