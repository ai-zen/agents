import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Draft } from "../types";

const CURRENT_DRAFT = "_current.json";

function draftPath(dir: string, conversationId?: string): string {
  return join(dir, conversationId ? `${conversationId}.json` : CURRENT_DRAFT);
}

export function readDraft(dir: string, conversationId?: string): Draft | null {
  const path = draftPath(dir, conversationId);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Draft;
  } catch {
    return null;
  }
}

export function writeDraft(dir: string, draft: Draft): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    draftPath(dir, draft.conversationId),
    JSON.stringify(draft, null, 2),
    "utf-8",
  );
}

export function deleteDraft(dir: string, conversationId?: string): void {
  const path = draftPath(dir, conversationId);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
