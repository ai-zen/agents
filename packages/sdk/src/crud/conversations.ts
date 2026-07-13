import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Conversation } from "../types";

function conversationPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

export function listConversations(dir: string): Conversation[] {
  if (!existsSync(dir)) return [];

  const ids = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));

  const conversations: Conversation[] = [];
  for (const id of ids) {
    const conv = readConversation(dir, id);
    if (conv) conversations.push(conv);
  }
  return conversations;
}

export function readConversation(dir: string, id: string): Conversation | null {
  const path = conversationPath(dir, id);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Conversation;
  } catch {
    return null;
  }
}

export function writeConversation(dir: string, conversation: Conversation): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    conversationPath(dir, conversation.id),
    JSON.stringify(conversation, null, 2),
    "utf-8",
  );
}

export function deleteConversation(dir: string, id: string): void {
  const path = conversationPath(dir, id);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
