import { promises as fs } from "node:fs";
import { resolve, sep } from "node:path";
import { SILENT_LOG, type LogSink } from "./logger.js";

/**
 * 通用实体仓储 — 对磁盘 JSON 文件的 CRUD 操作。
 *
 * 约定：
 *   - 每个实体一个 JSON 文件，文件名 = `${id}.json`
 *   - 目录不存在时自动创建
 *   - `read()` 只把「文件不在」答成 `null`；文件在但读不出来（不是 JSON、没权限）照抛
 *   - `list()` 跳过读不出来的那**一条**并报一句
 */
export class EntityRepository<T extends { id: string }> {
  /**
   * @param dir 实体目录
   * @param logger 日志口（可选）：`list()` 跳过读不出来的那一条时从它报一句。缺省 `SILENT_LOG`
   */
  constructor(
    private dir: string,
    protected readonly logger: LogSink = SILENT_LOG,
  ) {}

  /**
   * 获取实体的文件路径；`id` 必须落在本仓储目录内，否则抛错。
   *
   * 这是**唯一**的落盘口（read / write / delete 全走这里，`list()` 的 id 来自
   * `readdir` 的单层文件名、不可能逃逸），所以校验放这里读写删天然自洽。
   *
   * 两个细节都是必需的：
   *   - 用 `resolve` 而不是 `join`：只有 `resolve` 会把绝对路径（`/etc/passwd`）归一化拦下；
   *   - 比较 `root + sep` 而不是裸 `startsWith(root)`：`<root>-evil/x` 也以 `<root>` 开头。
   */
  protected path(id: string): string {
    const root = resolve(this.dir);
    const target = resolve(root, `${id}.json`);
    if (!target.startsWith(root + sep)) {
      throw new Error(`Invalid entity id: ${JSON.stringify(id)}`);
    }
    return target;
  }

  /**
   * 列出目录下所有实体。
   *
   * 一个坏文件只影响它自己那一行（宿主的「这个模型被哪个助手引用」读的是整张表），所以
   * 这里接住并报一句：跳过的是这一条，不是整张表。
   */
  async list(): Promise<T[]> {
    try {
      await fs.access(this.dir);
    } catch {
      return [];
    }

    const entries = await fs.readdir(this.dir);
    const ids = entries.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

    const entities: T[] = [];
    for (const id of ids) {
      try {
        const entity = await this.read(id);
        if (entity !== null) entities.push(entity);
      } catch (error) {
        this.logger.warn(
          `[entity] 读不出来，列表里跳过这一条：${this.path(id)}（${String(error)}）`,
        );
      }
    }
    return entities;
  }

  /**
   * 读取单个实体：**只有文件不在才回 `null`**。
   *
   * 「没有这一条」与「这一条坏了」（不是 JSON、EACCES、EIO）是两个答案。折叠成一个 `null`
   * 会让读者对坏文件说假话。要把它当成「没有」的调用方自己接住，并在那一处写明为什么。
   */
  async read(id: string): Promise<T | null> {
    // `path()` 留在 try 外面：id 逃出目录是调用方的错，该抛，不该被当成「没有这一条」
    const p = this.path(id);
    try {
      return JSON.parse(await fs.readFile(p, "utf-8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** 写入实体（创建或更新） */
  async write(entity: T): Promise<void> {
    // `mkdir(recursive)` 幂等，不必先探测目录在不在
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.path(entity.id), JSON.stringify(entity, null, 2), "utf-8");
  }

  /** 删除实体；本来就不存在算成功，删不掉（权限等）照抛 */
  async delete(id: string): Promise<void> {
    try {
      await fs.unlink(this.path(id));
    } catch (error) {
      // 只有 ENOENT 可以当「已经没有了」；EACCES / EPERM / EISDIR 必须报 ——
      // 吞了它们，调用方会把「没删掉」当成「删掉了」（宿主那边就会回 `removed: true`）
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
