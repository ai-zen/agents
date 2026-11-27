export type NoticeLevel = "info" | "success" | "warning" | "error";

/**
 * 一条通知：一行记录，落库，时间一律是 epoch 毫秒。
 *
 * `message` 是产生那一刻按当时的语言渲染好的成品句子，库里存的就是这一句。存「键 + 参数」、
 * 到出口再按语言渲染，前提是同一个进程里可能同时存在几种语言 —— 这个前提不存在，所以这里
 * 没有 `params` 那一格。代价是用户之后改了语言，旧通知保留旧语言。
 */
export interface NoticeRecord {
  id: string;
  level: NoticeLevel;
  /** 给客户端做条件判断、给日志分类，不用于匹配文案 */
  code: string;
  message: string;
  /** `null` 表示永久：只能手动清，重启之后还在 */
  durationMs: number | null;
  /** `null` 表示全局：不属于任何一段会话，所以按会话列的时候也在其中 */
  sessionId: string | null;
  createdAt: number;
}
