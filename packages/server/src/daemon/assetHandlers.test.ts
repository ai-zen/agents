/**
 * `asset.list` 的接线测试 —— 只证明**参数形状**这一层：不合法的请求回 `bad-params`、
 * 合法请求原样落到服务层。
 *
 * 为什么不走真 socket：这条方法不推事件、不看连接（与 `session.*` 那些要证明「事件真能过
 * 连接」的方法不同），handler 的契约全在「参数进、结果/错误出」。扫描规则本身由
 * `AssetService.test.ts` 用真目录树测透。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAssetHandlers } from "./assetHandlers.js";
import { ASSET_METHODS } from "../protocol/assets.js";
import { AssetService } from "../service/asset/AssetService.js";
import { ensureWorkspace } from "../service/workspace/workspace.js";
import type { Connection } from "./Daemon.js";

let root: string;
let handlers: ReturnType<typeof createAssetHandlers>;
let workspacePath: string;
let workspaceId: string;

/**
 * 一条「够用」的连接。
 *
 * 形状照抄真件（`Connection`）：`asset.list` 不用它，但把 `undefined` 硬塞进去会让下一个
 * 需要连接的用例撞上同一处 —— 假件按真件写，是这个仓的老规矩。
 */
const connection: Connection = {
  id: 1,
  send: () => {},
  close: () => {},
  onClose: () => () => {},
};

/** 调一次 `asset.list`（handler 是普通函数，直接调就是它在线上的行为） */
const list = (params: unknown) => handlers[ASSET_METHODS.list]!(params, connection);

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "aiz-asset-handlers-"));
  const aiZenDir = join(root, "ai-zen");
  workspacePath = join(root, "proj");
  await fs.mkdir(workspacePath, { recursive: true });
  const skillDir = join(workspacePath, ".ai-zen", "skills", "demo");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    join(skillDir, "SKILL.md"),
    ["---", "name: demo", "description: 演示技能", "---", ""].join("\n"),
    "utf-8",
  );
  const workspacesRoot = join(aiZenDir, "workspaces");
  workspaceId = (await ensureWorkspace({ workspacesRoot, path: workspacePath })).id;
  handlers = createAssetHandlers({
    service: new AssetService({ aiZenDir, homeDir: join(root, "home"), workspacesRoot }),
  });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("asset.list：参数的形状", () => {
  it("正常请求：回一个 assets 数组", async () => {
    const result = (await list({ kind: "skill", workspaceId })) as any;

    expect(result.assets.map((asset: any) => asset.id)).toEqual(["demo"]);
  });

  it("kind 只认 skill | tool：别的原样回 bad-params（不猜成另一类）", async () => {
    await expect(list({})).rejects.toMatchObject({ code: "bad-params" });
    await expect(list({ kind: "skills" })).rejects.toMatchObject({ code: "bad-params" });
  });

  it("scope 只认 global | project", async () => {
    await expect(list({ kind: "skill", scope: "user" })).rejects.toMatchObject({
      code: "bad-params",
    });
  });

  it("scope:project 不给 workspaceId → bad-params（项目级资产挂在工作区路径上）", async () => {
    await expect(list({ kind: "skill", scope: "project" })).rejects.toMatchObject({
      code: "bad-params",
    });
    // 给了就正常
    const result = (await list({ kind: "skill", scope: "project", workspaceId })) as any;
    expect(result.assets).toHaveLength(1);
  });

  it("工作区不存在 → unknown-workspace（与参数错分开：客户端该换 id，不是改形状）", async () => {
    await expect(
      list({ kind: "skill", scope: "project", workspaceId: "nope-00000000" }),
    ).rejects.toMatchObject({ code: "unknown-workspace" });
  });
});
