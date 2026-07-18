import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
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

  read(conversationId?: string): Draft | null {
    const p = this.path(conversationId);
    if (!existsSync(p)) return null;

    try {
      return JSON.parse(readFileSync(p, "utf-8")) as Draft;
    } catch {
      return null;
    }
  }

  write(draft: Draft): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    writeFileSync(
      this.path(draft.conversationId),
      JSON.stringify(draft, null, 2),
      "utf-8",
    );
  }

  delete(conversationId?: string): void {
    const p = this.path(conversationId);
    if (existsSync(p)) {
      unlinkSync(p);
    }
  }
}
