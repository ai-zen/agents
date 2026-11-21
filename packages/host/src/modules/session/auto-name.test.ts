/**
 * 自动起名的验收。
 *
 * 四条判据各一条正例/反例：闲下来那一拍（挂在运行时的事实流上，非 `state:idle` 不动手）、名字还归
 * 自动、用户本人说的话恰好一条、开关开着。判据写错的后果不会报错，只会悄悄发生：把「用户改过名」
 * 判掉，下一次闲下来用户自己起的名字就被换掉了；把「恰好一条」判成「有用户消息就行」，答过好几
 * 句的名字还会接着变。所以每一条都带正例 —— 一个从不发请求的实现也能让反例的断言全绿。
 *
 * 另外两条说的是写回与失败：成功之后会话行上的名字换了、`nameIsAuto` 仍然是真；失败推一条会话内
 * 通知，而这一段照旧接着收消息（起名是一次额外请求，它不是这一段的活）。
 *
 * 模型不出网：请求那一条路注入一个假的客户端，它只做一件真客户端也做的事 —— 把请求记下来，
 * 再按用例给的答案回一句。
 */

import { AgentNS, Message } from "@ai-zen/agents-core";
import type { AgentModel, AgentRuntime, AppConfig, RuntimeFact } from "@ai-zen/agents-sdk";
import { ConfigManager } from "@ai-zen/agents-sdk";
import { describe, expect, it, vi } from "vitest";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import { AssetService } from "../asset/service.js";
import { assetTable, sessionAssetTable } from "../asset/table.js";
import { HostObserver } from "../agent/observer.js";
import { inboxTable } from "../agent/inbox.js";
import type { ConfigEvent } from "../config/events.js";
import { GeneralConfig } from "../config/general.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { NoticeService } from "../notice/service.js";
import { noticeTable } from "../notice/table.js";
import type { Notice } from "../notice/types.js";
import { workspaceTable } from "../workspace/table.js";
import { AutoNamer } from "./auto-name.js";
import { messageTable } from "./messages.js";
import { SessionService } from "./service.js";
import { sessionTable } from "./table.js";
import type { NewSession } from "./types.js";

const config: AppConfig = {
  endpoints: [{ id: "ep-1", name: "ep-1", baseUrl: "https://ep-1.example/v1", apiKey: "key" }],
  models: [
    {
      id: "naming-1",
      name: "naming-1",
      endpointId: "ep-1",
      tokenThresholds: { handoff: 100, guard: 150 },
    },
  ],
  namingModel: "naming-1",
};

const CREATED_AT_NAME = "1712345678000";

const input: NewSession = {
  workspaceId: "ws-1",
  name: CREATED_AT_NAME,
  agentId: "agent-1",
  modelId: "naming-1",
  nameIsAuto: true,
  autoHandoff: false,
  lineage: null,
};

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * 一段会话要用的那几样，加一个假运行时。
 *
 * 假运行时只做一件事：把用例发出来的事实交给订阅者（真的那一个还会把执行体的事件转发上来）。
 * 观察者与自动起名按装配根那个次序挂在它上面 —— 观察者在前，起名读到的记忆才是刚写进去的那份。
 */
function setup(answer: () => Promise<string> = async () => "把宿主的交接写出来") {
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });

  const t = createTranslator(() => "zh");
  const sessions = new SessionService({
    sessions: sessionTable(db),
    events: createBus<HostEvent>(),
    t,
  });
  const messages = messageTable(db);

  // 落盘那一步用只接住写入的替身：这几条用例问的是「动手那一刻读到的是哪一份配置」，不是文件里
  // 落了什么
  const general = new GeneralConfig({
    config: { write: async () => {} } as unknown as ConfigManager,
    current: config,
    events: createBus<ConfigEvent>(),
  });

  // 假的模型客户端：把请求记下来，再回用例给的那一句
  const requests: unknown[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: unknown) => {
          requests.push(body);
          return { choices: [{ message: { content: await answer() } }] };
        },
      },
    },
  } as unknown as AgentModel["client"];

  const errors: unknown[] = [];
  const notices = new NoticeService({
    notices: noticeTable(db),
    events: createBus<HostEvent>(),
    log: silent,
  });

  const namer = new AutoNamer({
    sessions,
    messages,
    config: general,
    createModel: () => ({ client, model: "naming-1" }),
    notices,
    t,
    onError: (error) => {
      errors.push(error);
    },
  });

  const observer = new HostObserver({
    messages,
    inbox: inboxTable(db),
    assets: new AssetService({
      assets: assetTable(db),
      sessionAssets: sessionAssetTable(db),
      dataRoot: ":memory:",
      t,
    }),
    events: createBus<HostEvent>(),
    onError: (error) => {
      errors.push(error);
    },
    isHandingOff: () => false,
  });

  const listeners: Array<(fact: RuntimeFact) => void> = [];
  const runtime = {
    observe: (listener: (fact: RuntimeFact) => void) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
  } as unknown as AgentRuntime;

  observer.attach(runtime);
  const detach = namer.watch(runtime);

  return {
    namer,
    sessions,
    messages,
    notices,
    requests,
    errors,
    general,
    detach,
    /** 一条运行时事实：与真的那一条同形，缺的几格（agent / seq / at）只有观察者读 */
    emit: (fact: Record<string, unknown>) => {
      const full = { agent: { id: "agent-1", state: "idle" }, seq: 1, at: "", ...fact };
      for (const listener of listeners) listener(full as unknown as RuntimeFact);
    },
  };
}

function userMessage(id: string, text: string): AgentNS.Message {
  return new Message({
    id,
    role: AgentNS.Role.User,
    status: AgentNS.MessageStatus.Completed,
    content: text,
    source: { kind: "user" },
  });
}

function assistantMessage(id: string, text: string): AgentNS.Message {
  return new Message({
    id,
    role: AgentNS.Role.Assistant,
    status: AgentNS.MessageStatus.Completed,
    content: text,
  });
}

describe("起名：用户说的话恰好一条", () => {
  /**
   * 反例是答过两句的那一段（用户说了两次），正例是「说了一句 + 宿主注入的那条隐藏消息」—— 后者
   * 是判据最容易错的一格：按 `role` 数，那条隐藏的 cwd 消息也是 user。
   */
  it("两条用户消息不跑，一条跑（宿主注入的隐藏消息不算用户说的）", async () => {
    const { namer, sessions, messages, requests } = setup();

    const twice = sessions.create(input);
    messages.upsertMany(twice.id, [
      userMessage("m-1", "帮我把宿主的交接写出来"),
      assistantMessage("m-2", "先把状态机那一格定下来"),
      userMessage("m-3", "再补一条用例"),
      assistantMessage("m-4", "写好了"),
    ]);

    await namer.name(twice.id);

    expect(requests).toHaveLength(0);
    expect(sessions.get(twice.id)?.name).toBe(CREATED_AT_NAME);

    const once = sessions.create(input);
    messages.upsertMany(once.id, [
      // 隐藏的 cwd 那条：`role` 是 user，`source` 说的是「宿主注入的」
      new Message({
        id: "m-5",
        role: AgentNS.Role.User,
        status: AgentNS.MessageStatus.Completed,
        content: "cwd: /tmp/ws-1",
        hidden: true,
        source: { kind: "system", label: "cwd" },
      }),
      userMessage("m-6", "帮我把宿主的交接写出来"),
      assistantMessage("m-7", "先把状态机那一格定下来"),
    ]);

    await namer.name(once.id);

    expect(requests).toHaveLength(1);
  });
});

describe("起名：名字还归自动", () => {
  it("用户改过名的不跑", async () => {
    const { namer, sessions, messages, requests } = setup();

    const renamed = sessions.create({ ...input, name: "我自己起的名字", nameIsAuto: false });
    messages.upsertMany(renamed.id, [
      userMessage("m-1", "帮我把宿主的交接写出来"),
      assistantMessage("m-2", "先把状态机那一格定下来"),
    ]);

    await namer.name(renamed.id);

    expect(requests).toHaveLength(0);
    expect(sessions.get(renamed.id)).toMatchObject({
      name: "我自己起的名字",
      nameIsAuto: false,
    });
  });
});

describe("起名：开关", () => {
  /**
   * 关掉就不发那次请求；再打开立刻又发。起手那份没写这一格，前面几条已经验了「缺省算开」——
   * 这里验另一个方向，以及关掉之后名字保持创建时那一个。
   */
  it("autoTitle 关掉之后一次请求都不发，改回开着当场又能起名", async () => {
    const { namer, sessions, messages, requests, general } = setup();

    const naming = sessions.create(input);
    messages.upsertMany(naming.id, [
      userMessage("m-1", "帮我把宿主的交接写出来"),
      assistantMessage("m-2", "先把状态机那一格定下来"),
    ]);

    // 装配那一刻这一格还是开着的，关掉不必重建任何东西
    await general.patch({ autoTitle: false });
    await namer.name(naming.id);

    expect(requests).toHaveLength(0);
    expect(sessions.get(naming.id)?.name).toBe(CREATED_AT_NAME);

    await general.patch({ autoTitle: true });
    await namer.name(naming.id);

    expect(requests).toHaveLength(1);
  });
});

describe("起名：写回", () => {
  it("闲下来那一刻起名，名字换了而 nameIsAuto 仍为真", async () => {
    const { sessions, messages, requests, emit } = setup();

    const naming = sessions.create(input);
    const createdAt = sessions.get(naming.id)?.updatedAt;
    messages.upsertMany(naming.id, [
      userMessage("m-1", "帮我把宿主的交接写出来"),
      assistantMessage("m-2", "先把状态机那一格定下来"),
    ]);

    // 不是那一拍就不动手：忙起来那一片事实进来，一个请求都不该发
    emit({ type: "state:working", sessionId: naming.id });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(0);

    emit({ type: "state:idle", sessionId: naming.id });

    await vi.waitFor(() => expect(requests).toHaveLength(1), { interval: 5 });
    await vi.waitFor(() => expect(sessions.get(naming.id)?.name).toBe("把宿主的交接写出来"), {
      interval: 5,
    });
    // 自动起的名字还能被下一个名字换掉，所以这一格仍是真；`updatedAt` 换新说明走的是会话行那条
    // 更新路径
    expect(sessions.get(naming.id)).toMatchObject({ name: "把宿主的交接写出来", nameIsAuto: true });
    expect(sessions.get(naming.id)?.updatedAt).toBeGreaterThanOrEqual(createdAt ?? 0);
  });
});

describe("起名：失败", () => {
  /**
   * 失败有两条后果：一条会话内通知（用户要知道名字为什么没换），以及「这一段照旧接着收消息」
   * —— 起名是额外那一次请求，它失败不该把这一段怎么样。
   */
  it("推一条会话内通知，会话行不动，这一段照旧接着收消息", async () => {
    const { sessions, messages, notices, errors, emit } = setup(async () => {
      throw new Error("naming endpoint is down");
    });

    const naming = sessions.create(input);
    const user = userMessage("m-1", "帮我把宿主的交接写出来");
    const reply = assistantMessage("m-2", "先把状态机那一格定下来");
    const next = assistantMessage("m-3", "用例也补上了");

    // 记忆由观察者从事实写进库：与生产里那条路同一个次序（先落消息，最后才是闲下来那一拍）
    emit({ type: "messageAdded", sessionId: naming.id, message: user });
    emit({ type: "messageChanged", sessionId: naming.id, message: reply });
    emit({ type: "state:idle", sessionId: naming.id });

    const notice = await vi.waitFor(
      () => {
        const [first] = notices.listBySession(naming.id);
        expect(first).toBeDefined();
        return first as Notice;
      },
      { interval: 5 },
    );

    expect(notice).toMatchObject({
      level: "warning",
      code: "auto_title_failed",
      sessionId: naming.id,
      // 句子在产生处渲染：库里存的就是那一句成品
      message: "这一段会话自动起名失败，名字还是创建时的那一个",
      durationMs: null,
    });
    // 失败也记了日志，宿主那一侧另有去处
    expect(errors.length).toBeGreaterThan(0);

    // 名字与那一格都没动：失败不是「换了个名字」
    expect(sessions.get(naming.id)).toMatchObject({ name: CREATED_AT_NAME, nameIsAuto: true });

    // 这一段照旧接着收消息：起名失败之后落进来的那条一样进库
    emit({ type: "messageAdded", sessionId: naming.id, message: next });
    expect(messages.listBySession(naming.id).map((message) => message.id)).toContain("m-3");
  });
});
