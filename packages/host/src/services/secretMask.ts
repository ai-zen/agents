/**
 * 密钥掩码 —— 端点密钥与 MCP 的 oauth `clientSecret` 共用这一份（F-F2：明文不出网）。
 *
 * 两处密钥的读写口径完全一样，所以生成掩码与「识别入参是不是掩码」都只在这里写一次：
 *
 *   1. **读**：宿主返回给客户端的永远是 {@link maskSecret} 的结果，明文一个字节都不出网；
 *   2. **写**：客户端「没改」用省略表达；万一它把读到的掩码原样写回来了，
 *      {@link isSecretMask} 认得出来，宿主按磁盘原文保留，不会把掩码当密钥存下去。
 *
 * 单独成文件是因为服务的依赖方向是单向的（配置服务 → 发现服务），发现服务不能反向 import
 * 配置服务；掩码这种纯函数放中间，两边都引它。
 */

/**
 * 密钥的掩码（F-F2：明文不出网）。
 *
 * 短密钥整串都掩掉：`sk-1` 这种长度的密钥，露头露尾就等于把整串给人看了。
 */
export function maskSecret(secret: string): string {
  const key = secret.trim();
  if (key === "") return "";
  if (key.length <= 8) return "…";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/**
 * 入参是不是「当前那把密钥的掩码」（客户端把读回来的整行原样写回来时的情形）。
 *
 * 是掩码就当「这一项没改」，写盘时保留原值。当前没有密钥时不存在「掩码」这回事，恒为 false。
 */
export function isSecretMask(incoming: string, current: string): boolean {
  const secret = current.trim();
  return secret !== "" && incoming.trim() === maskSecret(secret);
}
