import type { Tool } from "@ai-zen/agents-core";
import type { AgentDefinition } from "../../../types/index.js";
import { createPeerSessionTools, PEER_SESSION_TOOL_NAMES } from "./peerSessionTools.js";
import type { PeerSessionPort } from "./peerSessionTools.js";
import type { Scope, FilterOutput } from "../../Scope.js";
import type { ScopeCandidates, ScopePlugin } from "../../ScopePlugin.js";

/**
 * 平级会话插件 —— 把宿主给的端口装成两个工具（`create_session` / `read_session_status`）。
 *
 * 与 `SubAgentsScopePlugin` 同构（`id` / `candidates` / `instantiate`）：自己不发现任何东西
 * （平级会话不是磁盘上的定义，是宿主的运行时能力），候选名是固定的两个。
 *
 * **不给端口就什么都不产出**：`candidates()` 回空、`instantiate()` 回空数组 —— 没有宿主接线
 * 的 SDK 用户（CLI 脚本、用例、只有 Scope 的库使用者）看到的能力面一个字都不变。
 *
 * 为什么能力从端口进来而不是 SDK 自己实现：会话是宿主的财产（id、落库、模型解析、跑一轮、
 * 把结果投回去全在那边），SDK 这一层只认识 Scope 与 Agent 定义。端口是唯一的一处接线，
 * 于是「SDK 不依赖 host」这条分层不用破例。
 */
export class PeerSessionsScopePlugin implements ScopePlugin {
  static readonly ID = "peer-sessions";
  readonly id = PeerSessionsScopePlugin.ID;

  private readonly port?: PeerSessionPort;

  /** 不传端口 = 这个 Scope 没有平级会话能力（老行为） */
  constructor(port?: PeerSessionPort) {
    this.port = port;
  }

  candidates(): ScopeCandidates {
    if (!this.port) return {};
    return { tools: [...PEER_SESSION_TOOL_NAMES] };
  }

  instantiate(_scope: Scope, filtered: FilterOutput): Tool[] {
    if (!this.port) return [];
    const allow = new Set(filtered.tools);
    return createPeerSessionTools(this.port).filter((tool) => allow.has(tool.function.name));
  }
}

export type { PeerSessionPort };
