/**
 * 英文文案。**键就是那句中文原文**，值是对应的英文。
 *
 * 用原文当键，是为了不另维护一份键清单：多一份清单，就多一份会和原文对不上的账。
 * 代价是改一个中文字就失配，所以缺译文时回落成原文，不抛。
 */
export const en: Record<string, string> = {
  "找不到 id 为 {sessionId} 的会话": 'Cannot find the session "{sessionId}"',
};
