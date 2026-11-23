import type { DatabaseSync } from "node:sqlite";

import { AgentNS } from "@ai-zen/agents-core";

import { transaction } from "../../infra/db.js";
import { messageTable } from "./messages.js";
import { sessionTable } from "./table.js";
import type { SessionRecord } from "./types.js";

/**
 * 换记忆要的那一批：旧记忆成为另一段会话，原会话换上新的那一份。
 *
 * 三样合起来是一件事，所以只有一个入参：拆开传就会有人只做其中一两步，而那正是
 * 「旧的已存档、新的没上岗」的来源。
 */
export interface MemoryReplacement {
  /** 记忆要换掉的那一段，id 不变 */
  readonly sessionId: string;
  /** 存档那一段的会话行：身份照抄原会话，id / 名字 / 创建时刻是新的 */
  readonly archived: SessionRecord;
  /**
   * 换完之后这段记忆**就是**这一份，含开头那几条系统提示。
   *
   * 这一波没有外部调用者：下一波由 SDK 的 `commitMemory` 接缝把 `migrate()` 算好的那一份递进来。
   */
  readonly memory: readonly AgentNS.Message[];
  /**
   * `memory` 开头有几条是 AgentDefinition 带来的系统提示（`agent.definition.messages.length`）。
   *
   * 这几条不落行：装载时由 `createAgent` 装上，行接在它们后面；落成行，下一次装载就会多一份。
   * 由一个数字说清，而不是在这里按形状猜——模板不一定是「连续的非 hidden system」
   *（出厂 subagent 定义就是 `[System, User("{{task}}")]`），按形状猜会把模板剩下的那一半
   * 当消息行写库，下一次装载提示词就翻倍，而且不报错。
   */
  readonly templateCount: number;
}

/**
 * 一批提交，三步的顺序不能换：
 *   1. 插存档会话行；
 *   2. 把原会话的**全部消息行**改挂到存档名下 —— `seq` / `createdAt` 一个字不动，搬的是归属。
 *      它必须排在第一步之后：消息行上有指向会话行的外键，存档那一行不存在时改挂会直接被拒；
 *   3. 按数组顺序写回新记忆的那几条行。此时原会话已经腾空，`seq` 由 `messages` 表从 1 开始给。
 *
 * 整个函数一个事务：只成前几步就会留下「旧记忆已经存档、原会话却空着」的第三种状态，
 * 而失败时整批退回，连那段存档会话都不留。
 *
 * 写回的那几条里有一格要留神：`messages` 的主键是消息 id，而记忆里可能带着库里已有的 id
 * （`omit` 策略把旧消息留在记忆里）。宿主用的策略是 `prune`，旧记忆整段搬去存档，所以这里
 * 不会撞上；真撞上时那条 upsert 只换正文、不改归属，原会话就会缺这一条。
 */
export function replaceMemory(db: DatabaseSync, input: MemoryReplacement): void {
  const sessions = sessionTable(db);
  const messages = messageTable(db);

  transaction(db, () => {
    sessions.put(input.archived);
    db.prepare("UPDATE messages SET sessionId = ? WHERE sessionId = ?").run(
      input.archived.id,
      input.sessionId,
    );

    // 开头那几条是 AgentDefinition 带来的系统提示，避开它们；断点也是 system，但它 `hidden`——
    // 它不是模板，是上一代留下的路标，得是行。
    for (const message of input.memory.slice(input.templateCount))
      messages.upsert(input.sessionId, message);
  });
}
