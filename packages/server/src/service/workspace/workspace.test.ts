import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureWorkspace,
  listWorkspaces,
  readWorkspace,
  relocateWorkspace,
  removeWorkspace,
  renameWorkspace,
  requireWorkspacePath,
  workspaceIdFor,
} from "./workspace.js";

/** 工作区根目录（`<aiZenDir>/workspaces`） */
let root: string;
/** 用户的项目目录都建在这里（与 `root` 分开：一个是记录，一个是被记录指向的目录） */
let paths: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aiz-workspace-"));
  paths = mkdtempSync(join(tmpdir(), "aiz-workspace-paths-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(paths, { recursive: true, force: true });
});

/** 造一个真实的项目目录（工作区路径必须存在：本包从不替用户 `mkdir`） */
function projectDir(name: string): string {
  const path = join(paths, name);
  mkdirSync(path, { recursive: true });
  return path;
}

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

/**
 * id 冻结：`workspaceIdFor(路径)` 只是**首次分配时的候选**。
 *
 * 这一组的每一条都在钉同一个病：目录被 `mv` 之后，历史（`<id>/sessions/`）不能失联。
 */
describe("id 冻结：路径变了，id 不变", () => {
  it("老记录（只有 path、没有 title）原样可用，且**不**为补 title 而写盘", async () => {
    const old = projectDir("proj");
    const workspace = await ensureWorkspace({ workspacesRoot: root, path: old });
    // 老版本的记录就长这样：没有 title
    const recordPath = join(workspace.rootDir, "workspace.json");
    const legacy = JSON.stringify({ schema: 1, id: workspace.id, path: old, createdAt: "x" });
    writeFileSync(recordPath, legacy, "utf-8");

    // 读：title 缺席 = 「还没起过名」，不是「读坏了」
    expect(await readWorkspace({ workspacesRoot: root, id: workspace.id })).toEqual(workspace);
    expect(workspace).not.toHaveProperty("title");
    // 再认一次：直接命中快路径，记录一个字都没动
    expect((await ensureWorkspace({ workspacesRoot: root, path: old })).id).toBe(workspace.id);
    expect(readFileSync(recordPath, "utf-8")).toBe(legacy);
  });

  it("目录改名 → relocate → 对新路径 resolve 拿到**同一个 id**（走慢路径）", async () => {
    const before = projectDir("proj");
    const created = await ensureWorkspace({ workspacesRoot: root, path: before });

    // 用户 `mv ~/proj ~/proj2`
    const after = join(paths, "proj-renamed");
    renameSync(before, after);

    // 客户端拿旧 id 把记录指到新路径（这是设计的恢复流程）
    const relocated = await relocateWorkspace({
      workspacesRoot: root,
      id: created.id,
      path: after,
    });
    expect(relocated).toEqual({ workspaceId: created.id, path: after });

    // 之后再怎么 resolve 都是同一个 id —— 这才是「历史找得回来」
    expect((await ensureWorkspace({ workspacesRoot: root, path: after })).id).toBe(created.id);
    // 写法不同也一样（规范化之后才比）
    expect((await ensureWorkspace({ workspacesRoot: root, path: `${after}/` })).id).toBe(
      created.id,
    );
    expect(
      (await ensureWorkspace({ workspacesRoot: root, path: `${after}/../proj-renamed` })).id,
    ).toBe(created.id);
  });

  it("顺序很重要：先对**新路径** resolve 会占住它，relocate 就回 workspace-exists", async () => {
    // 这条不是理想体验，写在这里是为了把顺序说清楚：两条记录不能指同一个目录
    // （`workspace-exists`），所以客户端看见 `pathExists:false` 时该先引导用户修
    // （relocate），而不是自己去新路径新开一个工作区。
    const before = projectDir("proj");
    const created = await ensureWorkspace({ workspacesRoot: root, path: before });
    const after = join(paths, "proj-renamed");
    renameSync(before, after);

    const squatter = await ensureWorkspace({ workspacesRoot: root, path: after });
    expect(squatter.id).not.toBe(created.id);
    await expect(
      relocateWorkspace({ workspacesRoot: root, id: created.id, path: after }),
    ).rejects.toMatchObject({ code: "workspace-exists" });

    // 删掉那个空壳工作区，再 relocate 就能接回历史
    await removeWorkspace({ workspacesRoot: root, id: squatter.id });
    expect(await relocateWorkspace({ workspacesRoot: root, id: created.id, path: after })).toEqual({
      workspaceId: created.id,
      path: after,
    });
  });

  it("派生 id 被老记录占着时新建换一个 id：绝不顶掉那份记录", async () => {
    const first = projectDir("proj");
    const created = await ensureWorkspace({ workspacesRoot: root, path: first });

    // 记录被搬到别处，`workspaceIdFor(原路径)` 这个值仍然归它（id 冻结）
    const moved = projectDir("proj-elsewhere");
    await relocateWorkspace({ workspacesRoot: root, id: created.id, path: moved });

    // 用户又在原路径建了个同名目录
    const again = await ensureWorkspace({ workspacesRoot: root, path: first });
    expect(again.id).not.toBe(created.id);
    expect(again.id).toBe(`${created.id}-2`);
    // 老记录与它的路径一个都没被动过（否则历史就被接到另一个目录上了）
    expect(await readWorkspace({ workspacesRoot: root, id: created.id })).toMatchObject({
      path: moved,
    });
  });

  it("同一个路径反复 resolve 永远同一个 id（老行为不变）", async () => {
    const path = projectDir("stable");
    const ids = [
      (await ensureWorkspace({ workspacesRoot: root, path })).id,
      (await ensureWorkspace({ workspacesRoot: root, path })).id,
      (await ensureWorkspace({ workspacesRoot: root, path: `${path}/./` })).id,
    ];
    expect(new Set(ids).size).toBe(1);
  });
});

describe("listWorkspaces：目录被挪走之后要看得见", () => {
  it("pathExists 跟着目录生死变；目录被删了记录仍在（历史不跟着失踪）", async () => {
    const alive = projectDir("alive");
    const doomed = projectDir("doomed");
    const kept = await ensureWorkspace({ workspacesRoot: root, path: alive });
    const lost = await ensureWorkspace({ workspacesRoot: root, path: doomed });

    rmSync(doomed, { recursive: true });

    const listed = await listWorkspaces({ workspacesRoot: root });
    expect(listed).toEqual([
      expect.objectContaining({ workspaceId: kept.id, path: alive, pathExists: true }),
      expect.objectContaining({ workspaceId: lost.id, path: doomed, pathExists: false }),
    ]);
    // 记录本身没被删：用户还能 rename / relocate / remove 它
    expect(await readWorkspace({ workspacesRoot: root, id: lost.id })).not.toBeNull();
  });

  it("顺序确定：显示名码位序，同名再按 id（两次调用一致，与目录创建顺序无关）", async () => {
    const zeta = await ensureWorkspace({ workspacesRoot: root, path: projectDir("zeta") });
    const alphaA = await ensureWorkspace({
      workspacesRoot: root,
      path: join(projectDir("nested-a"), "alpha"),
    });
    const alphaB = await ensureWorkspace({
      workspacesRoot: root,
      path: join(projectDir("nested-b"), "alpha"),
    });

    const first = await listWorkspaces({ workspacesRoot: root });
    const second = await listWorkspaces({ workspacesRoot: root });
    expect(second).toEqual(first);
    // `alpha` 两条同名 → 按 id 定序，全序不会抖
    const expected = [alphaA, alphaB].map((item) => item.id).sort();
    expect(first.map((item) => item.path)).toEqual([
      ...expected.map((id) => (id === alphaA.id ? alphaA.path : alphaB.path)),
      zeta.path,
    ]);
  });

  it("还没建过任何工作区 → 空表（不是错误）", async () => {
    expect(await listWorkspaces({ workspacesRoot: join(root, "nope") })).toEqual([]);
  });
});

describe("renameWorkspace：只改名字", () => {
  it("只改 title，id 与 path 一个字都不动", async () => {
    const path = projectDir("proj");
    const created = await ensureWorkspace({ workspacesRoot: root, path });
    const record = JSON.parse(readFileSync(join(created.rootDir, "workspace.json"), "utf-8"));

    expect(
      await renameWorkspace({ workspacesRoot: root, id: created.id, title: "  我的项目  " }),
    ).toEqual({
      workspaceId: created.id,
      title: "我的项目",
    });

    const renamed = await readWorkspace({ workspacesRoot: root, id: created.id });
    expect(renamed).toEqual({ ...created, title: "我的项目" });
    // 记录里其余字段保持原样（createdAt 没被刷新成"刚刚"）
    const after = JSON.parse(readFileSync(join(created.rootDir, "workspace.json"), "utf-8"));
    expect(after).toEqual({ ...record, title: "我的项目" });
  });

  it("空标题 → bad-params（「没名字」是 title 缺席，不是空串）", async () => {
    const created = await ensureWorkspace({
      workspacesRoot: root,
      path: projectDir("proj"),
    });
    await expect(
      renameWorkspace({ workspacesRoot: root, id: created.id, title: "   " }),
    ).rejects.toMatchObject({ code: "bad-params" });
  });

  it("未知工作区 → unknown-workspace", async () => {
    await expect(
      renameWorkspace({ workspacesRoot: root, id: "nope-00000000", title: "x" }),
    ).rejects.toMatchObject({ code: "unknown-workspace" });
  });
});

describe("removeWorkspace：连会话一起删", () => {
  it("整个目录（含 sessions/ 与指针）被删；再删一次 removed:false", async () => {
    const created = await ensureWorkspace({ workspacesRoot: root, path: projectDir("proj") });
    mkdirSync(join(created.rootDir, "sessions"), { recursive: true });
    writeFileSync(join(created.rootDir, "sessions", "chat_1.json"), "{}");
    writeFileSync(join(created.rootDir, "last-session.json"), "{}");

    expect(await removeWorkspace({ workspacesRoot: root, id: created.id })).toEqual({
      removed: true,
    });
    expect(readdirSync(root)).toEqual([]);
    expect(await readWorkspace({ workspacesRoot: root, id: created.id })).toBeNull();

    // 幂等：本来就不在
    expect(await removeWorkspace({ workspacesRoot: root, id: created.id })).toEqual({
      removed: false,
    });
  });

  it("id 带分隔符 / `..` → 不动盘外的东西，回 removed:false", async () => {
    const outside = projectDir("outside");
    writeFileSync(join(outside, "keep.txt"), "keep");
    // root 与 paths 是兄弟目录：`../..` 这类写法必须被挡住
    expect(await removeWorkspace({ workspacesRoot: root, id: ".." })).toEqual({ removed: false });
    expect(await removeWorkspace({ workspacesRoot: root, id: `../${"x"}` })).toEqual({
      removed: false,
    });
    expect(readdirSync(outside)).toEqual(["keep.txt"]);
  });
});

describe("relocateWorkspace：目录搬家的唯一入口", () => {
  it("新路径不存在 → workspace-path-missing，且**没有**被创建", async () => {
    const created = await ensureWorkspace({ workspacesRoot: root, path: projectDir("proj") });
    const missing = join(paths, "not-there");

    await expect(
      relocateWorkspace({ workspacesRoot: root, id: created.id, path: missing }),
    ).rejects.toMatchObject({ code: "workspace-path-missing" });
    expect(() => readdirSync(missing)).toThrow(); // 服务端不替用户 mkdir
    // 记录原样未动
    expect(await readWorkspace({ workspacesRoot: root, id: created.id })).toMatchObject({
      path: join(paths, "proj"),
    });
  });

  it("目标路径已被另一个工作区占着 → workspace-exists（两份记录不能指同一个目录）", async () => {
    const taken = projectDir("taken");
    await ensureWorkspace({ workspacesRoot: root, path: taken });
    const created = await ensureWorkspace({ workspacesRoot: root, path: projectDir("proj") });

    await expect(
      relocateWorkspace({ workspacesRoot: root, id: created.id, path: taken }),
    ).rejects.toMatchObject({ code: "workspace-exists" });
    expect(await readWorkspace({ workspacesRoot: root, id: created.id })).toMatchObject({
      path: join(paths, "proj"),
    });
  });

  it("成功之后 id 不变、记录里的 path 更新（原子写，不留 .tmp）", async () => {
    const before = projectDir("proj");
    const created = await ensureWorkspace({ workspacesRoot: root, path: before });
    await renameWorkspace({ workspacesRoot: root, id: created.id, title: "手头的项目" });
    const after = join(paths, "moved");
    renameSync(before, after);

    expect(await relocateWorkspace({ workspacesRoot: root, id: created.id, path: after })).toEqual({
      workspaceId: created.id,
      path: after,
    });
    const record = JSON.parse(readFileSync(join(created.rootDir, "workspace.json"), "utf-8"));
    expect(record).toMatchObject({ schema: 1, id: created.id, path: after, title: "手头的项目" });
    expect(readdirSync(created.rootDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("同一个路径重复 relocate 是幂等的（不报 workspace-exists）", async () => {
    const path = projectDir("proj");
    const created = await ensureWorkspace({ workspacesRoot: root, path });
    const once = await relocateWorkspace({ workspacesRoot: root, id: created.id, path });
    const twice = await relocateWorkspace({ workspacesRoot: root, id: created.id, path });
    expect(twice).toEqual(once);
  });

  it("未知工作区 → unknown-workspace", async () => {
    await expect(
      relocateWorkspace({ workspacesRoot: root, id: "nope-00000000", path: projectDir("x") }),
    ).rejects.toMatchObject({ code: "unknown-workspace" });
  });
});

describe("requireWorkspacePath：路径不在就说不", () => {
  it("目录在 → 通过；不在 / 被同名文件占着 → workspace-path-missing（message 里带 path）", async () => {
    const path = projectDir("proj");
    await expect(requireWorkspacePath(path)).resolves.toBeUndefined();

    const missing = join(paths, "gone");
    await expect(requireWorkspacePath(missing)).rejects.toMatchObject({
      code: "workspace-path-missing",
      message: expect.stringContaining(missing),
    });

    // 同名普通文件占着路径：Agent 的 cwd 指不过去，同样算「这个工作区没了」
    const file = join(paths, "a-file");
    writeFileSync(file, "x");
    await expect(requireWorkspacePath(file)).rejects.toMatchObject({
      code: "workspace-path-missing",
    });
  });
});
