/**
 * 四条验收：给 `@` 提及用的那份清单是相对项目 `cwd` 的路径、跳掉 `node_modules` 与隐藏目录、
 * 按字典序；超过 500 条就截断（不是报错）；`query` 是大小写不敏感的子串筛；项目行不在与目录不在
 * 都是 `not_found`。
 *
 * 第一条里那两类目录各有一条理由：`node_modules` 与构建产物能有几万个文件，列出来只是把 500 条
 * 的名额占满；隐藏目录（`.git` 打头）整棵跳过，`.git`、`.venv`、`.cache` 一个名字都列不完。
 * 「顺序」也要验：截断的是字典序的尾巴，这件事只有在顺序定了之后才说得清。
 *
 * 第三条是给客户端用的那种问法：`@` 后面每敲一个字母问一次，问的永远是「路径里有没有这一串」，
 * 大小写不该影响结果 —— 用户打 `app` 与打 `APP` 要的是同一批文件。
 *
 * 台架照 `workspace/remove.test.ts`：真临时目录、真内存库、真 `WorkspaceService`；调用从
 * `createCaller` 走，与客户端同一入口（`agent.clearInbox.test.ts` 也是这个搭法）。这一条 procedure
 * 只用 `workspaces` 与 `t` 两格，其余域整份转成 `HostApiDeps`：补齐它们得编出一堆与本题无关的
 * 替身，那些替身一格都不会被走到。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../infra/db.js";
import { HostError } from "../../infra/errors.js";
import { createTranslator } from "../i18n/index.js";
import { WorkspaceService } from "../workspace/service.js";
import { workspaceTable } from "../workspace/table.js";
import type { HostApiDeps } from "./deps.js";
import { createTrpc } from "./trpc.js";
import { workspaceRouter } from "./workspace.js";

const dataRoots: string[] = [];

afterEach(() => {
  for (const dataRoot of dataRoots.splice(0)) rmSync(dataRoot, { recursive: true, force: true });
});

function setup() {
  const db = openDatabase(":memory:");
  const t = createTranslator(() => "zh");
  const workspaces = new WorkspaceService({ workspaces: workspaceTable(db), t });

  const deps = { workspaces, t } as unknown as HostApiDeps;
  const api = createTrpc(t);
  const router = api.router({ workspace: workspaceRouter(deps, api) });
  const caller = router.createCaller({});

  return { caller, workspaces };
}

/** 造一个真目录，按给定的相对路径把文件摆进去（中间那几层目录跟着建） */
function newTree(paths: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "workspace-files-"));
  dataRoots.push(root);

  for (const path of paths) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "内容不在这一条的口径里");
  }

  return root;
}

/**
 * 这一次调用抛出的是哪个 `HostError`。tRPC 把 resolver 抛出的原始错误放在 `cause` 里（出网那一层
 * 换成 tRPC 自己的码），所以码要从 `cause` 上读 —— 与 `agent.clearInbox.test.ts` 同一处判法。
 */
async function hostErrorOf(call: Promise<unknown>): Promise<HostError> {
  try {
    await call;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof HostError) return cause;
    throw error;
  }
  throw new Error("这一次调用没有抛错");
}

describe("项目里的文件清单", () => {
  it("列相对路径、跳过 node_modules 与隐藏目录、按字典序", async () => {
    const { caller, workspaces } = setup();
    const cwd = newTree(["node_modules/x.js", ".git/config", "a.ts", "src/b.ts", "src/deep/c.ts"]);
    const workspace = workspaces.create("项目一", cwd);

    const { files } = await caller.workspace.files({ workspaceId: workspace.id });

    // 相对 `cwd`、正斜杠（不是绝对路径，也不带 `./`）、字典序
    expect(files).toEqual(["a.ts", "src/b.ts", "src/deep/c.ts"]);
  });

  it("上限 500 条：600 个文件回 500 条，截断的是字典序的尾巴", async () => {
    const { caller, workspaces } = setup();
    // 600 个平铺的文件：名字补零，字典序就是建它们的那个顺序
    const names = Array.from(
      { length: 600 },
      (_, index) => `f${String(index).padStart(3, "0")}.ts`,
    );
    const workspace = workspaces.create("项目一", newTree(names));

    const { files } = await caller.workspace.files({ workspaceId: workspace.id });

    expect(files).toHaveLength(500);
    expect(files[0]).toBe("f000.ts");
    expect(files[499]).toBe("f499.ts");
    expect(files).not.toContain("f500.ts");
  });

  it("`query` 是大小写不敏感的子串匹配", async () => {
    const { caller, workspaces } = setup();
    const workspace = workspaces.create(
      "项目一",
      newTree(["app.ts", "src/AppStore.ts", "src/deep/happy.ts", "src/other.ts"]),
    );

    // 打大写的一个前缀：小写的文件名照样命中
    const upper = await caller.workspace.files({ workspaceId: workspace.id, query: "APP" });
    expect(upper.files).toEqual(["app.ts", "src/AppStore.ts", "src/deep/happy.ts"]);

    // 打小写的一截路径：命中的还是同一批里与这一串有关的那几个
    const lower = await caller.workspace.files({ workspaceId: workspace.id, query: "appstore" });
    expect(lower.files).toEqual(["src/AppStore.ts"]);
  });

  it("项目不存在 / 目录不在 → not_found", async () => {
    const { caller, workspaces } = setup();

    // 项目行没有：撑得住的就是那个 id
    const missingRow = await hostErrorOf(caller.workspace.files({ workspaceId: "没有这个项目" }));
    expect(missingRow.code).toBe("not_found");
    expect(missingRow.details).toEqual({ entity: "workspace", workspaceId: "没有这个项目" });

    // 项目行还在，但那台机器上的目录没了：文案要说清是目录不在了，且带上那个路径
    const cwd = newTree(["a.ts"]);
    const workspace = workspaces.create("项目一", cwd);
    rmSync(cwd, { recursive: true, force: true });

    const missingDir = await hostErrorOf(caller.workspace.files({ workspaceId: workspace.id }));
    expect(missingDir.code).toBe("not_found");
    expect(missingDir.message).toContain("已经不在了");
    expect(missingDir.details).toEqual({ entity: "workspace", workspaceId: workspace.id, cwd });
  });
});
