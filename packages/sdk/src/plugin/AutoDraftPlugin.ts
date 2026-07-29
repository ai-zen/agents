import type { Draft } from "../types/index.js";
import type { AgentPlugin, SendContext } from "../runtime/SdkAgent.js";
import { DraftRepository } from "../crud/DraftRepository.js";
import { getLogger } from "../shared/logger.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import dayjs from "dayjs";

const log = getLogger();

export interface AutoDraftOptions {
  draftsDir: string;
  agentId: string;
  modelId: string;
  conversationId?: string;
  cwd?: string;
}

const CURRENT_DRAFT = "_current.json";
const EXPIRE_DAYS = 7;

/**
 * 自动保存 Draft 插件。
 *
 * ```ts
 * agent.use(new AutoDraftPlugin({
 *   draftsDir: "/path/to/drafts",
 *   agentId: "my-agent",
 *   modelId: "gpt-4",
 * }));
 * ```
 */
export class AutoDraftPlugin implements AgentPlugin {
  private options: AutoDraftOptions;

  constructor(options: AutoDraftOptions) {
    this.options = options;
  }

  async onInnerLoopEnd(ctx: SendContext): Promise<void> {
    const { draftsDir, agentId, modelId, conversationId, cwd } = this.options;

    try {
      const draft: Draft = {
        conversationId,
        agentId,
        modelId,
        messages: ctx.agent.messages,
        cwd,
        updatedAt: new Date().toISOString(),
      };

      const repo = new DraftRepository(draftsDir);
      await repo.write(draft);
    } catch (err: any) {
      log.error(`[autoDraft] 保存失败: ${err?.message ?? err}`);
    }
  }

  static async checkDraftForRestore(draftsDir: string): Promise<Draft | null> {
    const path = join(draftsDir, CURRENT_DRAFT);
    try {
      await fs.access(path);
    } catch {
      return null;
    }

    const repo = new DraftRepository(draftsDir);
    const draft = await repo.read();
    if (!draft) return null;

    const age = dayjs().diff(dayjs(draft.updatedAt), "day");
    if (age > EXPIRE_DAYS) {
      await repo.delete();
      return null;
    }

    return draft;
  }
}
