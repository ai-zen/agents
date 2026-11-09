/**
 * 老存档搬家 —— 把会话从「前端目录」搬进「工作区目录」。
 *
 *   旧：`<aiZenDir>/cli/conversations/<id>.json`      所有工作目录混放，靠记录里的 `cwd` 归属
 *       `<aiZenDir>/cli/last-session.json`            `{ sessions: { <cwd>: { id, updatedAt } } }`
 *
 *   新：`<aiZenDir>/workspaces/<workspaceId>/conversations/<id>.json`
 *       `<aiZenDir>/workspaces/<workspaceId>/last-session.json`   `{ version, id, updatedAt }`
 *
 * ## 三条纪律
 *
 * 1. **只搬，不删**：每份会话先在新位置原子写完，再删旧的。中途被杀最多留下两份副本
 *    （可读、无损），下次跑再覆盖一遍再删 —— 幂等。
 * 2. **归不了位的原地不动**：记录里没有 `cwd` 就判不出属于哪个工作区。这种文件留在
 *    原地并报出来，**绝不**猜一个工作区塞进去，也绝不删。
 * 3. **跑完什么都不剩就是跑完了**：旧目录空了、旧指针删了，重复调用自然变成空操作，
 *    不需要额外的「已迁移」标记文件（标记文件本身才是要维护的状态）。
 */

import { promises as fs, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { FileConversationStore } from "./FileConversationStore.js";
import type { Conversation } from "./ConversationStore.js";
import { ensureWorkspace } from "../workspace/workspace.js";

export interface LegacyMigrationOptions {
  /** 旧的会话目录（`<aiZenDir>/cli/conversations`） */
  legacyConversationsDir: string;
  /** 旧的指针文件（`<aiZenDir>/cli/last-session.json`） */
  legacyPointerFile: string;
  /** 新的工作区父目录（`<aiZenDir>/workspaces`） */
  workspacesRoot: string;
  /** 每搬一份的回调（日志用） */
  onMoved?: (info: { id: string; workspaceId: string; from: string }) => void;
}

export interface LegacyMigrationResult {
  /** 搬过去的会话数 */
  moved: number;
  /** 重建的「上一轮会话」指针数 */
  pointers: number;
  /** 无法归位、原地未动的会话 id */
  unattributed: string[];
}

export async function migrateLegacyConversations(
  options: LegacyMigrationOptions,
): Promise<LegacyMigrationResult> {
  const result: LegacyMigrationResult = { moved: 0, pointers: 0, unattributed: [] };

  for (const source of await collectConversationFiles(options.legacyConversationsDir)) {
    const legacy = await readLegacyConversation(source.absolute);
    const cwd = typeof legacy?.cwd === "string" && legacy.cwd ? legacy.cwd : null;
    if (!cwd) {
      // 没有归属信息：留住原文件，报出来（人还能自己认领）
      result.unattributed.push(source.id);
      continue;
    }

    const workspace = await ensureWorkspace({ workspacesRoot: options.workspacesRoot, path: cwd });
    const store = new FileConversationStore({ rootDir: workspace.rootDir });
    await store.write(toConversation(source.id, legacy));
    await fs.rm(source.absolute, { force: true });

    result.moved++;
    options.onMoved?.({ id: source.id, workspaceId: workspace.id, from: source.absolute });
  }

  result.pointers = await migratePointerFile(options);
  await removeDirIfEmpty(options.legacyConversationsDir);
  return result;
}

/**
 * 旧记录 → 新记录：**白名单**重建，不是删字段。
 *
 * 白名单的好处是已废弃的 `cwd` / `modelId` 不可能漏过来 —— 搬过去之后，会话内容里
 * 再也查不到一个和事实已经无关的目录路径。
 */
function toConversation(id: string, legacy: any): Conversation<unknown> {
  return {
    id,
    agentId: typeof legacy?.agentId === "string" && legacy.agentId ? legacy.agentId : "default",
    messages: Array.isArray(legacy?.messages) ? legacy.messages : [],
    ...(typeof legacy?.lastPromptTokens === "number"
      ? { lastPromptTokens: legacy.lastPromptTokens }
      : {}),
  };
}

/**
 * 旧指针文件 → 每个工作区一份单指针。
 *
 * 顺序要紧：**先**搬会话、**后**搬指针 —— 指针只在会话确实落到新位置后才写，
 * 否则下次启动会续接到一个读不到文件的 id。
 */
async function migratePointerFile(options: LegacyMigrationOptions): Promise<number> {
  let parsed: any;
  try {
    parsed = JSON.parse(await fs.readFile(options.legacyPointerFile, "utf-8"));
  } catch {
    return 0; // 没有旧指针文件（新装用户）：正常
  }

  // 旧版单指针（顶层 id、无 sessions）无法归属到目录，一律丢弃：宁可丢一次续接，
  // 也不把别的目录的历史错认成当前目录的。
  const sessions = parsed?.sessions;
  if (!sessions || typeof sessions !== "object") {
    await fs.rm(options.legacyPointerFile, { force: true });
    return 0;
  }

  let migrated = 0;
  for (const [cwd, entry] of Object.entries(sessions as Record<string, unknown>)) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !id) continue;

    const workspace = await ensureWorkspace({ workspacesRoot: options.workspacesRoot, path: cwd });
    const store = new FileConversationStore({ rootDir: workspace.rootDir });
    // 会话没搬过去 / 早被删了：不写指针，免得下次续接到空
    if (!(await store.exists(id))) continue;
    await store.setLastSession(id);
    migrated++;
  }

  await fs.rm(options.legacyPointerFile, { force: true });
  return migrated;
}

interface CollectedFile {
  /** 相对会话目录的路径（去掉 `.json`）即会话 id —— `/save a/b` 那种带子目录的也在内 */
  id: string;
  absolute: string;
}

/** 找出旧目录下所有会话文件（递归：`/save 项目/a` 会产生子目录） */
async function collectConversationFiles(dir: string): Promise<CollectedFile[]> {
  const collected: CollectedFile[] = [];

  async function walk(current: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return; // 旧目录不存在：没有历史可搬
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      // 只认普通文件：软链可能是用户自己指到别处的东西，搬它等于替用户做决定
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      collected.push({ id: relative(dir, absolute).slice(0, -".json".length), absolute });
    }
  }

  await walk(dir);
  return collected;
}

async function readLegacyConversation(path: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

/** 旧目录搬空就收掉；里面还有归不了位的东西时留着（不能替用户丢数据） */
async function removeDirIfEmpty(dir: string): Promise<void> {
  try {
    await fs.rmdir(dir);
  } catch {
    /* 非空 / 不存在：都不是错误 */
  }
}
