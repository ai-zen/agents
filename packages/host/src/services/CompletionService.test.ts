/**
 * `@` 补全的验收。
 *
 * 覆盖：git 仓库走 `git ls-files`、非 git 用遍历并排除 `node_modules/.git/dist`、
 * 20000 条上限（用上限注入验证截断）、5s 超时（假时钟，不真等）、15s 缓存、
 * 未就绪时如实说 `scanning` / `unavailable`（不假装空目录）。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CompletionService,
  selectEntries,
  type CompletionClock,
  type GitListing,
} from "./CompletionService.js";

const WORKSPACE_ID = "ws-1";

/** 可控时钟：`setTimeout` 只登记，由用例决定什么时候到点 */
class FakeClock implements CompletionClock {
  time = 1_000_000;
  private timers: { handler: () => void; cancelled: boolean }[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(handler: () => void, _ms: number): () => void {
    const timer = { handler, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  /** 推进时间并把登记过的计时器全部触发 */
  advance(ms: number): void {
    this.time += ms;
    const pending = this.timers.splice(0);
    for (const timer of pending) {
      if (!timer.cancelled) timer.handler();
    }
  }

  get pending(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }
}

let dataRoot: string;
let project: string;
let clock: FakeClock;

/** 记账用的假 git 执行器 */
class FakeGit {
  readonly calls: string[] = [];
  listing: GitListing = { ok: true, files: [] };
  /** 给了就永远不 resolve（造「一直扫不完」） */
  hang = false;

  run = async (cwd: string): Promise<GitListing> => {
    this.calls.push(cwd);
    if (this.hang) return await new Promise<GitListing>(() => undefined);
    return this.listing;
  };
}

async function writeFileAt(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "x", "utf-8");
}

/** 等一个条件成立（后台扫描是异步跑的，断言前先等它跑到要说的那一步） */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等不到：${label}`);
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "ai-zen-completion-"));
  project = join(dataRoot, "project");
  await mkdir(project, { recursive: true });
  clock = new FakeClock();
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function makeService(git: FakeGit, options: { maxEntries?: number } = {}): CompletionService {
  return new CompletionService({
    findWorkspace: (workspaceId) => (workspaceId === WORKSPACE_ID ? { cwd: project } : undefined),
    runGit: git.run,
    clock,
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
  });
}

describe("CompletionService：git 仓库", () => {
  it("第一次问说「还在扫」，扫完给清单", async () => {
    await mkdir(join(project, ".git"), { recursive: true });
    await writeFileAt(join(project, "untracked-by-git.txt"));
    const git = new FakeGit();
    git.listing = { ok: true, files: ["src/a.ts", "src/b.ts", "README.md"] };
    const service = makeService(git);

    const first = await service.files({ workspaceId: WORKSPACE_ID, prefix: "" });
    expect(first.state).toBe("scanning");
    expect(first.entries).toEqual([]);
    expect(first.scannedAt).toBeNull();
    expect(first.problem?.messageKey).toBe("completion.scanning");

    await service.prefetch(WORKSPACE_ID);

    const ready = await service.files({ workspaceId: WORKSPACE_ID, prefix: "" });
    expect(ready.state).toBe("ready");
    expect(ready.scannedAt).toBe(new Date(clock.now()).toISOString());
    expect(ready.problem).toBeNull();
    expect(ready.truncated).toBe(false);
    // 只列 git 认的文件：磁盘上那个没进 git 的不在清单里
    expect(ready.entries).toEqual([
      { path: "src", name: "src", kind: "directory" },
      { path: "README.md", name: "README.md", kind: "file" },
    ]);
    expect(git.calls).toEqual([project]);
  });

  it("按前缀切：目录 + 文件两类条目", async () => {
    await mkdir(join(project, ".git"), { recursive: true });
    const git = new FakeGit();
    git.listing = {
      ok: true,
      files: ["src/components/button.tsx", "src/core.ts", "src/a.ts", "test/x.test.ts"],
    };
    const service = makeService(git);
    await service.prefetch(WORKSPACE_ID);

    const result = await service.files({ workspaceId: WORKSPACE_ID, prefix: "src/" });
    expect(result.entries).toEqual([
      { path: "src/components", name: "components", kind: "directory" },
      { path: "src/a.ts", name: "a.ts", kind: "file" },
      { path: "src/core.ts", name: "core.ts", kind: "file" },
    ]);

    const narrowed = await service.files({ workspaceId: WORKSPACE_ID, prefix: "src/co" });
    expect(narrowed.entries).toEqual([
      { path: "src/components", name: "components", kind: "directory" },
      { path: "src/core.ts", name: "core.ts", kind: "file" },
    ]);
  });

  it("git 跑不动就退回遍历，清单照样有", async () => {
    await mkdir(join(project, ".git"), { recursive: true });
    await writeFileAt(join(project, "src", "index.ts"));
    const git = new FakeGit();
    git.listing = { ok: false, files: [], reason: "git not found" };
    const service = makeService(git);

    await service.prefetch(WORKSPACE_ID);
    const result = await service.files({ workspaceId: WORKSPACE_ID, prefix: "src/" });
    expect(result.state).toBe("ready");
    expect(result.entries.map((entry) => entry.path)).toContain("src/index.ts");
  });
});

describe("CompletionService：非 git 目录", () => {
  it("遍历时跳过 node_modules / .git / dist", async () => {
    await writeFileAt(join(project, "src", "index.ts"));
    await writeFileAt(join(project, "src", "deep", "x.ts"));
    await writeFileAt(join(project, "node_modules", "pkg", "index.js"));
    await writeFileAt(join(project, "dist", "out.js"));
    await writeFileAt(join(project, ".git", "config"));
    await writeFileAt(join(project, "README.md"));

    // 真有 `.git` 但 git 跑不起来：退回遍历，且遍历要跳过这三个目录
    const git = new FakeGit();
    git.listing = { ok: false, files: [], reason: "not a repository" };
    const service = makeService(git);
    await service.prefetch(WORKSPACE_ID);

    const result = await service.files({ workspaceId: WORKSPACE_ID, prefix: "" });
    expect(result.state).toBe("ready");
    expect(result.entries).toEqual([
      { path: "src", name: "src", kind: "directory" },
      { path: "README.md", name: "README.md", kind: "file" },
    ]);
    expect(git.calls).toEqual([project]);

    const all = await service.files({ workspaceId: WORKSPACE_ID, prefix: "src/" });
    expect(all.entries.map((entry) => entry.path)).toEqual(["src/deep", "src/index.ts"]);
  });

  it("空目录是 ready（不是 unavailable）", async () => {
    const service = makeService(new FakeGit());
    await service.prefetch(WORKSPACE_ID);
    const result = await service.files({ workspaceId: WORKSPACE_ID, prefix: "" });
    expect(result.state).toBe("ready");
    expect(result.entries).toEqual([]);
    expect(result.problem).toBeNull();
  });
});

describe("CompletionService：上限、超时、缓存", () => {
  it("到上限就停，并说明被截断了（D7 的 20000 条，这里用注入的小上限验证）", async () => {
    await mkdir(join(project, ".git"), { recursive: true });
    const git = new FakeGit();
    git.listing = { ok: true, files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] };
    const service = makeService(git, { maxEntries: 3 });
    await service.prefetch(WORKSPACE_ID);

    const result = await service.files({ workspaceId: WORKSPACE_ID, prefix: "" });
    expect(result.state).toBe("ready");
    expect(result.truncated).toBe(true);
    expect(result.problem?.messageKey).toBe("completion.truncated");
    expect(result.problem?.params.limit).toBe(3);
    expect(result.entries).toHaveLength(3);
  });

  it("超时：扫不完就如实说，不假装空目录", async () => {
    await mkdir(join(project, ".git"), { recursive: true });
    const git = new FakeGit();
    git.hang = true;
    const service = makeService(git);

    const first = await service.files({ workspaceId: WORKSPACE_ID, prefix: "" });
    expect(first.state).toBe("scanning");
    await waitFor(() => clock.pending === 1, "扫描登记超时计时器");

    // 假时钟到点：不等 5 秒
    clock.advance(5_000);
    await waitFor(() => clock.pending === 0 && git.calls.length === 1, "超时之后的收尾");

    const after = await service.files({ workspaceId: WORKSPACE_ID, prefix: "" });
    expect(after.state).toBe("unavailable");
    expect(after.entries).toEqual([]);
    expect(after.problem?.messageKey).toBe("completion.unavailable");
    expect(String(after.problem?.params.reason)).toContain("5s");
  });

  it("15s 缓存：TTL 内不重新扫，过期之后才扫", async () => {
    await mkdir(join(project, ".git"), { recursive: true });
    const git = new FakeGit();
    git.listing = { ok: true, files: ["a.ts"] };
    const service = makeService(git);

    await service.prefetch(WORKSPACE_ID);
    expect(git.calls).toHaveLength(1);

    clock.advance(10_000);
    const cached = await service.files({ workspaceId: WORKSPACE_ID, prefix: "" });
    expect(cached.state).toBe("ready");
    expect(git.calls).toHaveLength(1);

    clock.advance(6_000);
    const expired = await service.files({ workspaceId: WORKSPACE_ID, prefix: "" });
    expect(expired.state).toBe("scanning");
    await service.prefetch(WORKSPACE_ID);
    expect(git.calls).toHaveLength(2);
  });

  it("同时问两次，第二次说 scanning（不叠着扫）", async () => {
    await mkdir(join(project, ".git"), { recursive: true });
    const git = new FakeGit();
    git.hang = true;
    const service = makeService(git);

    await service.files({ workspaceId: WORKSPACE_ID, prefix: "" });
    await waitFor(() => git.calls.length === 1, "第一次扫描开始");
    const second = await service.files({ workspaceId: WORKSPACE_ID, prefix: "" });
    expect(second.state).toBe("scanning");
    expect(git.calls).toHaveLength(1);
  });
});

describe("CompletionService：拿不到清单的情况", () => {
  it("项目不存在是 not_found", async () => {
    const service = makeService(new FakeGit());
    await expect(service.files({ workspaceId: "ws-gone", prefix: "" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("目录已经不在了就说清楚（D12 / D7）", async () => {
    const service = makeService(new FakeGit());
    await rm(project, { recursive: true, force: true });
    await service.prefetch(WORKSPACE_ID);

    const result = await service.files({ workspaceId: WORKSPACE_ID, prefix: "" });
    expect(result.state).toBe("unavailable");
    expect(result.problem?.messageKey).toBe("completion.unavailable");
    expect(String(result.problem?.params.reason)).toContain("folder");
  });
});

describe("selectEntries", () => {
  const paths = ["src/a.ts", "src/components/x.ts", "README.md", "docs/guide.md"];

  it("没有前缀时给出第一层的目录与文件", () => {
    expect(selectEntries(paths, "", 10)).toEqual([
      { path: "docs", name: "docs", kind: "directory" },
      { path: "src", name: "src", kind: "directory" },
      { path: "README.md", name: "README.md", kind: "file" },
    ]);
  });

  it("前缀带路径时只看那一层", () => {
    expect(selectEntries(paths, "src/", 10)).toEqual([
      { path: "src/components", name: "components", kind: "directory" },
      { path: "src/a.ts", name: "a.ts", kind: "file" },
    ]);
  });

  it("limit 截断", () => {
    expect(selectEntries(paths, "", 1)).toEqual([
      { path: "docs", name: "docs", kind: "directory" },
    ]);
  });
});
