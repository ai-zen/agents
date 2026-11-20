import { spawnSync } from "node:child_process";
import type { Dirent } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** 一次最多给这么多条：列表里只有前几十条会被人看到，剩下的只占内存 */
const LIMIT = 20000;

/** 这三个目录整棵子树里没有一个文件是补全要用的 */
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist"]);

/** 同步执行的 git 会挡住事件循环，所以给它一个上限 */
const GIT_TIMEOUT_MS = 10_000;

/**
 * 给 `@` 补全用的文件清单：相对 `cwd` 的路径，按字典序。
 *
 * 目录是 git 仓库时问 git：它给出的正是「项目认为自己在管的那些文件」，构建产物与忽略
 * 清单已经排除掉了；自己遍历只能靠目录名猜。
 */
export function listFiles(cwd: string): string[] {
  const paths: string[] = [];

  if (existsSync(join(cwd, ".git"))) {
    // `-z`：默认输出会把非 ASCII 路径转义成八进制并加上引号，补全拿到的会是一串看不懂的东西
    const listed = spawnSync("git", ["ls-files", "-z"], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (listed.error !== undefined || listed.status !== 0) {
      const context = listed.error?.message ?? listed.stderr;
      throw new Error(`Cannot list git files in "${cwd}": ${context}`, {
        cause: listed.error ?? new Error(listed.stderr),
      });
    }
    paths.push(...listed.stdout.split("\0").filter((path) => path !== ""));
  } else {
    const collect = (directory: string): void => {
      if (paths.length >= LIMIT) return;

      let entries: Dirent[];
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        const context = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot read directory "${directory}": ${context}`, { cause: error });
      }

      for (const entry of entries) {
        if (paths.length >= LIMIT) return;
        const full = join(directory, entry.name);
        // 符号链接不跟进去（`isDirectory()` 对它为假）：一条指回上层目录的链接会让遍历停不下来
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) collect(full);
        } else {
          paths.push(relative(cwd, full));
        }
      }
    };
    collect(cwd);
  }

  return paths.sort().slice(0, LIMIT);
}
