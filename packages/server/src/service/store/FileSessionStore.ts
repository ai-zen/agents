/**
 * 文件式会话存储 —— 一个工作区一个目录，目录结构固定为：
 *
 *   <rootDir>/sessions/<id>.json        每个会话一个文件，写盘原子
 *   <rootDir>/last-session.json         「本工作区上一轮会话」指针（单指针）
 *
 * 与搬迁前的差别（`<aiZenDir>/cli/conversations` + 一份按 cwd 分键的 map 指针）：
 *   - 位置：会话属于**工作区**，不属于某个前端（CLI / 桌面端共享同一份数据）；
 *   - 指针：工作区自己就是分区键，指针不必再带 cwd 这一层，从 map 收敛成单指针；
 *   - 路径：全部由构造参数注入，本模块不读任何进程级全局。
 *
 * 老数据的归位见 `legacyMigration.ts`。
 */

import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { SessionRecord, SessionStore, SessionRef, SessionPointer } from "./SessionStore.js";

export interface FileSessionStoreOptions {
  /** 工作区根目录（`<aiZenDir>/workspaces/<workspaceId>`），内部布局见文件头 */
  rootDir: string;
}

const POINTER_VERSION = 1;

export class FileSessionStore<Message = unknown> implements SessionStore<Message> {
  private readonly sessionsDir: string;
  private readonly pointerFile: string;

  constructor(options: FileSessionStoreOptions) {
    this.sessionsDir = join(options.rootDir, "sessions");
    this.pointerFile = join(options.rootDir, "last-session.json");
  }

  async list(): Promise<SessionRef[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.sessionsDir);
    } catch {
      return []; // 新工作区：会话目录还没建
    }

    const entries: Array<{ id: string; mtime: number }> = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue; // 顺带滤掉写盘中的 `.json.tmp`
      const id = file.slice(0, -".json".length);
      try {
        const stat = await fs.stat(join(this.sessionsDir, file));
        entries.push({ id, mtime: stat.mtimeMs });
      } catch {
        // readdir 与 stat 之间被别的进程删掉：跳过即可，不该让 `/load` 崩
      }
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    return entries.map((entry) => ({ id: entry.id }));
  }

  async read(id: string): Promise<SessionRecord<Message> | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.pathOf(id), "utf-8")) as SessionRecord<Message>;
      // 形状不对（旧版残留、手改坏）一律当作没有，不猜
      if (!parsed || typeof parsed.id !== "string" || !Array.isArray(parsed.messages)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * 原子写：先写 `<id>.json.tmp` 再 rename。
   *
   * 直接 `writeFile` 时，进程在写一半被杀（Ctrl+C / OOM / 断电）会留下半截 JSON，
   * 读回来解析失败 —— 整段历史就此丢失。会话文件可达数 MB，写入窗口并不小；
   * 同文件系统内 rename 是原子操作，任何时刻读到的要么是旧文件、要么是完整新文件。
   */
  async write(record: SessionRecord<Message>): Promise<void> {
    const target = this.pathOf(record.id);
    await fs.mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(record, null, 2), "utf-8");
    await fs.rename(tmp, target);
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.pathOf(id), { force: true });
  }

  async exists(id: string): Promise<boolean> {
    try {
      await fs.access(this.pathOf(id));
      return true;
    } catch {
      return false;
    }
  }

  async lastSession(): Promise<SessionPointer | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.pointerFile, "utf-8")) as Partial<SessionPointer>;
      if (typeof parsed?.id !== "string" || !parsed.id) return null;
      return { id: parsed.id, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "" };
    } catch {
      return null;
    }
  }

  async setLastSession(id: string): Promise<void> {
    await fs.mkdir(dirname(this.pointerFile), { recursive: true });
    const tmp = `${this.pointerFile}.tmp`;
    const body = { version: POINTER_VERSION, id, updatedAt: new Date().toISOString() };
    await fs.writeFile(tmp, JSON.stringify(body, null, 2), "utf-8");
    await fs.rename(tmp, this.pointerFile);
  }

  private pathOf(id: string): string {
    assertSafeId(id);
    return join(this.sessionsDir, `${id}.json`);
  }
}

/**
 * 会话 id 直接来自用户输入（`/save ../../x`），必须在这里挡住路径穿越。
 *
 * 子目录是允许的（`/save 项目/a` 一直可以用），所以不能简单禁掉 `/`；
 * 禁的是**逃出会话目录**的写法：绝对路径、`..`、`.`、空段、Windows 分隔符。
 * 一处判断，而不是每个调用点各写一遍。
 */
function assertSafeId(id: string): void {
  const segments = id.split("/");
  const unsafe =
    id.length === 0 ||
    isAbsolute(id) ||
    id.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (unsafe) throw new Error(`invalid session id: ${JSON.stringify(id)}`);
}
