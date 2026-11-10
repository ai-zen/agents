/**
 * MCP 配置的**形状**（不含读写）—— 客户端侧唯一的一份。
 *
 * ## 为什么它在这里，而不在 CLI 的 `config.ts`
 *
 * 这三个类型是「`mcp.json` 长什么样」的词汇表，而读写它的两端是同一件事的两个人：服务端
 * 落盘（`config.mcp.get` / `config.mcp.save`），客户端整形（编辑屏、`/mcp` 命令）。
 * 留在 CLI 里的话，桌面端要复用就得抄一份 —— 抄出来的两份迟早对不上（`oauth` 展开字段、
 * 厂商扩展字段这类「原样保留」的部分最容易漂）。
 *
 * 路径（`mcpConfigPath()`）、目录布局（`AI_ZEN_DIR`）**不**在这里：那是**某一台机器**的
 * 本地布局，两端各有一份，且本来就不该相同（两机部署时客户端的 `~/.ai-zen/mcp.json`
 * 与服务端那份不是一个文件）。
 *
 * ## `McpScope` 从协议转出
 *
 * 它同时是线上参数（`ConfigMcpGetParams.scope`）与本地词汇，所以定义只有协议那一处
 * （`@ai-zen/agents-protocol` 的 `config.ts`），这里只做透传。
 */

import type { McpScope } from "@ai-zen/agents-protocol";

export type { McpScope };

/**
 * 单个 MCP 服务器条目（业界标准字段，外加保留未知字段）。
 *
 * 与 SDK `discoverMcpServers` 的解析一致：`type` 缺省时按 command/url 推断，
 * `disabled: true` 会被跳过。
 */
export interface McpServerEntry {
  /** 传输方式，业界标准字段名 `type`（缺省按 command/url 推断） */
  type?: "stdio" | "http" | "sse";
  /** 是否禁用（true 时 SDK 会跳过该服务器） */
  disabled?: boolean;
  /** 描述（供 `load_mcp` 呈现给 LLM，非连接必需） */
  description?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** OAuth 配置（CLI 暂不单独编辑，读写时原样保留） */
  oauth?: Record<string, unknown>;
  /** 其它未知字段原样保留，避免写回时丢字段（如 oauth 展开字段、厂商扩展） */
  [key: string]: unknown;
}

export interface McpServersMap {
  [name: string]: McpServerEntry;
}

export interface McpConfig {
  /** 业界标准 `mcpServers` 顶层字段（与 SDK `@ai-zen/agents-sdk` 保持一致） */
  mcpServers: McpServersMap;
}

/**
 * 读一份 `mcp.json` 的结果 —— 与协议里的 `ConfigMcpGetResult` **同形**，但把
 * `config` 从 `unknown` 收窄成 {@link McpConfig}。
 *
 * 「文件不存在」与「读取 / 解析失败」必须分开：前者是正常的空配置，后者是文件已损坏。
 * 以前两者都返回 `{ mcpServers: {} }`，于是损坏的文件在配置中心里看起来「没有服务器」，
 * 用户一保存就把原内容整个覆盖掉 —— 静默丢数据。
 *
 * `path` 是**那个文件在服务端的位置**（客户端只负责把它印在编辑屏上）：客户端的
 * `~/.ai-zen/mcp.json` 与服务端那份不是一个文件，两机部署时更可能根本不存在。
 *
 * 这就是「协议不认识 SDK、客户端把它收回来」的那条边界在本文件上的落点：线上传
 * `unknown`，客户端兑现成类型 —— 与 `config.get` 的 `config as AppConfig` 同一个手法。
 */
export type McpReadResult =
  { ok: true; config: McpConfig; path: string } | { ok: false; error: string; path: string };
