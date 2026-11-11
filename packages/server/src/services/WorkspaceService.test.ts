/**
 * Workspace 服务的验收：登记（cwd 唯一、名字缺省取目录名）、列表顺序与目录事实、
 * 改名、删除前后的代价（D11 / D12 / R14 / R20）。
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AssetRepository } from "../storage/AssetRepository.js";
import { ConversationRepository } from "../storage/ConversationRepository.js";
import { Database } from "../storage/Database.js";
import { MessageRepository } from "../storage/MessageRepository.js";
import { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import { migrate } from "../storage/migrations.js";
import { ServerError } from "../wire/errors.js";
import type { ConversationRuntimePort } from "./ConversationService.js";
import { WorkspaceService } from "./WorkspaceService.js";

/** 只记「被通知忘了哪些对话」的假运行时：项目删除要连带通知它 */
class FakeRuntime implements ConversationRuntimePort {
  readonly forgotten: string[] = [];
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
  forget(conversationId: string): void {
    this.forgotten.push(conversationId);
  }
}

let dir: string;
let projectDir: string;
let missingDir: string;
let db: Database;
let service: WorkspaceService;
let runtime: FakeRuntime;
let conversations: ConversationRepository;
let messages: MessageRepository;
let assets: AssetRepository;
let clock: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-services-workspaces-"));
  projectDir = join(dir, "project");
  await mkdir(projectDir, { recursive: true });
  missingDir = join(dir, "已经删掉的目录");

  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  conversations = new ConversationRepository(db);
  messages = new MessageRepository(db);
  assets = new AssetRepository(db);
  runtime = new FakeRuntime();
  clock = 1_000;
  service = new WorkspaceService({
    workspaces: new WorkspaceRepository(db),
    conversations,
    messages,
    assets,
    runtime,
    now: () => (clock += 1),
  });
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("WorkspaceService.create", () => {
  it("名字不传时取目录名，cwd 归一成绝对路径", async () => {
    const result = await service.create({ cwd: `${projectDir}/` });
    expect(result.workspace.name).toBe("project");
    expect(result.workspace.folder).toEqual({ cwd: projectDir, exists: true });
    expect(result.workspace.conversationCount).toBe(0);
    expect(result.workspace.lastActivityAt).toBeNull();
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

  it("最近活动时间来自它名下对话的变化时间", async () => {
    const created = await service.create({ cwd: projectDir });
    await conversations.create({
      id: "c1",
      workspaceId: created.workspace.id,
      name: "一段对话",
      agentId: "a1",
      modelId: "m1",
      createdAt: 5_000,
      updatedAt: 9_000,
    });

    const got = await service.get({ workspaceId: created.workspace.id });
    expect(got.workspace.conversationCount).toBe(1);
    expect(got.workspace.lastActivityAt).toBe(new Date(9_000).toISOString());
    expect(got.workspace.updatedAt).toBe(new Date(9_000).toISOString());
  });
});

describe("WorkspaceService.rename / get", () => {
  it("改名只换名字，cwd 不动", async () => {
    const created = await service.create({ cwd: projectDir, name: "旧名" });
    const renamed = await service.rename({ workspaceId: created.workspace.id, name: "新名" });
    expect(renamed.workspace.name).toBe("新名");
    expect(renamed.workspace.folder.cwd).toBe(projectDir);
  });

  it("名字为空串报参数错", async () => {
    const created = await service.create({ cwd: projectDir });
    await expect(
      service.rename({ workspaceId: created.workspace.id, name: "   " }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("不存在的项目报 not_found", async () => {
    await expect(service.get({ workspaceId: "没有这个项目" })).rejects.toBeInstanceOf(ServerError);
  });
});

describe("WorkspaceService.remove", () => {
  async function seed() {
    const created = await service.create({ cwd: projectDir, name: "要删的项目" });
    const workspaceId = created.workspace.id;
    for (const [id, createdAt] of [["c1", 2_000], ["c2", 3_000]] as const) {
      await conversations.create({
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
      conversationId: "c1",
      role: "user",
      status: "completed",
      content: "一句话",
      createdAt: 2_100,
    });
    await messages.upsert({
      id: "m2",
      conversationId: "c1",
      role: "assistant",
      status: "completed",
      content: "一句回复",
      createdAt: 2_200,
    });
    await messages.upsert({
      id: "m3",
      conversationId: "c2",
      role: "user",
      status: "completed",
      content: "另一段的一句话",
      createdAt: 3_100,
    });
    await assets.create({
      id: "as1",
      conversationId: "c1",
      path: "assets/as1.png",
      mime: "image/png",
      bytes: 10,
      createdAt: 2_150,
    });
    return workspaceId;
  }

  it("dryRun 只算账：对话数、消息数、素材数与要清的文件清单", async () => {
    const workspaceId = await seed();
    const report = await service.remove({ workspaceId, dryRun: true });

    expect(report.removed).toBe(false);
    expect(report.consequences).toEqual({ conversations: 2, messages: 3, assets: 1 });
    expect(report.assetPaths).toEqual(["assets/as1.png"]);
    // 什么都没动
    expect(await conversations.get("c1")).toBeDefined();
  });

  it("真删连带删掉名下对话与消息，目录本身不碰（D11）", async () => {
    const workspaceId = await seed();
    const report = await service.remove({ workspaceId });

    expect(report.removed).toBe(true);
    expect(await conversations.get("c1")).toBeUndefined();
    expect(await conversations.get("c2")).toBeUndefined();
    expect(await messages.countByConversation("c1")).toBe(0);
    expect(await service.list()).toEqual({ workspaces: [] });
    // 运行时被通知忘掉这两段对话
    expect(runtime.forgotten.sort()).toEqual(["c1", "c2"]);
    // 目录还在：服务端不碰用户的目录（D11）
    await expect(service.create({ cwd: projectDir })).resolves.toBeDefined();
  });
});
