/**
 * `notice.*` 的入参形状 —— **唯一真相**。
 *
 * 三条：`list`（现在该显示哪些）、`dismiss`（清掉一条）、`clear`（清掉一批）。通知是独立通道、
 * 持久化、可手动清（PRD L3 / F-I8），所以这三条全是读/删，没有「新建」—— 建通知是宿主自己
 * 的事（`NoticeService.create`），不是客户端能调的方法。
 *
 * 这一层只回答形状：`noticeId` 空不空、`level` 在不在那四档里。库里有没有这条、`sessionId`
 * 对应哪一段，都是服务层的事（`NoticeService` 那边 `dismiss` 拿不到就回 `dismissed: false`，
 * 不报错 —— 那是它的既有口径，这里不重复判）。
 */

import { z } from "zod";

import { NOTICE_LEVELS } from "../states.js";
import { sessionIdSchema } from "./session.js";

/** `not_an_object`：与 `session.ts` / `WsHub.asRecord` 同一个词 */
const OBJECT_ERROR = { error: "not_an_object" } as const;

// ---------------------------------------------------------------------------
// 可复用的形状
// ---------------------------------------------------------------------------

/**
 * 一条通知的 id：非空字符串，两侧空白不算内容。
 *
 * reason 用既有的 `empty` —— `NoticeService.dismiss` 原来就是拿这个词拒空 id 的，一个字没换。
 */
export const noticeIdSchema = z.string("empty").trim().min(1, "empty");

/**
 * 通知的四档语气（`NoticeLevel`）：`info` / `success` / `warning` / `error`（PRD 4.9）。
 *
 * 直接吃 `NOTICE_LEVELS` 那张表，不在这里再抄一遍字面量 —— 抄出来的第二份迟早与
 * `states.ts` 那一条对不上。失败文案是 `bad_value`（与 Zod 自带的
 * `Invalid option: expected one of …` 那句英文划清界限）。
 */
export const noticeLevelSchema = z.enum(NOTICE_LEVELS, "bad_value");

// ---------------------------------------------------------------------------
// notice.*
// ---------------------------------------------------------------------------

/**
 * `notice.list` 入参：可选的会话 + 可选的语气。
 *
 * 两个都是 `?:`，所以都是 `.optional()`（**不是** `.nullable()`：入参里没有 `null` 这一档，
 * `null` 该被拒）。
 *
 * 两个过滤条件语义不同，别以为是同一回事：
 *   - `sessionId`：那一段的 **+ 全局的**（`sessionId: null` 的通知不属于任何会话，哪儿都得看得见）；
 *   - `level`：只按语气筛。
 * 两条筛法都留在 `NoticeService.list` —— 那是业务判断，这里只管「给了个像样的值没有」。
 */
export const noticeListParams = z.object(
  {
    sessionId: sessionIdSchema.optional(),
    level: noticeLevelSchema.optional(),
  },
  OBJECT_ERROR,
);

/** `notice.dismiss` 入参：清掉哪一条 */
export const noticeDismissParams = z.object({ noticeId: noticeIdSchema }, OBJECT_ERROR);

/**
 * `notice.clear` 入参：清掉哪一段的（不给就清全部）。
 *
 * `undefined` 与「清全部」是同一件事，这是既有语义（`NoticeService.clear` 里第一个分支），
 * 所以这里只校「给了就得是个像样的会话 id」。
 */
export const noticeClearParams = z.object(
  {
    sessionId: sessionIdSchema.optional(),
  },
  OBJECT_ERROR,
);
