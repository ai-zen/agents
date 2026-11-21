import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { HostError } from "../../infra/errors.js";
import type { Translator } from "../i18n/index.js";
import type { WorkspaceService } from "./service.js";

/**
 * 一次最多回这么多条。回的是字典序的前 500 条（整棵树走完再排序、再截断），多出来的那截安静地
 * 丢掉 —— 这是给 `@` 弹出来的候选清单用的，截断不是失败。
 */
const LIMIT = 500;

/** 路径最多这么多段（`src/deep/c.ts` 是 3 段） */
const MAX_DEPTH = 6;

/**
 * 这几类目录整棵子树都不进：依赖、版本库、构建产物、覆盖率报告。它们的名字是固定的，藏在里面的
 * 几千个文件对 `@` 提及没有用，只会把 500 条的名额占满。
 *
 * `.next` 与 `.git` 本来就会被下面「隐藏目录跳过」那一条拦掉，这里再列一次是为了让这份清单自己
 * 读得通 —— 它要回答的是「哪些不该进」，不是「哪些不是隐藏目录」。
 */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "target",
  "vendor",
]);

export interface ListMentionFilesDeps {
  readonly workspaces: WorkspaceService;
  readonly t: Translator;
}

/**
 * 给客户端「`@` 提及」用的文件清单：项目 `cwd` 下的普通文件，相对 `cwd` 的路径，正斜杠，字典序，
 * 最多 {@link LIMIT} 条。
 *
 * 为什么这件事在宿主：客户端在远端，那台机器上的盘它看不见，只有宿主摸得到 —— 所以「有哪些文件
 * 可以提」这个问题只能问宿主。
 *
 * `query` 给了就按子串筛（大小写不敏感，比对的是相对路径）：客户端那边每敲一个字母就再来问一次，
 * 筛在这儿省掉的是整份清单过 wire。
 *
 * 两种 `not_found` 分得开：项目行没有（`{ workspaceId }` 撑得住），与项目行还在、但那台机器上的
 * 目录已经不在了（多带一个 `cwd`，客户端能把那个路径原样说给用户）。
 */
export function listMentionFiles(
  deps: ListMentionFilesDeps,
  workspaceId: string,
  query?: string,
): string[] {
  const workspace = deps.workspaces.get(workspaceId);
  if (workspace === undefined) {
    throw new HostError("not_found", deps.t("找不到 id 为 {workspaceId} 的项目", { workspaceId }), {
      entity: "workspace",
      workspaceId,
    });
  }

  if (!existsSync(workspace.cwd)) {
    throw new HostError(
      "not_found",
      deps.t("项目 {workspaceId} 的目录 {cwd} 已经不在了", {
        workspaceId,
        cwd: workspace.cwd,
      }),
      { entity: "workspace", workspaceId, cwd: workspace.cwd },
    );
  }

  return listIn(workspace.cwd, query);
}

/**
 * 走一遍 `cwd`，回相对路径。
 *
 * 为什么自己走、不问 git（`git ls-files`）：那条路在前置条件上就会炸 —— `git` 不在、`cwd` 不是
 * 一个仓库、`.git` 是个文件（worktree 与 submodule 就是）时，它给的是一条错误，而 `cwd` 是用户随手
 * 填的一个目录，仓库只是它碰巧可能是的样子。更要紧的是口径：这里要的是「这棵树里有什么」，不是
 * 「git 管着什么」—— 没被跟踪的文件（刚建出来还没 `git add` 的那个）在 `git ls-files` 里不存在，
 * 而那恰恰是 `@` 最想提到的。
 *
 * 只看路径，不读内容：这棵树里一个文件的正文都不打开，也不 `stat` 它多大 —— 「单个文件超过 2MB
 * 不去读」因此在这里不构成一条分支，这里压根没有读的那一步。
 *
 * 顺序：整棵树走完，再排序，最后截断。于是截断掉的是字典序的尾巴，而不是「先遇上的那 500 个」
 * —— 后者会随文件系统返回目录项的顺序变，同一棵树问两次能给出两份不一样的清单。
 */
function listIn(cwd: string, query: string | undefined): string[] {
  const found: string[] = [];

  const walk = (directory: string, depth: number): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);

      if (entry.isDirectory()) {
        // 隐藏目录整棵跳过：`.git` 与 `.next` 之外还有 `.venv`、`.cache` 这些，逐个列名字列不完
        if (entry.name.startsWith(".")) continue;
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        // 目录到了第 5 段就不再往里：它里面的文件是第 7 段，越过了 6 层的上限
        if (depth < MAX_DEPTH - 1) walk(full, depth + 1);
        continue;
      }

      // 只收普通文件。符号链接两条 `is*()` 都为假，于是既不会跟进去，也不会被列出来 —— 跟进去的话
      // 一条指回上层目录的链接会让遍历停不下来
      if (!entry.isFile()) continue;
      found.push(relative(cwd, full).split(sep).join("/"));
    }
  };

  walk(cwd, 0);

  const needle = query?.toLowerCase();
  const matched =
    needle === undefined ? found : found.filter((path) => path.toLowerCase().includes(needle));

  return matched.sort().slice(0, LIMIT);
}
