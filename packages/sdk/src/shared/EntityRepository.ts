import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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

  /** 获取实体的文件路径 */
  protected path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** 列出目录下所有实体（跳过解析失败的文件） */
  list(): T[] {
    if (!existsSync(this.dir)) return [];

    const ids = readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));

    const entities: T[] = [];
    for (const id of ids) {
      const entity = this.read(id);
      if (entity) entities.push(entity);
    }
    return entities;
  }

  /** 读取单个实体，不存在返回 null */
  read(id: string): T | null {
    const p = this.path(id);
    if (!existsSync(p)) return null;

    try {
      const raw = readFileSync(p, "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** 写入实体（创建或更新） */
  write(entity: T): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    writeFileSync(this.path(entity.id), JSON.stringify(entity, null, 2), "utf-8");
  }

  /** 删除实体，不存在时不抛异常 */
  delete(id: string): void {
    const p = this.path(id);
    if (existsSync(p)) {
      unlinkSync(p);
    }
  }
}
