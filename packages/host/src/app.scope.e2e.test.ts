/**
 * `runtime.scope.reload` 这一条在真宿主里跑一趟：叫醒一段会话（Scope 随之造出来）、往项目里多写一份
 * skill、改一处配置，然后调这一条，看回执里的份数对不对，以及容器是不是真的重读了一次磁盘。
 *
 * 为什么要在真宿主里验：这条 procedure 的价值全在「真的动手刷了一遍」上 —— 只看它的形状，一个
 * 什么都不做的实现同样能回一份漂亮的 `{ total: 1, refreshed: 1, failed: [] }`。
 *
 * 第二条说的是「一份都刷不动」：往容器上换一个会抛的 `refresh`（容器本身是真的，只有那一格被换
 * 掉），回执必须把那一份报进 `failed` 并说清是哪个目录、为什么 —— 而不是静默成功。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentDefinition } from "@ai-zen/agents-sdk";
import { startFakeLlm, type FakeLlm } from "@ai-zen/fake-llm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { HostApp } from "./app.js";
import { openDatabase } from "./infra/db.js";
import { workspaceTable } from "./modules/workspace/table.js";

/** 假端点回的这句话：这条用例只借它把 Agent 叫醒，内容一个字都不判 */
const REPLY = "收到。";

/** 后写进项目的那份 skill：它的目录名就是容器里认的名字 */
const LATE_SKILL = "late-skill";

/** `runtime.scope.reload` 的回执（形状与宿主那条 procedure 的出参一致） */
interface RefreshReport {
  readonly total: number;
  readonly refreshed: number;
  readonly failed: readonly { readonly cwd: string; readonly reason: string }[];
}

/** tRPC over WebSocket 的一帧。协议只有这么几格，`@trpc/client` 不在依赖里 */
interface Envelope {
  readonly id: number | null;
  readonly result?: { readonly type?: string; readonly data?: unknown };
  readonly error?: { readonly message?: string };
}

/** 只做 query / mutation 的连接：这条用例每一步都是「调一次、拿一次答复」 */
class HostClient {
  private id = 0;
  private readonly waiting = new Map<number, (message: Envelope) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Envelope;
      if (message.id === null) return;
      this.waiting.get(message.id)?.(message);
    });
  }

  static connect(port: number, token: string): Promise<HostClient> {
    // 带 `connectionParams=1` 时服务端才等握手帧再建上下文：凭证只在那一帧上
    const socket = new WebSocket(`ws://127.0.0.1:${port}?connectionParams=1`);
    return new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            id: null,
            jsonrpc: "2.0",
            method: "connectionParams",
            data: { token },
          }),
        );
        resolve(new HostClient(socket));
      });
    });
  }

  query<T>(path: string, input: unknown): Promise<T> {
    return this.call<T>("query", path, input);
  }

  mutation<T>(path: string, input: unknown): Promise<T> {
    return this.call<T>("mutation", path, input);
  }

  close(): void {
    this.socket.close();
  }

  private call<T>(method: "query" | "mutation", path: string, input: unknown): Promise<T> {
    this.id += 1;
    const id = this.id;
    const answered = new Promise<Envelope>((resolve) => this.waiting.set(id, resolve));
    this.socket.send(JSON.stringify({ id, jsonrpc: "2.0", method, params: { path, input } }));

    return answered.then((message) => {
      this.waiting.delete(id);
      if (message.error !== undefined) throw new Error(message.error.message ?? "调用被拒");
      return message.result?.data as T;
    });
  }
}

/**
 * 往项目里放一份 skill：`<cwd>/.ai-zen/skills/<id>/SKILL.md`。
 *
 * 容器刷新时要重读的就是这个目录 —— 写在调用之前、容器知道之后，于是「刷新有没有真的动手」在
 * 能力那一侧留得下证据。
 */
function writeSkill(cwd: string, id: string): void {
  const dir = join(cwd, ".ai-zen", "skills", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: 后写进来的一份\n---\n\n正文。\n`,
    "utf8",
  );
}

/**
 * 问一个容器「现在能拿出哪些 skill」。
 *
 * 权限给的是四维全放行：这里问的是容器看见什么，不是「谁能用」（那要按一段会话的 AgentDefinition 算）。
 */
async function skillsOf(scope: { filter: (definition: AgentDefinition) => { skills: string[] } }) {
  const definition = {
    id: "probe",
    name: "probe",
    messages: [],
    permissions: {
      tools: { allow: ["*"] },
      skills: { allow: ["*"] },
      mcps: { allow: ["*"] },
      subagents: { allow: ["*"] },
    },
  } as unknown as AgentDefinition;
  return scope.filter(definition).skills;
}

describe("Scope的刷新", () => {
  const workspaceId = randomUUID();
  let dataRoot: string;
  let previousHome: string | undefined;
  let cwd: string;
  let llm: FakeLlm;
  let app: HostApp;
  let client: HostClient;

  beforeAll(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "ai-zen-scope-"));
    cwd = join(dataRoot, "project");
    mkdirSync(cwd, { recursive: true });
    llm = await startFakeLlm({ reply: REPLY });

    writeFileSync(
      join(dataRoot, "config.json"),
      JSON.stringify(
        {
          endpoints: [{ id: "local", name: "Local", baseUrl: llm.baseUrl, apiKey: "local-key" }],
          models: [
            {
              id: "local-model",
              name: "Local",
              endpointId: "local",
              modelName: "local-model",
              tokenThresholds: { handoff: 250_000, guard: 375_000 },
              custom: true,
            },
          ],
          defaultModel: "local-model",
          language: "zh",
        },
        null,
        2,
      ),
    );

    mkdirSync(join(dataRoot, "agents"), { recursive: true });
    writeFileSync(
      join(dataRoot, "agents", "default.json"),
      JSON.stringify({
        id: "default",
        name: "Default Assistant",
        modelId: "local-model",
        messages: [],
        permissions: {
          tools: { allow: ["*"] },
          skills: { allow: ["*"] },
          mcps: { allow: ["*"] },
          subagents: { allow: ["*"] },
        },
        custom: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    // 项目行直接写进表：这条用例要看的是容器刷没刷，从 procedure 建项目只会多绕一层
    const db = openDatabase(join(dataRoot, "ai-zen.db"));
    workspaceTable(db).put({ id: workspaceId, name: "用例项目", cwd, createdAt: Date.now() });
    db.close();

    process.env.AI_ZEN_DIR = dataRoot;
    previousHome = process.env.HOME;
    process.env.HOME = join(dataRoot, "home");

    app = await HostApp.open({ port: 0, exit: () => undefined });
    await app.start();
    const token = readFileSync(join(dataRoot, "run", "token"), "utf8").trim();
    client = await HostClient.connect(app.address.port, token);
  }, 60_000);

  afterAll(async () => {
    client?.close();
    await app?.stop();
    await llm?.close();
    delete process.env.AI_ZEN_DIR;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dataRoot, { recursive: true, force: true });
  }, 60_000);

  it("叫醒一段会话之后容器就有一份；改配置再刷新，份数对得上、容器真的重读了磁盘", async () => {
    // 建一段会话并把 Agent 叫起来：容器按目录造，造出来这一份就是后面要刷的那一份。
    // 建行与起来 Agent 是两条口，投话是第三条
    const created = await client.mutation<{ session: { id: string } }>("session.create", {
      workspaceId,
      agentId: "default",
    });
    const sessionId = created.session.id;
    await client.mutation("runtime.agent.wake", { sessionId });
    await client.mutation("runtime.agent.send", {
      workspaceId,
      agentId: "default",
      sessionId,
      content: "先在这儿说一句话。",
      messageId: randomUUID(),
    });
    await vi.waitFor(
      async () => {
        const view = await client.query<{ messages: unknown[] }>("session.open", { sessionId });
        expect(view.messages.length).toBeGreaterThan(1);
      },
      { timeout: 20_000, interval: 20 },
    );

    // 刷新之前容器里没有那份 skill（此刻项目里也还没有它）
    expect(await skillsOf(await app.runtime.scopes.for(cwd))).not.toContain(LATE_SKILL);

    // 两件事都做在调用之前：一份配置改动，加上项目里多出来的一份 skill。后者只能靠重读磁盘看见
    await client.mutation("config.update", { maxToolOutput: 12_345 });
    writeSkill(cwd, LATE_SKILL);

    const report = await client.mutation<RefreshReport>("runtime.scope.reload", {});

    // 这个项目上一份容器，而它刷成了：数字不是编的
    expect(report.total).toBe(1);
    expect(report.refreshed).toBe(1);
    expect(report.failed).toEqual([]);
    // 真的重读过：刚写进项目的那份 skill 现在在容器的候选里
    expect(await skillsOf(await app.runtime.scopes.for(cwd))).toContain(LATE_SKILL);
  }, 60_000);

  it("一份都刷不动：回执把那一份报进 failed，说清是哪个目录、为什么", async () => {
    const scope = await app.runtime.scopes.for(cwd);
    // 注入一个会抛的刷新：容器本身是真的（它就在宿主手上那一份里），只有这一格被换掉
    const original = scope.refresh;
    scope.refresh = async () => {
      throw new Error("用例注入：这一份刷不动");
    };

    try {
      const report = await client.mutation<RefreshReport>("runtime.scope.reload", {});

      expect(report.total).toBe(1);
      expect(report.refreshed).toBe(0);
      expect(report.failed).toEqual([{ cwd, reason: "用例注入：这一份刷不动" }]);
    } finally {
      scope.refresh = original;
    }
  }, 60_000);
});
