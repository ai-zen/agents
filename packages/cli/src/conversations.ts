import chalk from "chalk";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { AgentNS } from "@ai-zen/agents-core";
import { ConversationData } from "./types.js";
import { ensureConfigDir, CONVERSATIONS_DIR } from "./config.js";

// ==================== 对话管理 ====================

function sanitizeFileName(name: string): string {
  // 只移除真正不允许在文件名中使用的字符: \ / : * ? " < > |
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

export function getConversationsList(): ConversationData[] {
  ensureConfigDir();
  const conversations: ConversationData[] = [];

  if (!existsSync(CONVERSATIONS_DIR)) return conversations;

  const files = readdirSync(CONVERSATIONS_DIR);

  for (const file of files) {
    if (file.endsWith(".json")) {
      const filePath = join(CONVERSATIONS_DIR, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        const data = JSON.parse(content);
        conversations.push({
          id: file.replace(/\.json$/, ""),
          name: data.name || file.replace(/\.json$/, ""),
          modelId: data.modelId || "unknown",
          agentId: data.agentId,
          createdAt: data.createdAt || new Date().toISOString(),
          updatedAt:
            data.updatedAt || data.createdAt || new Date().toISOString(),
          messages: data.messages || [],
          messageCount: (data.messages || []).length,
        });
      } catch (error) {
        console.error(
          chalk.red(`读取对话文件失败 ${file}: ${error}`),
        );
      }
    }
  }

  // 按更新时间排序
  return conversations.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export function saveConversation(
  name: string,
  messages: AgentNS.Message[],
  modelId: string,
  existingId?: string,
  agentId?: string,
): string {
  ensureConfigDir();

  // 使用用户提供的名称作为 id，只处理文件名非法字符
  const id = existingId || sanitizeFileName(name);
  const filePath = join(CONVERSATIONS_DIR, `${id}.json`);

  const data: any = {
    name,
    id,
    modelId,
    agentId,
    createdAt: existingId ? undefined : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages,
  };

  // 如果是更新现有对话，保留创建时间
  if (existingId) {
    const existingPath = join(CONVERSATIONS_DIR, `${existingId}.json`);
    if (existsSync(existingPath)) {
      const existingData = JSON.parse(readFileSync(existingPath, "utf-8"));
      data.createdAt = existingData.createdAt;
    }
  }

  writeFileSync(filePath, JSON.stringify(data, null, 2));
  return id;
}

export function loadConversation(id: string): ConversationData {
  ensureConfigDir();
  const filePath = join(CONVERSATIONS_DIR, `${id}.json`);

  if (!existsSync(filePath)) {
    throw new Error(`对话 "${id}" 不存在`);
  }

  const content = readFileSync(filePath, "utf-8");
  const data = JSON.parse(content);
  return {
    id: data.id,
    name: data.name,
    modelId: data.modelId,
    agentId: data.agentId,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    messages: data.messages,
    messageCount: (data.messages || []).length,
  };
}

export function deleteConversation(id: string): void {
  ensureConfigDir();
  const filePath = join(CONVERSATIONS_DIR, `${id}.json`);

  if (!existsSync(filePath)) {
    throw new Error(`对话 "${id}" 不存在`);
  }

  unlinkSync(filePath);
}
