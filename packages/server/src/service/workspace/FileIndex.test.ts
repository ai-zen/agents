/**
 * 文件索引 —— 全部靠依赖注入测（本仓规矩：不写模块级 mock）：git / glob / 时钟都是参数。
 *
 * 只有一个用例碰真磁盘（`fs.glob` 兜底的那条路）：那里要证明的正是「真实目录能被扫出来、
 * 且结果形状对得上协议」（相对路径、不带 `./`、目录带 `dir`），假件证明不了。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileIndex, INDEX_TTL_MS, fromGitList, type FileIndexDeps } from "./FileIndex.js";
import type { WorkspaceFileEntry } from "../../protocol/sessions.js";

describe("fromGitList：git 的文件清单 → 「文件 + 祖先目录」条目", () => {
  it("从每个文件反推祖先目录：`dir: true` 条目排在文件之前（客户端靠它渲染可钻的目录行）", () => {
    const entries = fromGitList(["src/tui/chat.tsx"]);

    expect(entries).toEqual([
      // 目录由深到浅（与 CLI 侧同一个反推循环、同一个顺序）
      { path: "src/tui", dir: true },
      { path: "src", dir: true },
      { path: "src/tui/chat.tsx", dir: false },
    ]);
    expect(entries.filter((entry) => entry.dir)).toHaveLength(2);
    // 目录全在文件之前：一屏里先能钻目录，再选具体文件
    const firstFile = entries.findIndex((entry) => !entry.dir);
    expect(entries.slice(firstFile).every((entry) => !entry.dir)).toBe(true);
  });

  it("共用祖先目录只出现一次（两个文件同属 `src/tui`，`Set` 去重）", () => {
    const entries = fromGitList(["src/tui/chat.tsx", "src/tui/input.tsx"]);

    expect(entries.filter((entry) => entry.dir).map((entry) => entry.path)).toEqual([
      "src/tui",
      "src",
    ]);
    expect(entries.filter((entry) => !entry.dir).map((entry) => entry.path)).toEqual([
      "src/tui/chat.tsx",
      "src/tui/input.tsx",
    ]);
    expect(entries).toHaveLength(4); // 2 个目录 + 2 个文件，没有重复行
  });

  it("Windows 风格反斜杠统一成 `/`（候选与插入文本都用 `/`）", () => {
    const entries = fromGitList(["src\\tui\\chat.tsx"]);

    // 先归一化再反推，所以目录也是 `/` 分隔的 —— 否则会造出 `src\\tui` 这种客户端用不了的路径
    expect(entries.map((entry) => entry.path)).toEqual(["src/tui", "src", "src/tui/chat.tsx"]);
  });

  it("空行 / 空白被丢掉", () => {
    expect(fromGitList(["", "  ", "a.ts"]).map((entry) => entry.path)).toEqual(["a.ts"]);
  });

  it("按上限截断（大仓不能把整份清单都塞给客户端）", () => {
    expect(fromGitList(["a", "b", "c"], 2)).toHaveLength(2);
  });

  it("封顶按「文件 + 目录」一起算：目录也占名额", () => {
    // 1 个目录 + 3 个文件 = 4：第 3 个文件入列时刚好到顶，第 4 个不再看
    expect(fromGitList(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], 4)).toEqual([
      { path: "src", dir: true },
      { path: "src/a.ts", dir: false },
      { path: "src/b.ts", dir: false },
      { path: "src/c.ts", dir: false },
    ]);
  });
});

/** 注入用：一个「什么都没扫到」的兜底，用来断言某条路**没有**走兜底 */
const NO_GLOB = async (): Promise<WorkspaceFileEntry[]> => {
  throw new Error("不该走到 glob 兜底");
};

describe("FileIndex：来源与缓存", () => {
  const clock = { t: 0 };

  const deps = (overrides: FileIndexDeps = {}): FileIndexDeps => ({
    globFiles: async () => [{ path: "glob-fallback.ts", dir: false }],
    now: () => clock.t,
    ...overrides,
  });

  beforeEach(() => {
    clock.t = 0;
  });

  it("git 可用时用 git 清单（不去扫盘）", async () => {
    const seen: string[] = [];
    const index = new FileIndex(
      deps({
        runGit: async (root) => {
          seen.push(root);
          return ["src/chat.tsx"];
        },
        globFiles: NO_GLOB,
      }),
    );

    // git 只给文件，但交出去的清单里有目录（客户端要靠它渲染可钻的目录行）
    expect(await index.list("/repo")).toEqual([
      { path: "src", dir: true },
      { path: "src/chat.tsx", dir: false },
    ]);
    expect(seen).toEqual(["/repo"]); // 根目录就是调用方给的那个
  });

  it("git 不可用（不是仓库 / 没装 git）时落回 fs.glob", async () => {
    const index = new FileIndex(deps({ runGit: async () => null }));
    expect(await index.list("/not-a-repo")).toEqual([{ path: "glob-fallback.ts", dir: false }]);
  });

  it("git 抛错也收敛成空数组（补全挂了不该影响用户发消息）", async () => {
    const index = new FileIndex(
      deps({
        runGit: async () => {
          throw new Error("boom");
        },
        globFiles: NO_GLOB,
      }),
    );
    expect(await index.list("/repo")).toEqual([]);
  });

  it("TTL 内复用缓存（不重扫），过期后重扫", async () => {
    let scans = 0;
    const index = new FileIndex(
      deps({
        runGit: async () => {
          scans += 1;
          return ["a.ts"];
        },
      }),
    );

    await index.list("/repo");
    clock.t = INDEX_TTL_MS - 1;
    await index.list("/repo");
    expect(scans).toBe(1);

    clock.t = INDEX_TTL_MS + 1;
    await index.list("/repo");
    expect(scans).toBe(2);
  });

  it("缓存按根目录分键：换一个工作区就得扫它自己的（不串味）", async () => {
    const roots: string[] = [];
    const index = new FileIndex(
      deps({
        runGit: async (root) => {
          roots.push(root);
          return [`${path.basename(root)}.ts`];
        },
      }),
    );

    expect(await index.list("/work/a")).toEqual([{ path: "a.ts", dir: false }]);
    expect(await index.list("/work/b")).toEqual([{ path: "b.ts", dir: false }]);
    // 回到 a：缓存还在，不重扫
    expect(await index.list("/work/a")).toEqual([{ path: "a.ts", dir: false }]);
    expect(roots).toEqual(["/work/a", "/work/b"]);
  });

  it("条目数按 maxEntries 封顶（git 与兜底两条路都封）", async () => {
    const git = new FileIndex(deps({ runGit: async () => ["a", "b", "c"], maxEntries: 2 }));
    expect(await git.list("/repo")).toHaveLength(2);

    const glob = new FileIndex(
      deps({
        runGit: async () => null,
        globFiles: async () => [
          { path: "a", dir: false },
          { path: "b", dir: false },
          { path: "c", dir: false },
        ],
        maxEntries: 2,
      }),
    );
    expect(await glob.list("/repo")).toHaveLength(2);
  });

  it("注入的 ttlMs 说了算（0 = 每次都用新扫的结果）", async () => {
    let scans = 0;
    const index = new FileIndex(
      deps({
        runGit: async () => {
          scans += 1;
          return ["a.ts"];
        },
        ttlMs: 0,
      }),
    );

    await index.list("/repo");
    await index.list("/repo");
    expect(scans).toBe(2);
  });
});

describe("FileIndex：真实磁盘（fs.glob 兜底）", () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it("扫出子目录里的文件：相对路径、不带 `./` 前缀，目录条目带 `dir`", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "aiz-file-index-"));
    root = project;
    await mkdir(path.join(project, "src", "ui"), { recursive: true });
    await writeFile(path.join(project, "src", "ui", "button.tsx"), "");
    await writeFile(path.join(project, "README.md"), "");

    // 强制走兜底：注入一个「git 不可用」的依赖，其余用真实实现
    const index = new FileIndex({ runGit: async () => null });
    const entries = await index.list(project);

    const files = entries
      .filter((entry) => !entry.dir)
      .map((entry) => entry.path)
      .sort();
    expect(files).toEqual(["README.md", "src/ui/button.tsx"]);
    expect(entries.some((entry) => entry.path.startsWith("./"))).toBe(false);
    // 兜底那条路本来就拿得到 dirent，顺手带上目录（`dir: true` 决定补全后加不加 `/`）
    expect(
      entries
        .filter((entry) => entry.dir)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(["src", "src/ui"]);
  });
});
