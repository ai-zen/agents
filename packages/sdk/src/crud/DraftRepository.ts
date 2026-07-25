import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Draft } from "../types/index.js";

const CURRENT_DRAFT = "_current.json";

/**
 * Draft 仓储。
 * Draft 没有 id 字段，文件名基于 conversationId：
 *   - 有 conversationId → ${conversationId}.json
 *   - 无 conversationId → _current.json
 */
export class DraftRepository {
  constructor(private dir: string) {}

  private path(conversationId?: string): string {
    return join(this.dir, conversationId ? `${conversationId}.json` : CURRENT_DRAFT);
  }

  async read(conversationId?: string): Promise<Draft | null> {
    const p = this.path(conversationId);
    try {
      await fs.access(p);
    } catch {
      return null;
    }

    try {
      return JSON.parse(await fs.readFile(p, "utf-8")) as Draft;
    } catch {
      return null;
    }
  }

  async write(draft: Draft): Promise<void> {
    try {
      await fs.access(this.dir);
    } catch {
      await fs.mkdir(this.dir, { recursive: true });
    }
    await fs.writeFile(
      this.path(draft.conversationId),
      JSON.stringify(draft, null, 2),
      "utf-8",
    );
  }

  async delete(conversationId?: string): Promise<void> {
    const p = this.path(conversationId);
    try {
      await fs.access(p);
      await fs.unlink(p);
    } catch {
      // 文件不存在，忽略
    }
  }
}
