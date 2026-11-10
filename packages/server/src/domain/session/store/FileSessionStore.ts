/**
 * 文件式会话存储 —— 一个工作区一个目录，目录结构固定为：
 *
 *   <rootDir>/sessions/<id>.json        每个会话一个文件，写盘原子（正文 + 元数据）
 *   <rootDir>/sessions/<id>.meta.json   列表清单（无正文）；写入时跟着更新
 *   <rootDir>/last-session.json         「本工作区上一轮会话」指针（单指针）
 *
 * ## 为什么要清单（sidecar）
 *
 * 侧栏每次刷新都要「全部会话 + 标题 + 条数 + 更新时间」。直接从 `<id>.json` 里取，
 * 就得把每个存档（可达数 MB）全读进来解析一遍 —— 200 段会话就是 200 次 parse。
 * 清单只有六个字段，读它不用碰正文。
 *
 * 为什么不搞一个大索引文件（`index.json`）：多段会话可能并发落盘，一个共享文件就是
 * 写竞争 + 互相覆盖；每段自己的清单只由它的写者动，天然没这个问题。
 *
 * 没有清单的存档（清单被手删、或从未写过）：`list()` 遇到就**读一次补一份**（幂等，之后不再解析）。
 *
 * 三条是由位置本身决定的：
 *   - 会话属于**工作区**，不属于某个前端（CLI / 桌面端共享同一份数据）；
 *   - 工作区自己就是分区键，指针不必再带 cwd 这一层，所以是单指针；
 *   - 路径：全部由构造参数注入，本模块不读任何进程级全局。
 *
 * 本模块只认 `<workspace>/sessions/` 这一种布局。别的历史布局的归位属于一次性运维，
 * 不该长期住在产品代码里。
 */

import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { compareSessionEntries } from "./SessionStore.js";
import type { SessionRecord, SessionStore, SessionEntry, SessionPointer } from "./SessionStore.js";

export interface FileSessionStoreOptions {
  /** 工作区根目录（`<aiZenDir>/workspaces/<workspaceId>`），内部布局见文件头 */
  rootDir: string;
}

const POINTER_VERSION = 1;

/** 列表清单的后缀。与 `.json` 一起出现时**先认它**（它自己也是 `.json` 结尾） */
const META_SUFFIX = ".meta.json";

/** 存档 → 清单：六个字段，不碰正文 */
function entryOf<Message>(record: SessionRecord<Message>, updatedAt: string): SessionEntry {
  return {
    id: record.id,
    agentId: record.agentId,
    ...(record.title !== undefined ? { title: record.title } : {}),
    ...(record.modelId !== undefined ? { modelId: record.modelId } : {}),
    messageCount: record.messages.length,
    updatedAt,
  };
}

export class FileSessionStore<Message = unknown> implements SessionStore<Message> {
  private readonly sessionsDir: string;
  private readonly pointerFile: string;

  constructor(options: FileSessionStoreOptions) {
    this.sessionsDir = join(options.rootDir, "sessions");
    this.pointerFile = join(options.rootDir, "last-session.json");
  }

  async list(): Promise<SessionEntry[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.sessionsDir);
    } catch {
      return []; // 新工作区：会话目录还没建
    }

    // 一个 id 只出一条：`.json` 与 `.meta.json` 会同时出现，谁先处理都只是填同一个键
    const entries = new Map<string, SessionEntry>();
    for (const file of files) {
      if (file.endsWith(META_SUFFIX)) {
        const id = file.slice(0, -META_SUFFIX.length);
        const entry = await this.readMeta(id);
        if (entry) entries.set(id, entry);
        continue;
      }
      if (!file.endsWith(".json")) continue; // 滤掉写盘中的 `.json.tmp`
      const id = file.slice(0, -".json".length);
      if (entries.has(id)) continue; // 清单已经给了
      // 没有清单的存档（清单被手删或从未写过）：读一次、补一份，之后不再解析
      const entry = (await this.readMeta(id)) ?? (await this.backfillMeta(id));
      if (entry) entries.set(id, entry);
    }
    return [...entries.values()].sort(compareSessionEntries);
  }

  /**
   * 一条会话的清单 —— `list()` 的单条版本：同一个清单文件，同一条回填路径。
   *
   * 为什么不照 `list()` 再筛一遍：`list()` 要 readdir 整个会话目录、逐条读清单，为了知道
   * **一条**记录的时间付一次全表扫描（1000 段存档时 ~78ms）。这里只碰 `<id>.meta.json`
   * 这一个文件，与存档条数无关。
   *
   * 为什么与 `list()` 一样允许回填：没有清单的存档（清单被手删或从未写过）里没有这份投影，
   * 只看 `<id>.meta.json` 的话，续接会拿到 `null`（时间退回「现在」），而侧栏里同一段会话
   * 仍显示 mtime —— 同一个事实两个值，正是要避开的那种。
   */
  async entry(id: string): Promise<SessionEntry | null> {
    return (await this.readMeta(id)) ?? (await this.backfillMeta(id));
  }

  /** 读清单；不存在或形状不对 → `null`（没有清单不是错误） */
  private async readMeta(id: string): Promise<SessionEntry | null> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.metaPathOf(id), "utf-8"),
      ) as Partial<SessionEntry>;
      if (!parsed || typeof parsed.id !== "string" || typeof parsed.messageCount !== "number") {
        return null;
      }
      return parsed as SessionEntry;
    } catch {
      return null;
    }
  }

  /**
   * 给没有清单的存档补一份。幂等：补完下次就走清单，不再解析正文。
   *
   * `updatedAt` 取正文文件的 mtime 而不是「现在」：清单是正文的**投影**，编造一个
   * 当前时间会把这段老会话排到侧栏最前面。
   */
  private async backfillMeta(id: string): Promise<SessionEntry | null> {
    let updatedAt: string;
    try {
      updatedAt = (await fs.stat(this.pathOf(id))).mtime.toISOString();
    } catch {
      return null; // readdir 与 stat 之间被删掉：跳过
    }
    const record = await this.read(id);
    if (!record) return null;
    const entry = entryOf(record, updatedAt);
    // 补不上也不影响这次列表（下次还会再试） —— 列表不能因为写不了清单就失败
    await this.writeMeta(entry).catch(() => {});
    return entry;
  }

  async read(id: string): Promise<SessionRecord<Message> | null> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.pathOf(id), "utf-8"),
      ) as SessionRecord<Message>;
      // 形状不对（手改坏、外来内容）一律当作没有，不猜
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
    // 清单是正文的投影，所以**先正文后清单**：反过来的话，中间被杀会留下一个“列表里有、
    // 正文还没有”的条目；而现在这个顺序最多让条数晚一拍，下一次写就补上。
    await this.writeMeta(entryOf(record, new Date().toISOString()));
  }

  /**
   * 删存档。**先清单后正文**：中途被杀最多剩下正文（下次 `list()` 会自动补清单，不算丢），
   * 反过来则会留下一个指向不存在正文的幽灵条目。
   */
  async remove(id: string): Promise<void> {
    await fs.rm(this.metaPathOf(id), { force: true });
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
      const parsed = JSON.parse(
        await fs.readFile(this.pointerFile, "utf-8"),
      ) as Partial<SessionPointer>;
      if (typeof parsed?.id !== "string" || !parsed.id) return null;
      return {
        id: parsed.id,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      };
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

  private metaPathOf(id: string): string {
    assertSafeId(id);
    return join(this.sessionsDir, `${id}${META_SUFFIX}`);
  }

  private async writeMeta(entry: SessionEntry): Promise<void> {
    const target = this.metaPathOf(entry.id);
    await fs.mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry, null, 2), "utf-8");
    await fs.rename(tmp, target);
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
