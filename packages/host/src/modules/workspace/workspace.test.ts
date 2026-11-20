/**
 * 三条验收：项目行写进去读回来一模一样，且 `cwd` 落库那一刻已经归一化；同一个目录建不出
 * 第二个项目（唯一性真的落在索引上，而不是靠插入之前先查一遍）；删项目把名下的会话一起带走。
 *
 * 第三条超出了「每个对象 0~2 条」的预算，理由是可数的错：外键没级联时没有任何报错，
 * 只在界面上留下几段挂在不存在的项目下的会话，而用户不会知道自己看到了什么。
 */

import { isAbsolute, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { openDatabase } from "../../infra/db.js";
import { HostError } from "../../infra/errors.js";
import { createTranslator } from "../i18n/index.js";
import { sessionTable } from "../session/table.js";
import { WorkspaceService } from "./service.js";
import { workspaceTable } from "./table.js";

function newService(): WorkspaceService {
  const db = openDatabase(":memory:");
  return new WorkspaceService({
    workspaces: workspaceTable(db),
    t: createTranslator(() => "zh"),
  });
}

describe("项目行", () => {
  it("写进去读回来一模一样，cwd 落库时是归一化后的绝对路径", () => {
    const service = newService();
    const created = service.create("1712345678000", "./临时/../项目");

    expect(isAbsolute(created.cwd)).toBe(true);
    expect(created.cwd).toBe(resolve("项目"));
    expect(service.get(created.id)).toEqual(created);
    expect(service.list()).toEqual([created]);

    const renamed = service.rename(created.id, "新的名字");
    expect(renamed).toEqual({ ...created, name: "新的名字" });
    expect(service.get(created.id)).toEqual(renamed);
  });

  it("同一个 cwd 建不出第二个项目，第一个原样还在", () => {
    const service = newService();
    const first = service.create("一", "/tmp/一个项目");

    // 结尾多一个分隔符：归一化之后仍是同一个目录，所以撞的是同一个唯一索引
    expect(() => service.create("二", "/tmp/一个项目/")).toThrow(HostError);
    expect(service.list()).toEqual([first]);
  });

  it("删项目把名下的会话一起带走，别的项目的会话不动", () => {
    const db = openDatabase(":memory:");
    const workspaces = workspaceTable(db);
    const sessions = sessionTable(db);
    workspaces.put({ id: "w-1", name: "一", cwd: "/tmp/w-1", createdAt: 1 });
    workspaces.put({ id: "w-2", name: "二", cwd: "/tmp/w-2", createdAt: 1 });

    const session = (id: string, workspaceId: string) => ({
      id,
      workspaceId,
      name: "1712345678000",
      nameIsAuto: true,
      pinned: false,
      agentId: "agent-1",
      modelId: "model-1",
      thinkingLevel: null,
      autoHandoff: false,
      lineage: null,
      handoffThreshold: null,
      guardThreshold: null,
      pendingHandoff: null,
      createdAt: 1,
      updatedAt: 1,
    });
    sessions.put(session("s-1", "w-1"));
    sessions.put(session("s-2", "w-2"));

    workspaces.delete("w-1");

    expect(sessions.get("s-1")).toBeUndefined();
    expect(sessions.get("s-2")).toBeDefined();
  });
});
