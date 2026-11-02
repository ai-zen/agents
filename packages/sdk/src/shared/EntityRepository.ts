import { promises as fs } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * 通用实体仓储 — 对磁盘 JSON 文件的 CRUD 操作。
 *
 * 约定：
 *   - 每个实体一个 JSON 文件，文件名 = `${id}.json`
 *   - 目录不存在时自动创建
 *   - 解析失败的文件会被跳过（list 时）
 */
export class EntityRepository<T extends { id: string }> {
  constructor(private dir: string) {}

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

  /** 列出目录下所有实体（跳过解析失败的文件） */
  async list(): Promise<T[]> {
    try {
      await fs.access(this.dir);
    } catch {
      return [];
    }

    const entries = await fs.readdir(this.dir);
    const ids = entries
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));

    const entities: T[] = [];
    for (const id of ids) {
      const entity = await this.read(id);
      if (entity) entities.push(entity);
    }
    return entities;
  }

  /** 读取单个实体，不存在返回 null */
  async read(id: string): Promise<T | null> {
    const p = this.path(id);
    try {
      await fs.access(p);
    } catch {
      return null;
    }

    try {
      const raw = await fs.readFile(p, "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** 写入实体（创建或更新） */
  async write(entity: T): Promise<void> {
    try {
      await fs.access(this.dir);
    } catch {
      await fs.mkdir(this.dir, { recursive: true });
    }
    await fs.writeFile(this.path(entity.id), JSON.stringify(entity, null, 2), "utf-8");
  }

  /** 删除实体，不存在时不抛异常 */
  async delete(id: string): Promise<void> {
    const p = this.path(id);
    try {
      await fs.access(p);
      await fs.unlink(p);
    } catch {
      // 文件不存在，忽略
    }
  }
}
