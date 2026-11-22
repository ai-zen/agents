/**
 * 重装前后，库里那一份排队区与内存里那一份对得上。
 *
 * 这条路上有两件事同时成立才算对：
 * - `materialsFor` 抢在杀之前把还排着的条目交给重装，装回来时它们被原样放回队列（内存那一份）；
 * - 杀报出的 `inboxCleared` 在重装窗口里不作废库里那几行（`ReloadWindow`）。
 *
 * 缺了后者，库里那几行会被观察者删掉，而放回队列那一步刻意不报 `inboxAdded`（放回去不是新变化），
 * 于是那几行再也回不来：内存里还排着，进程一重启就没了 —— 那是 `prd/04-session.md` 的「关掉再
 * 打开」与 `prd/05-control.md` 的「换模型不是杀死」同时不成立。
 *
 * 台架：真内存库、真 `SessionService`、真 `inbox` 表、真 `materialsFor`、真的 `HostObserver`
 * （删库行那一步正是要验的东西，换成替身就等于把它一起替掉了），只有运行时是替身 —— 造一个真
 * 运行时得先有一个能出网的模型、一份定义文件与一批能力容器，而这里要验的是「那一次清空之后库里
 * 还剩什么」。替身的 `kill` / `wake` 照内核那两条的口径来：`kill` 清空队列并报 `inboxCleared`，
 * `wake` 把材料里的 `waiting` 放回队列、不报任何事实（内核的 `restore` 就是这样）。
 */

import { tmpdir } from "node:os";

import { AgentNS, type Agent } from "@ai-zen/agents-core";
import type { AgentDefinition, AppConfig, RuntimeFact, SdkAgent } from "@ai-zen/agents-sdk";
import { describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import { AssetService } from "../asset/service.js";
import { assetTable, sessionAssetTable } from "../asset/table.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { noticeTable } from "../notice/table.js";
import { NoticeService } from "../notice/service.js";
import { messageTable } from "../session/messages.js";
import { SessionService } from "../session/service.js";
import { sessionTable } from "../session/table.js";
import type { Session } from "../session/types.js";
import { WorkspaceService } from "../workspace/service.js";
import { workspaceTable } from "../workspace/table.js";
import { inboxTable } from "./inbox.js";
import { materialsFor } from "./materials.js";
import type { MaterialsDeps } from "./materials.js";
import { HostObserver } from "./observer.js";
import { reloadDefinition } from "./reload.js";
import { ReloadWindow } from "./reload-window.js";

/** 生效模型：这段会话的 `modelId` 指向它（`materialsFor` 要按它取两条阈值） */
const MODEL = {
  id: "model-1",
  name: "模型一",
  endpointId: "ep-1",
  tokenThresholds: { handoff: 100, guard: 400 },
};

/**
 * 执行体替身：只留这条路上读写的那三格 —— 内存里的队列、队列还等不等着取件（输出闸）、
 * 以及关闸那个动作。重装会把输出闸按杀之前读到的那一格关回去，于是放回队列的条目不会立刻被
 * 取走，用例因此看得见「排队区里排着两条」。
 */
function fakeAgent(waiting: readonly AgentNS.InboxEntry[]): {
  inboxPending: AgentNS.InboxEntry[];
  isOutputPaused: boolean;
  pauseOutput: () => void;
} {
  const agent = {
    inboxPending: [...waiting],
    isOutputPaused: false,
    pauseOutput: () => {
      agent.isOutputPaused = true;
    },
  };
  return agent;
}

function newHost() {
  const db = openDatabase(":memory:");
  const t = createTranslator(() => "zh");
  const events = createBus<HostEvent>();
  const workspaces = new WorkspaceService({ workspaces: workspaceTable(db), t });
  const sessions = new SessionService({ sessions: sessionTable(db), events, t });
  const workspace = workspaces.create("项目一", "/tmp/reload-inbox");
  const messages = messageTable(db);
  const inbox = inboxTable(db);

  /**
   * 材料的来料：真的 `materialsFor`，只有定义、配置、交接、通知是替身（形状照
   * `materials.test.ts`，那几格在这条路上一个字都不参与判断）。
   */
  const materialDeps = {
    workspaces,
    definitions: {
      get: async (): Promise<AgentDefinition> => ({
        id: "agent-1",
        name: "助手",
        messages: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    } as unknown as MaterialsDeps["definitions"],
    config: {
      read: () => ({ defaultModel: "model-1", models: [MODEL] }) as unknown as AppConfig,
    } as unknown as MaterialsDeps["config"],
    messages,
    inbox,
    sessions,
    handoff: {
      automatic: () => ({}) as never,
      automaticMode: async () => null,
    } as unknown as MaterialsDeps["handoff"],
    assetPort: { readAsset: () => undefined },
    notices: new NoticeService({
      notices: noticeTable(db),
      events,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    }),
    t,
    onError: () => {},
  } as MaterialsDeps;

  const reloads = new ReloadWindow();
  /** 此刻有执行体的那几段会话 */
  const alive = new Map<string, ReturnType<typeof fakeAgent>>();
  const listeners = new Set<(fact: RuntimeFact) => void>();

  const runtime = {
    get: (sessionId: string) => alive.get(sessionId) as unknown as SdkAgent | undefined,
    observe: (listener: (fact: RuntimeFact) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    kill: (sessionId: string) => {
      const agent = alive.get(sessionId);
      if (agent === undefined) return;
      alive.delete(sessionId);
      // 内核那一条：清空是作废，所以报 `inboxCleared`（带被丢掉的那几条）
      const cleared = agent.inboxPending.splice(0, agent.inboxPending.length);
      const fact: RuntimeFact = {
        type: "inboxCleared",
        sessionId,
        agent: agent as unknown as Agent,
        seq: 1,
        at: new Date().toISOString(),
        entries: cleared,
      };
      for (const listener of [...listeners]) listener(fact);
    },
    wake: async (sessionId: string, materials: { waiting?: readonly AgentNS.InboxEntry[] }) => {
      // 内核那一条：放回队列不报事实（放回去不是新变化），于是库里那几行没有第二个写点
      const agent = fakeAgent(materials.waiting ?? []);
      alive.set(sessionId, agent);
      return agent as unknown as SdkAgent;
    },
  };

  /** 观察者与装配根上那一个同形：全进程一份，窗口由重装那条路开关 */
  const observer = new HostObserver({
    messages,
    inbox,
    assets: new AssetService({
      assets: assetTable(db),
      sessionAssets: sessionAssetTable(db),
      dataRoot: tmpdir(),
      t,
    }),
    events,
    onError: () => {},
    isHandingOff: () => false,
    isReloading: (sessionId) => reloads.covers(sessionId),
  });
  observer.attach(runtime as never);

  return {
    db,
    inbox,
    messages,
    workspaces,
    sessions,
    workspace,
    reloads,
    alive,
    runtime,
    /** 这条路上只有一格材料要读者知道：内容从库里现读 */
    deps: {
      sessions,
      workspaces,
      runtime: runtime as never,
      materials: (session: Session) => materialsFor(materialDeps, session),
      reloads,
      onError: (error: unknown, what: string) => {
        throw new Error(`重装报了错（${what}）：${String(error)}`);
      },
    },
  };
}

/** 排队区里的那一条（投递那条路先落库的那一份，宿主自己投的条目都带 `messageId`） */
function pending(messageId: string, content: string, createdAt: string) {
  return {
    messageId,
    createdAt,
    priority: "high" as const,
    source: { kind: "user" as const },
    content,
  };
}

/**
 * 一条条目的身份。`AgentNS.InboxEntry` 是「带正文的条目」与「钥匙」的并集，钥匙没有
 * `messageId`（它没有正文，也没有可恢复的东西），所以判据在键上。
 */
function messageIdOf(entry: AgentNS.InboxEntry): string | undefined {
  return "messageId" in entry ? entry.messageId : undefined;
}

describe("重装前后排队区对得上", () => {
  it("两条排着的条目在重装之后：内存里按原顺序还在，库里那两行也还在", async () => {
    const host = newHost();
    const session = host.sessions.create({
      workspaceId: host.workspace.id,
      name: "1712345678000",
      nameIsAuto: true,
      agentId: "agent-1",
      modelId: "model-1",
      autoHandoff: false,
      lineage: null,
    });

    // 库里两条、内存里也两条：真宿主上它们本来就是同一批的两份
    const first = pending("m-1", "第一句还在等", "2026-01-01T00:00:00.000Z");
    const second = pending("m-2", "第二句还在等", "2026-01-01T00:00:01.000Z");
    host.inbox.insert(session.id, first);
    host.inbox.insert(session.id, second);
    // 这段会话正关着输出闸（用户按过中断）：放回队列的条目不会立刻被取走
    const before = fakeAgent([first, second]);
    before.pauseOutput();
    host.alive.set(session.id, before);

    const reloaded = await reloadDefinition(host.deps, "agent-1");

    expect(reloaded).toEqual([session.id]);
    // 内存那一份：还在，顺序没变
    expect(host.alive.get(session.id)?.inboxPending.map(messageIdOf)).toEqual(["m-1", "m-2"]);
    // 库里那一份：条数与 `messageId` 都对得上 —— 这两行正是「关掉再打开还在等」的那一份
    expect(host.inbox.listBySession(session.id).map(messageIdOf)).toEqual(["m-1", "m-2"]);
    // 窗口已经关了
    expect(host.reloads.covers(session.id)).toBe(false);
  });

  it("重装之后真的被杀死：库里那几行照旧作废（杀死就是杀死）", async () => {
    const host = newHost();
    const session = host.sessions.create({
      workspaceId: host.workspace.id,
      name: "1712345678001",
      nameIsAuto: true,
      agentId: "agent-1",
      modelId: "model-1",
      autoHandoff: false,
      lineage: null,
    });

    const only = pending("m-1", "还在等的那一句", "2026-01-01T00:00:00.000Z");
    host.inbox.insert(session.id, only);
    host.alive.set(session.id, fakeAgent([only]));

    // 不进窗口的那一次杀：用户按的是杀死，条目作废、库里也删
    host.runtime.kill(session.id);

    expect(host.alive.has(session.id)).toBe(false);
    expect(host.inbox.listBySession(session.id)).toEqual([]);
  });
});
