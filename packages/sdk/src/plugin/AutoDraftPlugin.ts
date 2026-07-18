import type { Draft } from "../types/index.js";
import type { AgentPlugin, SendContext } from "../runtime/SdkAgent.js";
import { DraftRepository } from "../crud/DraftRepository.js";
import { createLogger } from "../shared/logger.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import dayjs from "dayjs";

const log = createLogger();

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
      repo.write(draft);
    } catch (err: any) {
      log.error(`[autoDraft] 保存失败: ${err?.message ?? err}`);
    }
  }

  static checkDraftForRestore(draftsDir: string): Draft | null {
    const path = join(draftsDir, CURRENT_DRAFT);
    if (!existsSync(path)) return null;

    const repo = new DraftRepository(draftsDir);
    const draft = repo.read();
    if (!draft) return null;

    const age = dayjs().diff(dayjs(draft.updatedAt), "day");
    if (age > EXPIRE_DAYS) {
      repo.delete();
      return null;
    }

    return draft;
  }
}
