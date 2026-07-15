import type { Agent } from "@ai-zen/agents-core";
import type { AgentMessage, Draft } from "../types";
import type { SessionPlugin } from "./types";
import { writeDraft, readDraft, deleteDraft } from "../crud/drafts";
import { createLogger } from "../shared/logger";
import { existsSync } from "node:fs";
import { join } from "node:path";
import dayjs from "dayjs";

const log = createLogger();

export interface AutoDraftOptions {
  /** drafts 目录路径 */
  draftsDir: string;
  /** 当前 Agent ID */
  agentId: string;
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
export function autoDraft(options: AutoDraftOptions): SessionPlugin {
  const { draftsDir, agentId, conversationId, cwd } = options;

  return {
    afterSend: async (ctx) => {
      try {
        const draft: Draft = {
          conversationId,
          agentId,
          modelId: ctx.model.id,
          messages: convertMessages(ctx.agent.messages),
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

  const draft = readDraft(draftsDir); // 无 conversationId → 读 _current.json
  if (!draft) return null;

  const age = dayjs().diff(dayjs(draft.updatedAt), "day");
  if (age > EXPIRE_DAYS) {
    // 过期自动清理
    deleteDraft(draftsDir);
    return null;
  }

  return draft;
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/**
 * 将 Core Agent 的消息转换为 SDK AgentMessage 类型。
 */
function convertMessages(messages: any[]): AgentMessage[] {
  return messages.map((m) => ({
    role: mapRole(m.role),
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }));
}

function mapRole(role: any): "system" | "user" | "assistant" {
  if (role === "system" || role === "user" || role === "assistant") return role;
  return "user"; // tool/function 等 → user
}
