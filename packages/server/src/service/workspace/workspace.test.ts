import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspace, readWorkspace, workspaceIdFor } from "./workspace.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aiz-workspace-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("workspaceIdFor", () => {
  it("目录名可读 + 路径哈希：`<名字>-<8 位 hash>`", () => {
    const id = workspaceIdFor("/home/ubuntu/projects/ai-zen/cli");
    expect(id).toMatch(/^cli-[0-9a-f]{8}$/);
  });

  it("同一目录的不同写法收敛成同一个 id（先 resolve 再算）", () => {
    expect(workspaceIdFor("/home/ubuntu/projects/ai-zen/cli/")).toBe(
      workspaceIdFor("/home/ubuntu/projects/ai-zen/cli"),
    );
    expect(workspaceIdFor("/home/ubuntu/projects/ai-zen/cli/../cli")).toBe(
      workspaceIdFor("/home/ubuntu/projects/ai-zen/cli"),
    );
  });

  it("目录名相同、路径不同 → 靠哈希区分（规范化会丢信息，不能只靠名字）", () => {
    expect(workspaceIdFor("/a/b-c")).not.toBe(workspaceIdFor("/a-b/c"));
    expect(workspaceIdFor("/a/cli")).not.toBe(workspaceIdFor("/b/cli"));
  });

  it("根目录 / 名字非法字符 → 落到可用名字", () => {
    expect(workspaceIdFor("/")).toMatch(/^root-[0-9a-f]{8}$/);
    expect(workspaceIdFor("/tmp/我的 项目")).toMatch(/^-[0-9a-f]{8}$|^[a-z0-9_-]+-[0-9a-f]{8}$/);
  });
});

describe("ensureWorkspace", () => {
  it("建目录并写下 workspace.json（哈希不可逆，得留一份原始路径）", async () => {
    const workspace = await ensureWorkspace({ workspacesRoot: root, path: "/home/ubuntu/proj" });

    expect(workspace.id).toBe(workspaceIdFor("/home/ubuntu/proj"));
    expect(workspace.rootDir).toBe(join(root, workspace.id));

    const record = JSON.parse(readFileSync(join(workspace.rootDir, "workspace.json"), "utf-8"));
    expect(record).toMatchObject({ schema: 1, id: workspace.id, path: "/home/ubuntu/proj" });
  });

  it("已存在就不重写记录（首次认定的路径不该被悄悄改写）", async () => {
    const first = await ensureWorkspace({ workspacesRoot: root, path: "/tmp/proj" });
    const recordPath = join(first.rootDir, "workspace.json");
    writeFileSync(
      recordPath,
      JSON.stringify({ schema: 1, id: first.id, path: "/traced", createdAt: "x" }),
      "utf-8",
    );

    await ensureWorkspace({ workspacesRoot: root, path: "/tmp/proj" });
    expect(JSON.parse(readFileSync(recordPath, "utf-8")).path).toBe("/traced");
  });

  it("路径先规范化再算 id（`/a/b/../c` 与 `/a/c` 是同一个工作区）", async () => {
    const workspace = await ensureWorkspace({ workspacesRoot: root, path: "/a/b/../c" });
    expect(workspace.path).toBe("/a/c");
    expect(workspace.id).toBe(workspaceIdFor("/a/c"));
  });
});

describe("readWorkspace：由 id 反查路径", () => {
  it("读 workspace.json 拿回身份与位置（id 是哈希派生的，光看 id 推不回路径）", async () => {
    const created = await ensureWorkspace({ workspacesRoot: root, path: "/home/ubuntu/proj" });

    expect(await readWorkspace({ workspacesRoot: root, id: created.id })).toEqual(created);
  });

  it("没有这个工作区 → null（不抛：回何种错误是调用方的判断）", async () => {
    expect(await readWorkspace({ workspacesRoot: root, id: "nope-00000000" })).toBeNull();
  });

  it("id 来自客户端参数：带路径分隔符 / `.` / `..` 一律当没有（不许逃出 workspacesRoot）", async () => {
    expect(await readWorkspace({ workspacesRoot: root, id: ".." })).toBeNull();
    expect(await readWorkspace({ workspacesRoot: root, id: "a/b" })).toBeNull();
    expect(await readWorkspace({ workspacesRoot: root, id: "" })).toBeNull();
  });

  it("记录写坏 / 没记 path → null（形状不对一律当作没有，不猜）", async () => {
    const created = await ensureWorkspace({ workspacesRoot: root, path: "/tmp/proj" });
    writeFileSync(
      join(created.rootDir, "workspace.json"),
      JSON.stringify({ schema: 1, id: created.id, path: 42 }),
      "utf-8",
    );

    expect(await readWorkspace({ workspacesRoot: root, id: created.id })).toBeNull();
  });
});
