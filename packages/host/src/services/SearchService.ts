/**
 * 搜索服务：按名称找对话、按聊天内容全文找消息，都能按 Workspace 过滤。
 *
 * 对应能力编号：F-C6 / D16（名称搜索 + 全文搜索 + 项目过滤；中文分词成本接受）。
 *
 * 两条实现上的边界：
 *   1. 全文检索走 `MessageRepository.search`（FTS5 trigram，短查询它自己退化到 `LIKE`），
 *      服务层不写 SQL、也不自己分词 —— 分词口径随库一起改。
 *   2. 对话命中的形状要和侧栏一致（`ConversationSummary`），所以摘要由
 *      {@link ConversationSummarizer} 注入，服务之间不各自拼一份。
 */

import type { ConversationRepository } from "../storage/ConversationRepository.js";
import type { MessageRepository } from "../storage/MessageRepository.js";
import type { Conversation, MessageSearchHit, MessageSearchScope } from "../storage/types.js";
import { HostError } from "../wire/errors.js";
import type {
  ConversationSummary,
  MessageHit,
  SearchConversationsParams,
  SearchConversationsResult,
  SearchMessagesParams,
  SearchMessagesResult,
} from "../wire/index.js";
import { toCoreRole } from "./MessageService.js";

/**
 * 把一批对话行拼成侧栏摘要；入参顺序即出参顺序。
 *
 * 实现由 `ConversationService.summarize` 提供 —— 搜索命中里的对话与侧栏里的同一段对话，
 * 必须长得一模一样（消息数、是否在跑、有没有问题挂着）。
 */
export type ConversationSummarizer = (rows: Conversation[]) => Promise<ConversationSummary[]>;

/** 搜索服务依赖 */
export interface SearchServiceDeps {
  conversations: ConversationRepository;
  messages: MessageRepository;
  summarize: ConversationSummarizer;
}

/** 一次搜索默认返回多少条 */
const DEFAULT_LIMIT = 20;
/** 一次搜索最多返回多少条（再大对界面也没有意义，还会把传输撑起来） */
const MAX_LIMIT = 100;

/** 时间戳转 wire 上的 ISO 8601 */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** `limit` 缺省与上限都收在这里，两个方法共用 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

/** 名字里命中的那一段（供高亮）：找不到时回查询词本身 */
function matchedSegment(name: string, query: string): string {
  const index = name.toLowerCase().indexOf(query.toLowerCase());
  return index < 0 ? query : name.slice(index, index + query.length);
}

export class SearchService {
  // 字段名带 `Repo` 后缀：`conversations` / `messages` 已经是方法名（对应 `search.*`）
  private readonly conversationRepo: ConversationRepository;
  private readonly messageRepo: MessageRepository;
  private readonly summarize: ConversationSummarizer;

  constructor(deps: SearchServiceDeps) {
    this.conversationRepo = deps.conversations;
    this.messageRepo = deps.messages;
    this.summarize = deps.summarize;
  }

  /**
   * 按名字搜对话（PRD F-C6 / D16）。
   *
   * 名字搜索走子串匹配而不是全文索引：名字短，还要能搜到一两个字的查询。空查询直接回空
   * 结果（用户还没输入完），不当作错误。
   */
  async conversations(params: SearchConversationsParams): Promise<SearchConversationsResult> {
    const query = typeof params.query === "string" ? params.query.trim() : "";
    if (query.length === 0) return { hits: [] };

    const rows = await this.conversationRepo.searchByName(
      query,
      params.workspaceId,
      clampLimit(params.limit),
    );
    const summaries = await this.summarize(rows);
    if (summaries.length !== rows.length) {
      throw new HostError("internal", {
        detail: {
          reason: "summarizer returned a different number of rows",
          rows: rows.length,
          summaries: summaries.length,
        },
      });
    }
    return {
      hits: rows.map((row, index) => ({
        conversation: summaries[index] as ConversationSummary,
        matchedName: matchedSegment(row.name, query),
      })),
    };
  }

  /**
   * 按聊天内容全文搜消息（PRD F-C6 / D16）。
   *
   * 过滤范围：给了 `conversationId` 就搜这一段对话，否则给了 `workspaceId` 就搜这个项目下
   * 的全部对话，都没给就是不限范围。
   *
   * `offset` 由服务层切片：仓储的搜索按相关度/时间排好序后一次取 `offset + limit` 条，
   * 这里再切掉前 `offset` 条。于是 `total` 在不超过「取数上限」时是准确的条数，超过时是
   * 一个下界（仓储没有单独的数数入口，见 `PRD.md` R36）。
   */
  async messages(params: SearchMessagesParams): Promise<SearchMessagesResult> {
    const query = typeof params.query === "string" ? params.query.trim() : "";
    if (query.length === 0) return { hits: [], total: 0 };

    const limit = clampLimit(params.limit);
    const offset = params.offset === undefined || !Number.isFinite(params.offset)
      ? 0
      : Math.max(Math.trunc(params.offset), 0);
    const scope = this.scopeOf(params);
    const fetched = await this.messageRepo.search(scope, query, offset + limit);
    const page = fetched.slice(offset);
    const capped = fetched.length >= offset + limit;

    return {
      hits: page.map((hit) => this.toMessageHit(hit)),
      total: capped ? offset + limit : fetched.length,
    };
  }

  private scopeOf(params: SearchMessagesParams): MessageSearchScope {
    if (params.conversationId !== undefined && params.conversationId.length > 0) {
      return { conversationId: params.conversationId };
    }
    if (params.workspaceId !== undefined && params.workspaceId.length > 0) {
      return { workspaceId: params.workspaceId };
    }
    return undefined;
  }

  private toMessageHit(hit: MessageSearchHit): MessageHit {
    return {
      conversationId: hit.conversationId,
      conversationName: hit.conversationName,
      messageId: hit.id,
      role: toCoreRole(hit.role),
      snippet: hit.snippet,
      createdAt: iso(hit.createdAt),
    };
  }
}
