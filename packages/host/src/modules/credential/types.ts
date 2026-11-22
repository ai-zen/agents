/**
 * 一把宿主访问令牌：一行记录，落库。`hash` 是令牌明文的 sha256 —— 库里存明文，等于把「谁读过
 * 这个库」升级成「谁拿到过令牌」，而令牌是这张表唯一有意义的秘密。
 */
export interface Credential {
  id: string;
  /** 人给这一把凭证起的说明，用来区分给谁用 */
  note: string;
  hash: string;
  createdAt: number;
  /** `null` 表示仍然有效 */
  revokedAt: number | null;
}
