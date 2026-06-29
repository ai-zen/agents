import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { AgentNS } from "@ai-zen/agents-core";
import { ensureConfigDir, CONFIG_DIR } from "./config.js";

// ==================== 草稿路径 ====================

const DRAFT_FILE = join(CONFIG_DIR, "draft.json");

// ==================== 草稿数据结构 ====================

export interface DraftData {
  modelId: string;
  agentId?: string;
  updatedAt: string;
  messages: AgentNS.Message[];
  messageCount: number;
}

// ==================== 读写草稿 ====================

export function readDraft(): DraftData | null {
  ensureConfigDir();
  if (!existsSync(DRAFT_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(DRAFT_FILE, "utf-8"));
    if (!data.messages || !Array.isArray(data.messages) || data.messages.length === 0) {
      return null;
    }
    return {
      modelId: data.modelId || "unknown",
      agentId: data.agentId,
      updatedAt: data.updatedAt || new Date().toISOString(),
      messages: data.messages,
      messageCount: data.messages.length,
    };
  } catch {
    return null;
  }
}

export function saveDraft(
  messages: AgentNS.Message[],
  modelId: string,
  agentId?: string,
): void {
  ensureConfigDir();
  // 只保存有实质内容的对话（至少有一条非 system 消息）
  const nonSystem = messages.filter((m) => m.role !== "system");
  if (nonSystem.length === 0) {
    // 没有实质内容，删除草稿
    clearDraft();
    return;
  }
  const data: DraftData = {
    modelId,
    agentId,
    updatedAt: new Date().toISOString(),
    messages,
    messageCount: messages.length,
  };
  writeFileSync(DRAFT_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function clearDraft(): void {
  if (existsSync(DRAFT_FILE)) {
    unlinkSync(DRAFT_FILE);
  }
}
