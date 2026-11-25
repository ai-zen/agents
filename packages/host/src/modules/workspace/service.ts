import { basename, resolve } from "node:path";

import { HostError } from "../../infra/errors.js";
import type { Translator } from "../i18n/index.js";
import type { workspaceTable } from "./table.js";
import type { WorkspaceRecord } from "./types.js";

/** `SQLITE_CONSTRAINT_UNIQUE`：`node:sqlite` 只报这个数，没有具名的错误类型 */
const UNIQUE_VIOLATION = 2067;

/**
 * 一个目录的默认项目名：**目录自己的名字**。
 *
 * 为什么不用创建时刻那一串毫秒：项目在列表里、在 `/ws` 的候选里、在提示语里都是拿名字认的，
 * 一串毫秒对人来说等于没有名字 —— 而「这个目录叫什么」是它手上现成的事实。
 *
 * 根目录那种 `basename` 给空串的地方（`/`、`C:\`）取归一化后的整条路径：那不是兜底，是这一格
 * 在这类路径上的唯一取值 —— 根目录没有「名字」这回事，它只有路径。
 */
export function defaultWorkspaceName(cwd: string): string {
  const absolute = resolve(cwd);
  const name = basename(absolute);
  return name === "" ? absolute : name;
}

export interface WorkspaceDeps {
  readonly workspaces: ReturnType<typeof workspaceTable>;
  readonly t: Translator;
}

/**
 * 项目行。`cwd` 没有修改入口：位置不可变，要换地方就是另一个项目 ——
 * 给它留一个方法，等于留了一条「搬过家的项目」的路。
 */
export class WorkspaceService {
  constructor(private readonly deps: WorkspaceDeps) {}

  /** `cwd` 在这一步归一化一次，此后库里那一格就是绝对路径，读写都拿它当身份 */
  create(name: string, cwd: string): WorkspaceRecord {
    const workspace: WorkspaceRecord = {
      id: crypto.randomUUID(),
      name,
      cwd: resolve(cwd),
      createdAt: Date.now(),
    };

    try {
      this.deps.workspaces.put(workspace);
    } catch (error) {
      // 唯一性由索引把关，所以「这个目录已经有项目」只会在插入这一刻被发现
      if ((error as { errcode?: number }).errcode === UNIQUE_VIOLATION) {
        throw new HostError(
          "conflict",
          this.deps.t("目录 {cwd} 已经有项目了", { cwd: workspace.cwd }),
          { entity: "workspace", cwd: workspace.cwd },
        );
      }
      throw error;
    }

    return workspace;
  }

  get(id: string): WorkspaceRecord | undefined {
    return this.deps.workspaces.get(id);
  }

  list(): WorkspaceRecord[] {
    return this.deps.workspaces.list();
  }

  rename(id: string, name: string): WorkspaceRecord {
    return this.update(id, { name });
  }

  /**
   * 需要改哪一格就合并哪一格。`cwd` 与 `createdAt` 不在 patch 里：项目没有搬家的动作，
   * 创建时间也不是可改的事实。
   */
  update(
    id: string,
    patch: Partial<Omit<WorkspaceRecord, "id" | "cwd" | "createdAt">>,
  ): WorkspaceRecord {
    const current = this.deps.workspaces.get(id);
    if (current === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("找不到 id 为 {workspaceId} 的项目", { workspaceId: id }),
        { entity: "workspace", workspaceId: id },
      );
    }

    const next: WorkspaceRecord = { ...current, ...patch };
    this.deps.workspaces.put(next);
    return next;
  }

  /**
   * 只删项目行。它名下的会话靠 `sessions.workspaceId` 上的外键连带删除，
   * 那张表归会话模块，这里不跨域删。
   */
  remove(id: string): void {
    this.deps.workspaces.delete(id);
  }
}
