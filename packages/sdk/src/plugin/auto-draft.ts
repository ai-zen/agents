import type { Draft } from "../types/index.js";
import type { AgentPlugin } from "../runtime/sdk-agent.js";
import { writeDraft, readDraft, deleteDraft } from "../crud/drafts.js";
import { createLogger } from "../shared/logger.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import dayjs from "dayjs";

const log = createLogger();

export interface AutoDraftOptions {
  /** drafts 目录路径 */
  draftsDir: string;
  /** 当前 Agent ID */
  agentId: string;
  /** 使用的模型 ID */
  modelId: string;
  /** 已命名对话 ID（可选，无则保存为 _current.json） */
  conversationId?: string;
  /** 当前工作目录 */
  cwd?: string;
}

const CURRENT_DRAFT = "_current.json";
const EXPIRE_DAYS = 7;

/**
 * 自动保存 Draft 插件：每次 Agent.run() 返回后，将当前消息历史写入 draft 文件。
 */
export function autoDraft(options: AutoDraftOptions): AgentPlugin {
  const { draftsDir, agentId, modelId, conversationId, cwd } = options;

  return {
    onAfterSend: async (ctx) => {
      try {
        const draft: Draft = {
          conversationId,
          agentId,
          modelId,
          messages: ctx.agent.messages,
          cwd,
          updatedAt: new Date().toISOString(),
        };

        writeDraft(draftsDir, draft);
      } catch (err: any) {
        log.error(`[autoDraft] 保存失败: ${err?.message ?? err}`);
      }
    },
  };
}

/**
 * 启动时检查是否存在未过期的草稿（_current.json）。
 * 返回 Draft（7 天内）或 null（不存在/已过期）。
 */
export function checkDraftForRestore(draftsDir: string): Draft | null {
  const path = join(draftsDir, CURRENT_DRAFT);
  if (!existsSync(path)) return null;

  const draft = readDraft(draftsDir);
  if (!draft) return null;

  const age = dayjs().diff(dayjs(draft.updatedAt), "day");
  if (age > EXPIRE_DAYS) {
    deleteDraft(draftsDir);
    return null;
  }

  return draft;
}
