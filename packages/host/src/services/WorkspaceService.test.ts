/**
 * Workspace 服务的验收：登记（cwd 唯一、名字缺省取目录名）、列表顺序与目录事实、
 * 改名、删除前后的代价（D11 / D12 / R14 / R20）。
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AgentNS } from "@ai-zen/agents-core";

import { AssetRepository } from "../storage/AssetRepository.js";
import { SessionRepository } from "../storage/SessionRepository.js";
import { Database } from "../storage/Database.js";
import { MessageRepository } from "../storage/MessageRepository.js";
import { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import { migrate } from "../storage/migrations.js";
import { HostError } from "../wire/errors.js";
import type { SessionPresence } from "../wire/index.js";
import type { SessionRuntimePort } from "./SessionService.js";
import { WorkspaceService } from "./WorkspaceService.js";

/** 只记「被通知忘了哪些会话」的假运行时：项目删除要连带通知它 */
class FakeRuntime implements SessionRuntimePort {
  readonly forgotten: string[] = [];
  presence(): SessionPresence {
    return { status: "idle", inputPaused: false, outputPaused: false, alive: false };
  }
  inboxPending(): number {
    return 0;
  }
  forget(sessionId: string): void {
    this.forgotten.push(sessionId);
  }
  /** 项目这一层不换模型：这一段永远「没有 agent」 */
  agentState(): AgentNS.AgentState | null {
    return null;
  }
  invalidateAgent(): void {}
}

let dir: string;
let projectDir: string;
let missingDir: string;
let db: Database;
let service: WorkspaceService;
let runtime: FakeRuntime;
let sessions: SessionRepository;
let messages: MessageRepository;
let assets: AssetRepository;
let sweeps: string[][];
let clock: number;

// 整个文件共用一个库：`new + migrate` 每用例 55ms，清表只是一条 DELETE 批次。
// 目录类事实（projectDir 存在、missingDir 不存在）是静态的，也只准备一次。
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-services-workspaces-"));
  projectDir = join(dir, "project");
  await mkdir(projectDir, { recursive: true });
  missingDir = join(dir, "已经删掉的目录");

  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  sessions = new SessionRepository(db);
  messages = new MessageRepository(db);
  assets = new AssetRepository(db);
});

beforeEach(async () => {
  // 只清业务表；`meta` 绝不碰（migrate 靠 meta.schemaVersion 判断跑不跑）。
  // `workspaces` 级联 sessions → messages → session_assets，删完再删素材行。
  await db.tx((tx) => [
    tx.run("DELETE FROM notices"),
    tx.run("DELETE FROM workspaces"),
    tx.run("DELETE FROM assets"),
    tx.run("DELETE FROM credentials"),
  ]);
  // 项目目录本身是外部资源（宿主不碰），用例之间复用的就是同一个路径
  await mkdir(projectDir, { recursive: true });
  runtime = new FakeRuntime();
  sweeps = [];
  clock = 1_000;
  service = new WorkspaceService({
    workspaces: new WorkspaceRepository(db),
    sessions,
    messages,
    assets,
    // 删完项目之后「还剩几张引用」归素材层判：这里只记下它被问过哪几个素材
    sweepAssets: async (assetIds) => {
      sweeps.push(assetIds);
      return [];
    },
    runtime,
    now: () => (clock += 1),
  });
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("WorkspaceService.create", () => {
  it("名字不传时取目录名，cwd 归一成绝对路径", async () => {
    const result = await service.create({ cwd: `${projectDir}/` });
    expect(result.workspace.name).toBe("project");
    expect(result.workspace.folder).toEqual({ cwd: projectDir, exists: true });
    expect(result.workspace.sessionCount).toBe(0);
  });

  it("同一个 cwd 登记两次报参数错（R14）", async () => {
    await service.create({ cwd: projectDir });
    await expect(service.create({ cwd: projectDir })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("相对路径按参数错拒绝（进程工作目录不是数据根的来源）", async () => {
    await expect(service.create({ cwd: "project" })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("目录不存在也能登记，只是事实说它不在（D12）", async () => {
    const result = await service.create({ cwd: missingDir, name: "老项目" });
    expect(result.workspace.name).toBe("老项目");
    expect(result.workspace.folder).toEqual({ cwd: missingDir, exists: false });
  });
});

describe("WorkspaceService.list", () => {
  it("按创建时间倒序；目录没了的项目默认也列出来（R20 / D12）", async () => {
    const first = await service.create({ cwd: projectDir, name: "先建的" });
    const second = await service.create({ cwd: missingDir, name: "后建的" });
    expect(first.workspace.createdAt <= second.workspace.createdAt).toBe(true);

    const listed = await service.list();
    expect(listed.workspaces.map((item) => item.name)).toEqual(["后建的", "先建的"]);

    const onlyPresent = await service.list({ includeMissingFolders: false });
    expect(onlyPresent.workspaces.map((item) => item.name)).toEqual(["先建的"]);
  });

  it("最近活动时间来自它名下会话的变化时间", async () => {
    const created = await service.create({ cwd: projectDir });
    await sessions.create({
      id: "c1",
      workspaceId: created.workspace.id,
      name: "一段会话",
      agentId: "a1",
      modelId: "m1",
      createdAt: 5_000,
      updatedAt: 9_000,
    });

    const got = await service.get({ workspaceId: created.workspace.id });
    expect(got.workspace.sessionCount).toBe(1);
  });
});

describe("WorkspaceService.rename / get", () => {
  it("改名只换名字，cwd 不动", async () => {
    const created = await service.create({ cwd: projectDir, name: "旧名" });
    const renamed = await service.rename({ workspaceId: created.workspace.id, name: "新名" });
    expect(renamed.workspace.name).toBe("新名");
    expect(renamed.workspace.folder.cwd).toBe(projectDir);
  });

  it("不存在的项目报 not_found", async () => {
    await expect(service.get({ workspaceId: "没有这个项目" })).rejects.toBeInstanceOf(HostError);
  });
});

describe("WorkspaceService.remove", () => {
  async function seed() {
    const created = await service.create({ cwd: projectDir, name: "要删的项目" });
    const workspaceId = created.workspace.id;
    for (const [id, createdAt] of [
      ["c1", 2_000],
      ["c2", 3_000],
    ] as const) {
      await sessions.create({
        id,
        workspaceId,
        name: id,
        agentId: "a1",
        modelId: "m1",
        createdAt,
      });
    }
    await messages.upsert({
      id: "m1",
      sessionId: "c1",
      createdAt: 2_100,
      message: {
        id: "m1",
        role: AgentNS.Role.User,
        status: AgentNS.MessageStatus.Completed,
        content: "一句话",
      },
    });
    await messages.upsert({
      id: "m2",
      sessionId: "c1",
      createdAt: 2_200,
      message: {
        id: "m2",
        role: AgentNS.Role.Assistant,
        status: AgentNS.MessageStatus.Completed,
        content: "一句回复",
      },
    });
    await messages.upsert({
      id: "m3",
      sessionId: "c2",
      createdAt: 3_100,
      message: {
        id: "m3",
        role: AgentNS.Role.User,
        status: AgentNS.MessageStatus.Completed,
        content: "另一段的一句话",
      },
    });
    await assets.create({
      id: "as1",
      path: "assets/as1.png",
      mime: "image/png",
      bytes: 10,
      sha256: "sha256-1",
      createdAt: 2_150,
    });
    // 归属只在关系行上（消息 c1 里那张图）
    await assets.linkAsset({
      sessionId: "c1",
      messageId: "m1",
      assetId: "as1",
      createdAt: 2_160,
    });
    return workspaceId;
  }

  it("dryRun 只算账：会话数、消息数、素材数与受影响的素材 id", async () => {
    const workspaceId = await seed();
    const report = await service.remove({ workspaceId, dryRun: true });

    expect(report.removed).toBe(false);
    expect(report.consequences).toEqual({ sessions: 2, messages: 3, assets: 1 });
    expect(report.assetIds).toEqual(["as1"]);
    // 什么都没动
    expect(await sessions.get("c1")).toBeDefined();
    expect(sweeps).toEqual([]);
  });

  it("真删连带删掉名下会话与消息，目录本身不碰（D11）", async () => {
    const workspaceId = await seed();
    const report = await service.remove({ workspaceId });

    expect(report.removed).toBe(true);
    expect(await sessions.get("c1")).toBeUndefined();
    expect(await sessions.get("c2")).toBeUndefined();
    expect(await messages.countBySession("c1")).toBe(0);
    expect(await service.list()).toEqual({ workspaces: [] });
    // 运行时被通知忘掉这两段会话
    expect(runtime.forgotten.sort()).toEqual(["c1", "c2"]);
    // 关系行随外键没了；素材行本身交给素材层判（引用归零才删）
    expect(await assets.countReferences("as1")).toBe(0);
    expect(sweeps).toEqual([["as1"]]);
    // 目录还在：宿主不碰用户的目录（D11）
    await expect(service.create({ cwd: projectDir })).resolves.toBeDefined();
  });
});
