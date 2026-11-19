/**
 * 会话级模型与思考档位（F-B4 / F-B6 / F-B7）：它们存在会话行上，改完立刻写库、重启还在。
 *
 * 这里跑的是真 `HostApp`（真 SQLite、真组装），只把 agent 那一层换成假工厂 —— 与
 * `app.test.ts` 同一套口径。围绕三件事：
 *   1. `/model` 写库之后重建 `HostApp`，读到的还是新模型；
 *   2. 换模型把思考档位清成 `null`，下一轮装配 agent 时拿到的也是 `null`（旧档位的补丁不会再发出去）；
 *   3. 两段会话各设各的档位，互不影响。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHost } from "./app.js";
import type { HostApp } from "./app.js";
import type { ConnectionInfo } from "./net/index.js";
import { makeTempDir, wait, type TempDir } from "./net/TestSupport.js";
import type { AgentBuildContext } from "./runtime/index.js";
import { FakeAgent } from "./runtime/TestSupport.js";
import type {
  SessionCreateResult,
  SessionView,
  MethodName,
  MethodParams,
  MethodResult,
} from "./wire/index.js";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 两个模型：`test-model` 挂着出厂 `openai` 那张思考策略表，`plain-model` 没有档位 */
const CONFIG = JSON.stringify(
  {
    endpoints: [
      { id: "fake", name: "Fake", baseUrl: "https://example.invalid/v1", apiKey: "sk-fake" },
    ],
    models: [
      {
        id: "test-model",
        name: "Test Model",
        endpointId: "fake",
        tokenThresholds: { handoff: 1000, guard: 2000 },
        vision: true,
        reasoningPreset: "openai",
        custom: true,
      },
      {
        id: "plain-model",
        name: "Plain Model",
        endpointId: "fake",
        tokenThresholds: { handoff: 500, guard: 900 },
        custom: true,
      },
    ],
    defaultModel: "test-model",
  },
  null,
  2,
);

const AGENT = JSON.stringify(
  {
    id: "default",
    name: "Test Assistant",
    modelId: "test-model",
    messages: [{ id: "sys-1", role: "system", status: "completed", content: "测试助手" }],
    custom: true,
  },
  null,
  2,
);

const CONNECTION: ConnectionInfo = {
  id: "test-connection",
  language: "en",
  clientInfo: null,
  credentialId: null,
};

const dataRoots: TempDir[] = [];
const workspaceDirs: TempDir[] = [];
const apps: HostApp[] = [];

async function makeDataRoot(): Promise<TempDir> {
  const base = await makeTempDir("ai-zen-session-model-");
  dataRoots.push(base);
  await fs.mkdir(join(base.path, "agents"), { recursive: true });
  await fs.writeFile(join(base.path, "config.json"), CONFIG, "utf8");
  await fs.writeFile(join(base.path, "agents", "default.json"), AGENT, "utf8");
  return base;
}

async function startApp(
  dataRoot: TempDir,
  createAgent?: (context: AgentBuildContext) => Promise<FakeAgent>,
): Promise<HostApp> {
  const app = await createHost({
    aiZenDir: dataRoot.path,
    port: 0,
    local: true,
    exit: () => undefined,
    logger: { warn: () => undefined, error: () => undefined },
    ...(createAgent === undefined ? {} : { createAgent }),
  });
  await app.start();
  apps.push(app);
  return app;
}

async function callMethod<M extends MethodName>(
  app: HostApp,
  method: M,
  params: MethodParams<M> = {} as MethodParams<M>,
): Promise<MethodResult<M>> {
  const handler = app.handlers[method];
  if (!handler) throw new Error(`方法未注册：${method}`);
  return await handler({ method, params, connection: CONNECTION });
}

/** 建一个项目 + 一段（已落库的）会话 */
async function seedSession(app: HostApp, workspaceId: string): Promise<SessionView> {
  const created = await callMethod(app, "session.create", {
    workspaceId,
    agentId: "default",
  });
  const session = created.session as SessionCreateResult["session"];
  if (!session) throw new Error("session.create 没有建出会话");
  await app.sessionService.ensurePersisted(session.id);
  return session;
}

/** 建一个项目（同一个目录只能登记一次） */
async function seedWorkspace(app: HostApp, cwd: string): Promise<string> {
  const { workspace } = await callMethod(app, "workspace.create", { cwd });
  return workspace.id;
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop("requested").catch(() => undefined);
  for (const dir of workspaceDirs.splice(0)) await dir.remove();
  for (const dir of dataRoots.splice(0)) await dir.remove();
});

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("会话级模型：写库与重启（F-B4）", () => {
  it("`/model` 改完立刻写库，重建 HostApp 之后读到的还是新模型", async () => {
    const dataRoot = await makeDataRoot();
    const workspaceDir = await makeTempDir("ai-zen-session-model-cwd-");
    workspaceDirs.push(workspaceDir);

    const app = await startApp(dataRoot);
    const workspaceId = await seedWorkspace(app, workspaceDir.path);
    const session = await seedSession(app, workspaceId);
    expect(session.model).toMatchObject({ modelId: "test-model", source: "agent" });

    const changed = await callMethod(app, "session.setModel", {
      sessionId: session.id,
      modelId: "plain-model",
    });
    expect(changed.model).toMatchObject({ modelId: "plain-model", source: "session" });
    // 立刻写库（不是内存里的临时值）
    const row = await app.db.get<{ modelId: string }>("SELECT modelId FROM sessions WHERE id = ?", [
      session.id,
    ]);
    expect(row?.modelId).toBe("plain-model");

    // 重启：同一个数据根再起一个服务
    await app.stop("requested");
    const restarted = await startApp(dataRoot);
    const reopened = await callMethod(restarted, "session.get", {
      sessionId: session.id,
    });
    expect(reopened.session.model).toMatchObject({
      modelId: "plain-model",
      source: "session",
    });
    expect(reopened.session.modelId).toBe("plain-model");
  });
});
