/**
 * 我们对外怎么自称。
 *
 * 两处用它：MCP 握手里的 `clientInfo`，以及出网请求的 `User-Agent`。分开写两份的话迟早不一致，
 * 而这两格都是对方用来认人的 —— 一边叫 `ai-zen-agents/0.1.0`、另一边叫 `ai-zen-agents`，
 * 对端就分不清是不是同一个客户端。
 *
 * 名字必须是自己的：有些服务方明确要求「用自己的名字，而不是通用 SDK 或 HTTP 库的名字」
 * （OpenCode Go 的门槛之一），拿 `node`、`openai-node` 之类去顶等于没标识。
 */
import { randomUUID } from "node:crypto";

export const CLIENT_NAME = "ai-zen-agents";
export const CLIENT_VERSION = "0.1.0";

/** `name/version`，HTTP 头与 MCP 握手两处通用 */
export const CLIENT_USER_AGENT = `${CLIENT_NAME}/${CLIENT_VERSION}`;

/**
 * 造一个服务方那侧的会话标识（`providerSessionId`）。
 *
 * 它给谁用：服务方拿它做流量路由与 prompt 前缀缓存 —— 同一段上下文发同一串请求，才能命中同一份
 * 缓存。所以口径是「**一个活的 Agent 一个**」：
 *
 * - 一段会话里的主 Agent：宿主把会话 id 直接给它（重启后仍不变，缓存能跨重启复用）；
 * - 派出去的 `SubAgent`：它带的是自己的那份上下文（自己的消息、自己的工具），所以另起一个，
 *   不继承父会话的 —— 拿父的 id 去报自己的请求，等于告诉服务方「这还是那段对话」，
 *   缓存与路由都会指错地方。
 *
 * 叫 `provider…` 是因为它只活在出网那一步：我们自己的会话概念叫 `sessionId`（宿主的），两者
 * 不是同一个东西 —— 后者是一行会话，前者是「服务方眼里的这段上下文」。
 *
 * 前缀 `az-` 让服务方那边一眼能看出是谁的流量；后缀是随机串，不需要可读。
 */
export function newProviderSessionId(): string {
  return `az-${randomUUID()}`;
}
