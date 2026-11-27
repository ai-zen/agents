/**
 * `workspace.create` 不给名字时叫什么。
 *
 * 这一格原先兜底成 `String(Date.now())`，于是每个新项目在 `/ws`、在会话行、在提示语里都叫一长串
 * 数字。现在取目录自己的名字 —— 项目是「哪个目录」，它叫什么最自然的就是目录叫什么。
 *
 * 两条边界也要钉住：给了名字就照用户给的（不让默认值覆盖它）；根目录那种 `basename` 给空串的
 * 地方取整条路径（根目录没有「名字」，只有路径）。
 */

import { describe, expect, it } from "vitest";

import { openDatabase } from "../../infra/db.js";
import { createTranslator } from "../i18n/index.js";
import { WorkspaceService } from "../workspace/service.js";
import { workspaceTable } from "../workspace/table.js";
import type { HostApiDeps } from "./deps.js";
import { createTrpc } from "./trpc.js";
import { workspaceRouter } from "./workspace.js";

function setup() {
  const db = openDatabase(":memory:");
  const t = createTranslator(() => "zh");
  const workspaces = new WorkspaceService({ workspaces: workspaceTable(db), t });

  const deps = { workspaces, t } as unknown as HostApiDeps;
  const api = createTrpc(t);
  const router = api.router({ workspace: workspaceRouter(deps, api) });
  return { caller: router.createCaller({}), workspaces };
}

describe("建项目时的默认名字", () => {
  it("不给名字：用目录自己的名字，不是一串数字", async () => {
    const { caller } = setup();
    const created = await caller.workspace.create({ cwd: "/work/ai-zen/cli" });

    expect(created.workspace.name).toBe("cli");
    expect(created.workspace.cwd).toBe("/work/ai-zen/cli");
  });

  it("给了名字就照用户给的", async () => {
    const { caller } = setup();
    const created = await caller.workspace.create({ cwd: "/work/ai-zen/cli", name: "终端客户端" });

    expect(created.workspace.name).toBe("终端客户端");
  });

  it("根目录没有 basename：取整条路径", async () => {
    const { caller } = setup();
    const created = await caller.workspace.create({ cwd: "/" });

    expect(created.workspace.name).toBe("/");
  });
});
