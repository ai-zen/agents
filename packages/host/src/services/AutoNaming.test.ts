/**
 * 自动命名的验收：只在「名字还是创建时间默认值 + 开关开着」时才起名；用取名模型（缺省回落
 * 兜底模型）；起不出名就保持原名；写回时 `nameIsAuto` 继续为真；判据里**没有**任何「数消息
 * 条数」的条件 —— 换记忆之后那一段不会再被重新起名。
 *
 * 断言的全是**看得见的后果**：名字变了没有、请求发了几次、推了几条事件、抛没抛。`nameIfUnnamed`
 * 回的是 `void`（生产侧那个后台钩子只要它不抛），所以「为什么没起名」不靠返回值而是靠这些后果
 * 去钉 —— 那份清单也就住在这里（见下面的 `AutoNameSkip`）。
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentNS } from "@ai-zen/agents-core";
import { ConfigManager } from "@ai-zen/agents-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SessionRepository } from "../storage/SessionRepository.js";
import { Database } from "../storage/Database.js";
import { MessageRepository } from "../storage/MessageRepository.js";
import { NoticeRepository } from "../storage/NoticeRepository.js";
import { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import { migrate } from "../storage/migrations.js";
import { AutoNaming } from "./AutoNaming.js";
import type { TitleCompleter } from "./AutoNaming.js";
import { defaultSessionName } from "./SessionService.js";
import { NoticeService } from "./NoticeService.js";
import { QUIET_LOG } from "./TestSupport.js";

/** 夹具里那段会话的原名：创建时间默认值（起名的判据就是「名字还是不是它」） */
const DEFAULT_NAME = defaultSessionName(1);

interface CompletionCall {
  system: string;
  user: string;
  modelId: string;
}

interface Harness {
  dir: string;
  db: Database;
  sessions: SessionRepository;
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
let sessions: SessionRepository;
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

  const noticeService = new NoticeService({
    notices,
    now: () => 1_700_000_100_000,
    logger: QUIET_LOG,
  });
  const service = new AutoNaming({
    sessions,
    messages,
    configManager: new ConfigManager(configPath),
    complete,
    notices: noticeService,
    now: () => 1_700_000_100_000,
    emit: (name, payload) => {
      events.push({ name, payload });
    },
  });

  return { dir, db, sessions, messages, notices, service, calls, behaviour, events };
}

/** 落一次「用户 + 助手」 */
async function seedFirstTurn(harness: Harness, sessionId = "c1"): Promise<void> {
  await harness.messages.upsertMany([
    {
      id: `${sessionId}-u1`,
      sessionId,
      role: AgentNS.Role.User as string,
      status: AgentNS.MessageStatus.Completed as string,
      content: "登录页点提交没反应",
      createdAt: 2,
    },
    {
      id: `${sessionId}-a1`,
      sessionId,
      role: AgentNS.Role.Assistant as string,
      status: AgentNS.MessageStatus.Completed as string,
      content: "表单的 submit 事件没绑上，我加上了。",
      createdAt: 3,
    },
  ]);
}

let harness: Harness;

/**
 * 「为什么这次没起名」的那几格 —— **只住在这里**：生产代码不返回这个，只有用例拿它当清单。
 *
 * 「配置读不出来」与「叫模型失败」不在这几格里：它们不是「没起名」，是「这次没起成」，被抛给
 * 调用方（出口是 `app.ts` 的 `logger.warn`）。正文一句都没有的情形也不起名，它没有对应的值
 * —— 分支见 `nameIfUnnamed`。
 */
type AutoNameSkip =
  | "session_missing"
  | "disabled"
  /** 用户把名字改成了别的（`nameIsAuto` 为假）：这个名字归用户，不再动 */
  | "renamed_by_user"
  /** 名字不是默认值、也不是用户改的 —— 那就已经自动起过了，不再动 */
  | "already_named"
  | "no_model"
  | "empty_title";

/** 每一格对应哪一条用例（漏一格写在 `Record` 里就编译不过） */
const COVERED: Record<AutoNameSkip, string> = {
  session_missing: "会话不存在时不抛错、不发请求",
  disabled: "开关关着就一次请求都不发",
  renamed_by_user: "用户改过名字就不动它",
  already_named: "已经自动起过（含换记忆之后）就不再动",
  no_model: "没有可用的取名模型就保持原名",
  empty_title: "模型给了空串：保持原名、不报错",
};

// 整个文件共用一个库：`new + migrate` 每用例 55ms，清表只是一条 DELETE 批次。
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-autonaming-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);

  workspaces = new WorkspaceRepository(db);
  sessions = new SessionRepository(db);
  messages = new MessageRepository(db);
  notices = new NoticeRepository(db);
});

beforeEach(async () => {
  // 只清业务表；`meta` 绝不碰（migrate 靠 meta.schemaVersion 判断跑不跑）
  await db.tx((tx) => [
    tx.run("DELETE FROM notices"),
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
  await sessions.create({
    id: "c1",
    workspaceId: "w1",
    name: DEFAULT_NAME,
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
  it("六格闭集都有用例钉着（它们从前是返回值里的 `skipped`）", () => {
    expect(Object.keys(COVERED).sort()).toEqual(
      [
        "already_named",
        "session_missing",
        "disabled",
        "empty_title",
        "no_model",
        "renamed_by_user",
      ].sort(),
    );
  });

  it("名字还是创建时间默认值、开关开着 → 起名并写回（nameIsAuto 保持为真）", async () => {
    await seedFirstTurn(harness);
    await harness.service.nameIfUnnamed("c1");

    const row = await harness.sessions.get("c1");
    expect(row?.name).toBe("修复登录页");
    expect(row?.nameIsAuto).toBe(true);
    expect(harness.calls).toHaveLength(1);
  });

  it("用「取名模型」：配了 namingModel 就用它", async () => {
    await seedFirstTurn(harness);
    await harness.service.nameIfUnnamed("c1");
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.modelId).toBe("m-small");
    // 喂给模型的是开头那两句
    expect(harness.calls[0]?.user).toContain("登录页点提交没反应");
    expect(harness.calls[0]?.user).toContain("表单的 submit 事件没绑上");
  });

  it("没配取名模型就回落兜底模型", async () => {
    // 换一份配置不需要换库：`ConfigManager` 每次读盘，换个 config 文件就够
    const bare = await setup({ ...BASE_CONFIG, namingModel: undefined });
    await seedFirstTurn(bare);
    await bare.service.nameIfUnnamed("c1");
    expect(bare.calls[0]?.modelId).toBe("m-big");
  });

  it("用户改过名字就不动它（nameIsAuto 为假）", async () => {
    await seedFirstTurn(harness);
    await harness.sessions.renameByUser("c1", "我自己起的名字", 10);

    await harness.service.nameIfUnnamed("c1");
    expect(harness.calls).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
    expect((await harness.sessions.get("c1"))?.name).toBe("我自己起的名字");
  });

  it("开关关掉就一次请求都不发", async () => {
    const off = await setup({ ...BASE_CONFIG, autoTitle: false });
    await seedFirstTurn(off);

    await off.service.nameIfUnnamed("c1");
    expect(off.calls).toHaveLength(0);
    expect((await off.sessions.get("c1"))?.name).toBe(DEFAULT_NAME);
  });

  it("配置读不出来：把失败交给调用方，不发请求", async () => {
    // 真的读坏一份配置很难造（`ConfigManager` 会恢复出厂），所以这里换一个会抛的读盘口：
    // 这一格验的是「读不出配置就把失败交出去」，不是配置怎么坏的
    const broken = new AutoNaming({
      sessions: harness.sessions,
      messages: harness.messages,
      configManager: {
        read: async () => {
          throw new Error("配置读不出来");
        },
      } as unknown as ConfigManager,
      complete: async (input) => {
        harness.calls.push(input);
        return "不该走到这里";
      },
      now: () => 1_700_000_100_000,
    });
    await seedFirstTurn(harness);

    await expect(broken.nameIfUnnamed("c1")).rejects.toThrow("配置读不出来");
    expect(harness.calls).toHaveLength(0);
    expect((await harness.sessions.get("c1"))?.name).toBe(DEFAULT_NAME);
  });

  it("第二次说话之后照样起名：判据里不数消息条数", async () => {
    await seedFirstTurn(harness);
    await harness.messages.upsert({
      id: "c1-u2",
      sessionId: "c1",
      role: AgentNS.Role.User as string,
      status: AgentNS.MessageStatus.Completed as string,
      content: "再帮我看看样式",
      createdAt: 4,
    });

    // 名字还是默认值 → 还是该起名。这一段已经有两句用户话了，但「几句」不是判据
    await harness.service.nameIfUnnamed("c1");
    expect((await harness.sessions.get("c1"))?.name).toBe("修复登录页");
    expect(harness.calls).toHaveLength(1);
  });

  it("换记忆之后不重新起名：名字已经不是默认值，库里有几条消息都不算数", async () => {
    // 交接是**原地换人**：名字一个字不动，但库里那一段只剩一条 hidden 的断点 + 之后新说的话。
    // 按「消息条数」判就会以为这是还没起过名的一段；按名字判则不会动 —— 它已经不是创建时间
    // 那个默认值了。
    await harness.sessions.create({
      id: "c2",
      workspaceId: "w1",
      name: "修复登录页",
      agentId: "a1",
      modelId: "m-big",
      createdAt: 1,
      updatedAt: 1,
    });
    await harness.messages.upsertMany([
      {
        id: "c2-breakpoint",
        sessionId: "c2",
        role: AgentNS.Role.System as string,
        status: AgentNS.MessageStatus.Completed as string,
        content: "/tmp/project/.ai-zen/handoffs/20260101-000000.md",
        data: { hidden: true },
        createdAt: 2,
      },
      {
        id: "c2-u1",
        sessionId: "c2",
        role: AgentNS.Role.User as string,
        status: AgentNS.MessageStatus.Completed as string,
        content: "接着上次的来",
        createdAt: 3,
      },
    ]);

    await harness.service.nameIfUnnamed("c2");
    expect(harness.calls).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
    expect((await harness.sessions.get("c2"))?.name).toBe("修复登录页");
  });

  it("连着调两次只起一次名（第二次名字已不是默认值）", async () => {
    await seedFirstTurn(harness);
    await harness.service.nameIfUnnamed("c1");
    await harness.service.nameIfUnnamed("c1");
    expect(harness.calls).toHaveLength(1);
    expect(harness.events).toHaveLength(1);
  });

  it("没有可用的取名模型就保持原名", async () => {
    const noModel = await setup({
      ...BASE_CONFIG,
      namingModel: undefined,
      defaultModel: undefined,
    });
    await seedFirstTurn(noModel);

    await noModel.service.nameIfUnnamed("c1");
    expect(noModel.calls).toHaveLength(0);
    expect((await noModel.sessions.get("c1"))?.name).toBe(DEFAULT_NAME);
  });

  it("配置指向一个不存在的模型也等于没有取名模型", async () => {
    const broken = await setup({ ...BASE_CONFIG, namingModel: "没有这个模型" });
    await seedFirstTurn(broken);

    await broken.service.nameIfUnnamed("c1");
    expect(broken.calls).toHaveLength(0);
    expect((await broken.sessions.get("c1"))?.name).toBe(DEFAULT_NAME);
  });
});

describe("起不出名就保持原名（D2）", () => {
  it("模型回了个空串：名字一动不动，也不报错", async () => {
    await seedFirstTurn(harness);
    harness.behaviour.reply = async () => "   \n  ";

    await harness.service.nameIfUnnamed("c1");
    expect((await harness.sessions.get("c1"))?.name).toBe(DEFAULT_NAME);
    expect(harness.events).toHaveLength(0);
  });

  it("会话不存在时不抛错（这是后台钩子）", async () => {
    await expect(harness.service.nameIfUnnamed("没有这段")).resolves.toBeUndefined();
    expect(harness.calls).toHaveLength(0);
  });
});

describe("起不成名是一次失败，交给调用方（出口在 `app.ts` 的 `logger.warn`）", () => {
  it("端点 401：抛给调用方，名字一动不动，也不推事件", async () => {
    await seedFirstTurn(harness);
    harness.behaviour.reply = async () => {
      throw new Error("端点 401");
    };

    await expect(harness.service.nameIfUnnamed("c1")).rejects.toThrow("端点 401");
    expect(harness.calls).toHaveLength(1);
    expect(harness.events).toHaveLength(0);
    expect((await harness.sessions.get("c1"))?.name).toBe(DEFAULT_NAME);
  });
});

describe("标题清洗", () => {
  it("去掉引号、Title: 前缀、换行里的解释、结尾标点，并限长", async () => {
    await seedFirstTurn(harness);
    harness.behaviour.reply = async () => 'Title: "修复登录页。"\n\n理由是用户说提交没反应';

    await harness.service.nameIfUnnamed("c1");
    expect((await harness.sessions.get("c1"))?.name).toBe("修复登录页");
  });

  it("超长的名字截到侧栏放得下", async () => {
    await seedFirstTurn(harness);
    harness.behaviour.reply = async () => "很".repeat(200);

    await harness.service.nameIfUnnamed("c1");
    expect((await harness.sessions.get("c1"))?.name).toHaveLength(60);
  });
});

describe("起名之后的副作用", () => {
  it("推一条 session.changed(renamed) 与一条 info 通知", async () => {
    await seedFirstTurn(harness);
    await harness.service.nameIfUnnamed("c1", "zh");

    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]?.name).toBe("session.changed");
    expect(harness.events[0]?.payload).toMatchObject({ sessionId: "c1", change: "renamed" });

    const notices = new NoticeService({
      notices: harness.notices,
      now: () => 1_700_000_100_000,
      logger: QUIET_LOG,
    });
    const listed = await notices.list({}, "zh");
    expect(listed.notices).toHaveLength(1);
    expect(listed.notices[0]?.text.messageKey).toBe("notice.autoNamed");
    expect(listed.notices[0]?.text.params).toEqual({ name: "修复登录页" });
    expect(listed.notices[0]?.level).toBe("info");
  });
});
