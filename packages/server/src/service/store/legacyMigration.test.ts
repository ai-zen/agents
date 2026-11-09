import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacySessions } from "./legacyMigration.js";
import { FileSessionStore } from "./FileSessionStore.js";
import { workspaceIdFor } from "../workspace/workspace.js";

let aiZenDir: string;
let legacySessionsDir: string;
let legacyPointerFile: string;
let workspacesRoot: string;

beforeEach(() => {
  aiZenDir = mkdtempSync(join(tmpdir(), "aiz-migrate-"));
  legacySessionsDir = join(aiZenDir, "cli", "conversations");
  legacyPointerFile = join(aiZenDir, "cli", "last-session.json");
  workspacesRoot = join(aiZenDir, "workspaces");
  mkdirSync(legacySessionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(aiZenDir, { recursive: true, force: true });
});

/** 造一份旧格式会话（带已废弃的 cwd / modelId） */
function writeLegacy(
  id: string,
  cwd: string | undefined,
  extra: Record<string, unknown> = {},
): void {
  const body: Record<string, unknown> = {
    id,
    agentId: "default",
    modelId: "legacy-model",
    messages: [{ role: "user", content: "hello" }],
    ...(cwd ? { cwd } : {}),
    ...extra,
  };
  writeFileSync(join(legacySessionsDir, `${id}.json`), JSON.stringify(body), "utf-8");
}

function storeFor(path: string): FileSessionStore {
  return new FileSessionStore({ rootDir: join(workspacesRoot, workspaceIdFor(path)) });
}

const migrate = () =>
  migrateLegacySessions({ legacySessionsDir, legacyPointerFile, workspacesRoot });

describe("migrateLegacySessions", () => {
  it("按记录里的 cwd 归位到各自的工作区，并洗掉已废弃字段", async () => {
    writeLegacy("chat_a", "/work/proj-a");
    writeLegacy("chat_b", "/work/proj-b");

    const result = await migrate();
    expect(result.moved).toBe(2);
    expect(result.unattributed).toEqual([]);

    const a = await storeFor("/work/proj-a").read("chat_a");
    // `toEqual` 是精确比较：多的 `cwd` / `modelId` 键会让它直接挂，
    // 所以“洗掉已废弃字段”由这一条断言就担住了
    expect(a).toEqual({
      id: "chat_a",
      agentId: "default",
      messages: [{ role: "user", content: "hello" }],
    });

    expect((await storeFor("/work/proj-b").read("chat_b"))?.id).toBe("chat_b");
    // 工作区记录写明原始路径
    const record = JSON.parse(
      readFileSync(join(workspacesRoot, workspaceIdFor("/work/proj-a"), "workspace.json"), "utf-8"),
    );
    expect(record.path).toBe("/work/proj-a");
  });

  it("旧指针按 cwd 拆成各工作区一份单指针", async () => {
    writeLegacy("chat_a", "/work/proj-a");
    writeFileSync(
      legacyPointerFile,
      JSON.stringify({
        version: 1,
        sessions: {
          "/work/proj-a": { id: "chat_a", updatedAt: "2026-01-01T00:00:00.000Z" },
          "/work/没会话": { id: "chat_gone", updatedAt: "2026-01-01T00:00:00.000Z" },
        },
      }),
      "utf-8",
    );

    const result = await migrate();
    expect(result.pointers).toBe(1); // 只认会话确实存在的那条
    expect((await storeFor("/work/proj-a").lastSession())?.id).toBe("chat_a");
    // 会话不存在的目录：指针不写（否则下次续接到空）
    expect(await storeFor("/work/没会话").lastSession()).toBeNull();
    expect(existsSync(legacyPointerFile)).toBe(false);
  });

  it("没有 cwd 的会话原地不动，并报出来（绝不猜、绝不删）", async () => {
    writeLegacy("chat_orphan", undefined);
    const result = await migrate();

    expect(result.moved).toBe(0);
    expect(result.unattributed).toEqual(["chat_orphan"]);
    expect(existsSync(join(legacySessionsDir, "chat_orphan.json"))).toBe(true);
    expect(existsSync(legacySessionsDir)).toBe(true); // 非空，旧目录留着
  });

  it("内容坏掉的会话也原地不动", async () => {
    writeFileSync(join(legacySessionsDir, "chat_broken.json"), '{"id":"chat_broken"', "utf-8");
    const result = await migrate();
    expect(result.unattributed).toEqual(["chat_broken"]);
    expect(existsSync(join(legacySessionsDir, "chat_broken.json"))).toBe(true);
  });

  it("子目录里的会话（`/save 项目/a`）也搬", async () => {
    mkdirSync(join(legacySessionsDir, "项目"), { recursive: true });
    writeFileSync(
      join(legacySessionsDir, "项目", "a.json"),
      JSON.stringify({ id: "项目/a", agentId: "default", messages: [], cwd: "/work/proj-a" }),
      "utf-8",
    );

    const result = await migrate();
    expect(result.moved).toBe(1);
    expect((await storeFor("/work/proj-a").read("项目/a"))?.id).toBe("项目/a");
  });

  it("搬空之后旧目录消失；再跑一次是空操作（幂等）", async () => {
    writeLegacy("chat_a", "/work/proj-a");
    await migrate();
    expect(existsSync(legacySessionsDir)).toBe(false);

    const again = await migrate();
    expect(again).toEqual({ moved: 0, pointers: 0, unattributed: [] });
    // 会话还在，没被"第二次迁移"弄丢
    expect((await storeFor("/work/proj-a").read("chat_a"))?.id).toBe("chat_a");
  });

  it("本来就什么都没有：不报错、不建工作区", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "aiz-migrate-empty-"));
    try {
      const result = await migrateLegacySessions({
        legacySessionsDir: join(fresh, "cli", "conversations"),
        legacyPointerFile: join(fresh, "cli", "last-session.json"),
        workspacesRoot: join(fresh, "workspaces"),
      });
      expect(result).toEqual({ moved: 0, pointers: 0, unattributed: [] });
      expect(existsSync(join(fresh, "workspaces"))).toBe(false);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
