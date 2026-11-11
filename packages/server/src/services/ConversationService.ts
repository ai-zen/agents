/**
 * 对话服务：一段对话的诞生、改名、置顶、删除、撤回，以及两个「临时调整」（换模型、换思考强度）。
 *
 * 对应能力编号：F-C1（稳定 id）、F-C3（可改名字）、F-C5（置顶 + 创建时间倒序）、
 * F-C7（开新会话）、F-C8 / D24（撤回硬删 + 回填输入框）、F-C10 / D17（硬删 + 警告）、
 * F-B4 / L7 / D20（临时换模型只在内存、历史有图时拒绝降级）、F-B6 / F-B7（思考档位）、
 * L5（重连按 id 拉）、L6（id 服务端分配）、R18（身份创建时定死，解析不出就不写库）、
 * R22（消息原样用 core 的类型）。
 *
 * 两条贯穿这个文件的边界：
 *   1. **身份在创建时定死**：`workspaceId` / `agentId` / `modelId` 由 `create` 解析后落库，
 *      此后没有任何方法改它们。临时换模型只把覆盖交给运行时（内存），库里的 `modelId` 不动。
 *   2. **服务层不缓存 agent、不驻留对话状态**：`running`、临时模型覆盖、临时思考档位都从
 *      注入的 {@link ConversationRuntimePort} 现取现放。运行时那边的实现（W2-D）是本进程
 *      唯一持有这些状态的地方。
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { AgentNS, ZERO_USAGE } from "@ai-zen/agents-core";
import { AgentRepository, resolveModel } from "@ai-zen/agents-sdk";
import type {
  AgentDefinition,
  AppConfig,
  ConfigManager,
  Model,
  ModelParams,
  ReasoningPreset,
  ReasoningPresets,
} from "@ai-zen/agents-sdk";

import type { AssetRepository } from "../storage/AssetRepository.js";
import type { ConversationRepository } from "../storage/ConversationRepository.js";
import type { MessageRepository } from "../storage/MessageRepository.js";
import type { QuestionRepository } from "../storage/QuestionRepository.js";
import type { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import type { Conversation, StoredMessage, WorkspaceRow } from "../storage/types.js";
import { ServerError } from "../wire/errors.js";
import type {
  ContextState,
  ConversationCreateParams,
  ConversationCreateResult,
  ConversationDeleteParams,
  ConversationDeleteResult,
  ConversationGetParams,
  ConversationGetResult,
  ConversationListParams,
  ConversationListResult,
  ConversationModelState,
  ConversationPinParams,
  ConversationPinResult,
  ConversationRenameParams,
  ConversationRenameResult,
  ConversationRevertParams,
  ConversationRevertResult,
  ConversationSetModelParams,
  ConversationSetModelResult,
  ConversationSetThinkingParams,
  ConversationSetThinkingResult,
  ConversationSummary,
  ConversationView,
  MessageInput,
  ThinkingState,
} from "../wire/index.js";
import { readUsage, toAgentMessage } from "./MessageService.js";
import { toFolderFact } from "./WorkspaceService.js";

/**
 * 运行时注入给对话服务的窄接口。
 *
 * 这些事实都活在**本进程内存**里，而且只有运行时知道：
 *   - 这段对话现在有没有在跑一轮（PRD F-I3 / D14）；
 *   - 临时换的模型（L7：不进库，重开回默认）；
 *   - 临时调的思考档位（F-B6：会话级调整）；
 *   - 对话被删掉之后，这些内存项该被扔掉。
 *
 * 服务层只按它读写，不 import `runtime/` 里的任何实现、也不自己存一份 —— 两份状态迟早
 * 有一份先漂（D28：agent 用完即弃、对话不驻留）。
 *
 * 取值方法同步（拼一遍列表时要逐条问），写入方法允许异步（运行时可能得先把在跑的那轮
 * 停下来、或让下一次请求重新装配），服务层会 await 它们。
 */
export interface ConversationRuntimePort {
  /** 这段对话现在是否在跑一轮 */
  isRunning(conversationId: string): boolean;
  /** 本进程内的临时模型覆盖；没设过返回 `null` */
  getModelOverride(conversationId: string): string | null;
  /** 设置/清除临时模型覆盖（`null` = 回到创建时定的模型）；不写库 */
  setModelOverride(conversationId: string, modelId: string | null): void | Promise<void>;
  /** 本进程内的临时思考档位；没设过返回 `null` */
  getThinkingOverride(conversationId: string): string | null;
  /** 设置/清除临时思考档位（`null` = 回到助手定义上的那份）；不写库 */
  setThinkingOverride(conversationId: string, level: string | null): void | Promise<void>;
  /** 对话（或它的项目）被删掉之后，把这段对话相关的内存状态扔掉 */
  forget(conversationId: string): void | Promise<void>;
}

/** `conversation.delete` 的结果：wire 字段 + 交给 asset 层按引用清的文件清单 */
export interface ConversationRemovalReport extends ConversationDeleteResult {
  /** 需要 asset 层按引用清掉的文件（数据根下的相对路径，来自 `assets.path`） */
  assetPaths: string[];
}

/** 对话服务的依赖；由单根组装后注入 */
export interface ConversationServiceDeps {
  conversations: ConversationRepository;
  messages: MessageRepository;
  workspaces: WorkspaceRepository;
  assets: AssetRepository;
  questions: QuestionRepository;
  /** 配置唯一入口（SDK）：助手定义在 `<basePath>/agents/`，模型与默认项在 `config.json` 里 */
  configManager: ConfigManager;
  runtime: ConversationRuntimePort;
  /** 时钟，测试注入用；缺省 `Date.now` */
  now?: () => number;
}

/**
 * 一次视图组装的中间状态：配置读一次就够，同一次调用里的项目与助手定义按需补进 map。
 *
 * 它只在一次方法调用内存在（不是服务上的字段），所以不构成「服务层缓存」。
 */
interface ViewContext {
  config: AppConfig;
  presets: ReasoningPresets;
  workspaces: Map<string, WorkspaceRow>;
  agents: Map<string, AgentDefinition | null>;
}

/** 时间戳转 wire 上的 ISO 8601 */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * 对话的原名：创建时间（PRD D2「原名＝创建时间」，起不出名就保持它）。
 *
 * 用本地时区的 `YYYY-MM-DD HH:mm`：这是摆在侧栏里给人看的一句话，不是可排序的机器时间
 * （排序只按 `pinned` + `createdAt`，D13）。
 */
function autoName(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 必填的 id / 名字类参数：空串按「参数不对」处理，不拿它去查库 */
function requireId(value: string, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) {
    throw new ServerError("invalid_params", {
      params: { field },
      detail: { field, reason: "empty" },
    });
  }
  return text;
}

/** 结构相等：思考档位的补丁与助手定义上的参数要能对得上 */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  const leftEntries = Object.entries(left as Record<string, unknown>);
  const rightEntries = Object.entries(right as Record<string, unknown>);
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([key, value]) =>
    deepEqual(value, (right as Record<string, unknown>)[key]),
  );
}

/**
 * 助手定义上的参数是否「就是这一档」：档位补丁的每个键都在，且值相等。
 *
 * 档位展开后写进 `AgentDefinition.modelParams` 的是参数而不是档位名（F-B6），所以读的时候
 * 只能反过来按补丁认档位。补丁允许是定义参数的子集（定义里可能还有与思考无关的参数）。
 */
function matchesPatch(params: ModelParams | undefined, patch: ModelParams): boolean {
  if (!params) return false;
  const entries = Object.entries(patch);
  if (entries.length === 0) return false;
  return entries.every(([key, value]) => deepEqual(params[key], value));
}

export class ConversationService {
  private readonly conversations: ConversationRepository;
  private readonly messages: MessageRepository;
  private readonly workspaces: WorkspaceRepository;
  private readonly assets: AssetRepository;
  private readonly questions: QuestionRepository;
  private readonly configManager: ConfigManager;
  private readonly runtime: ConversationRuntimePort;
  private readonly now: () => number;
  /** 助手定义是文件（PRD F-G3：一实体一文件），按配置根下的 `agents/` 目录读 */
  private readonly agents: AgentRepository;

  constructor(deps: ConversationServiceDeps) {
    this.conversations = deps.conversations;
    this.messages = deps.messages;
    this.workspaces = deps.workspaces;
    this.assets = deps.assets;
    this.questions = deps.questions;
    this.configManager = deps.configManager;
    this.runtime = deps.runtime;
    this.now = deps.now ?? Date.now;
    this.agents = new AgentRepository(join(deps.configManager.basePath, "agents"));
  }

  /**
   * 列表（PRD F-C5 / D13）。
   *
   * 顺序由仓储定死：`pinned DESC, createdAt DESC` —— 活动、打开、改名都不影响它，所以这里
   * 除了按 Workspace / 置顶筛、按 `limit` / `offset` 切页之外，不再重排。
   */
  async list(params: ConversationListParams = {}): Promise<ConversationListResult> {
    const rows = params.workspaceId === undefined
      ? await this.conversations.list()
      : await this.conversations.listByWorkspace(params.workspaceId);

    const filtered = params.pinned === undefined
      ? rows
      : rows.filter((row) => row.pinned === params.pinned);
    const offset = params.offset === undefined ? 0 : Math.max(params.offset, 0);
    const page = params.limit === undefined
      ? filtered.slice(offset)
      : filtered.slice(offset, offset + Math.max(params.limit, 0));

    return { conversations: await this.summarize(page), total: filtered.length };
  }

  /**
   * 开一段新对话（PRD F-C7 / L7 / R18）。
   *
   * 身份三件套在这里定死：项目来自入参，助手从磁盘上的定义文件解析，模型走 SDK 的三级解析
   * （`会话级 > 助手定义 > 配置里的兜底`，唯一实现在 `resolveModel`）。任一解析不出来就报错，
   * 不写半成品行 —— 一条没有助手或没有模型的对话没有可用的身份。
   */
  async create(params: ConversationCreateParams): Promise<ConversationCreateResult> {
    const workspace = await this.requireWorkspace(params.workspaceId);
    const config = await this.readConfig();
    const agent = await this.readAgent(requireId(params.agentId, "agentId"));

    const sessionModelId = params.modelId == null ? undefined : requireId(params.modelId, "modelId");
    const resolved = resolveModel({
      sessionModelId,
      agentModelId: agent.modelId,
      defaultModel: config.defaultModel,
    });
    if (!resolved) {
      throw new ServerError("config_invalid", {
        params: { reason: `assistant "${agent.id}" has no model and no fallback model is set` },
        detail: { agentId: agent.id, defaultModel: config.defaultModel ?? null },
      });
    }
    const model = config.models.find((item) => item.id === resolved.modelId);
    if (!model) {
      // 调用方点名要的模型不存在 → 找不到；配置自己指着不存在的模型 → 配置用不了
      if (resolved.level === "session") {
        throw new ServerError("not_found", {
          params: { entity: "model" },
          detail: { modelId: resolved.modelId, level: resolved.level },
        });
      }
      throw new ServerError("config_invalid", {
        params: {
          reason: `model "${resolved.modelId}" (from ${resolved.level} settings) is not defined`,
        },
        detail: { modelId: resolved.modelId, level: resolved.level, agentId: agent.id },
      });
    }

    const createdAt = this.now();
    const id = randomUUID();
    await this.conversations.create({
      id,
      workspaceId: workspace.id,
      name: autoName(createdAt),
      agentId: agent.id,
      modelId: model.id,
      createdAt,
      updatedAt: createdAt,
    });

    const row = await this.conversations.get(id);
    if (!row) {
      throw new ServerError("internal", {
        detail: { reason: "conversation vanished after insert", id },
      });
    }
    const context = await this.viewContext(
      config,
      [[workspace.id, workspace]],
      [[agent.id, agent]],
    );
    const { view } = await this.composeView(row, context);
    return { conversation: view };
  }

  /** 按 id 打开一段对话（PRD F-A6：服务端只提供「按 id 打开」） */
  async get(params: ConversationGetParams): Promise<ConversationGetResult> {
    const row = await this.requireConversation(params.conversationId);
    const { view } = await this.composeView(
      row,
      await this.viewContext(await this.readConfig()),
    );
    return { conversation: view };
  }

  /** 改名（PRD D1 / F-C3）：只换名字，id、身份与排序都不动 */
  async rename(params: ConversationRenameParams): Promise<ConversationRenameResult> {
    const row = await this.requireConversation(params.conversationId);
    const name = requireId(params.name, "name");
    await this.conversations.rename(row.id, name, this.now());
    return { conversation: await this.reloadView(row.id) };
  }

  /** 手动置顶（PRD F-C5 / D13）：只动 `pinned`，不碰创建时间 */
  async pin(params: ConversationPinParams): Promise<ConversationPinResult> {
    const row = await this.requireConversation(params.conversationId);
    if (typeof params.pinned !== "boolean") {
      throw new ServerError("invalid_params", {
        params: { field: "pinned" },
        detail: { field: "pinned", reason: "not_boolean" },
      });
    }
    await this.conversations.setPinned(row.id, params.pinned, this.now());
    return { conversation: await this.reloadView(row.id) };
  }

  /**
   * 硬删一段对话（PRD F-C10 / D17 / F-F9 / R7）。
   *
   * `dryRun` 先算账（消息数、素材数），客户端据此警告用户。真删是 delete 语句 + 外键级联，
   * 消息行、素材行、问题行随对话一起消失；`assets/` 下的文件由 asset 层按引用清，这里只
   * 把清单回出去（PRD D17「图片按引用清理」）。
   */
  async delete(params: ConversationDeleteParams): Promise<ConversationRemovalReport> {
    const row = await this.requireConversation(params.conversationId);
    const assetRows = await this.assets.listByConversation(row.id);
    const consequences = {
      conversations: 1,
      messages: await this.messages.countByConversation(row.id),
      assets: assetRows.length,
    };
    const assetPaths = assetRows.map((asset) => asset.path);

    if (params.dryRun === true) {
      return { removed: false, consequences, assetPaths };
    }

    await this.runtime.forget(row.id);
    const changes = await this.conversations.delete(row.id);
    return { removed: changes > 0, consequences, assetPaths };
  }

  /**
   * 撤回（PRD F-C8 / D24 / R10）。
   *
   * 撤回到某条**用户消息之前**：那条消息及其后全部硬删，被撤回的内容按 core 的内容形状
   * 回给客户端填回输入框（连它当时带的素材 id 一起，F-H3「带图消息连图一起恢复」）。
   * 不留删除痕迹（R10）；正在跑一轮时拒绝，不然删的正是流式还在写的那几条。
   */
  async revert(params: ConversationRevertParams): Promise<ConversationRevertResult> {
    const row = await this.requireConversation(params.conversationId);
    const anchorId = requireId(params.beforeMessageId, "beforeMessageId");
    if (this.runtime.isRunning(row.id)) {
      throw new ServerError("busy", { detail: { conversationId: row.id, action: "revert" } });
    }

    const anchorRow = await this.messages.get(anchorId);
    if (!anchorRow || anchorRow.conversationId !== row.id) {
      throw new ServerError("not_found", {
        params: { entity: "message" },
        detail: { messageId: anchorId, conversationId: row.id },
      });
    }
    const anchor = toAgentMessage(anchorRow);
    if (anchor.role !== AgentNS.Role.User) {
      throw new ServerError("invalid_params", {
        params: { field: "beforeMessageId" },
        detail: { field: "beforeMessageId", reason: "not_a_user_message", role: anchor.role },
      });
    }

    // 锚点已确认存在，所以这次取到的就是「从它开始（含它）」的那一段（A12）
    const doomed = await this.messages.listByConversation(row.id, anchor.id);
    const removedMessageIds = doomed.map((message) => message.id);
    const assetIds = (await this.assets.listByMessage(anchor.id)).map((asset) => asset.id);
    const restoredInput: MessageInput = assetIds.length > 0
      ? { content: anchor.content ?? "", assetIds }
      : { content: anchor.content ?? "" };

    await this.messages.deleteAfter(row.id, anchor.id, { includeSelf: true });
    return { removedMessageIds, restoredInput };
  }

  /**
   * 临时换模型（PRD F-B4 / F-B8 / D20 / L7）。
   *
   * 只把覆盖交给运行时（内存），库里的 `modelId` 一个字都不改：重开这段对话就回默认。
   * 历史里已经有图、而新模型不看图时拒绝（D20），并说明原因。
   */
  async setModel(params: ConversationSetModelParams): Promise<ConversationSetModelResult> {
    const row = await this.requireConversation(params.conversationId);
    const config = await this.readConfig();

    let override: string | null;
    if (params.modelId == null) {
      override = null;
    } else {
      const modelId = requireId(params.modelId, "modelId");
      if (modelId === row.modelId) {
        // 选的正是身份上的那个模型：覆盖等于没设，清掉才不会让「临时换过」的标记骗人
        override = null;
      } else {
        const model = config.models.find((item) => item.id === modelId);
        if (!model) {
          throw new ServerError("not_found", {
            params: { entity: "model" },
            detail: { modelId },
          });
        }
        if (model.vision !== true && (await this.hasImages(row.id))) {
          throw new ServerError("model_unsupported", {
            params: { model: model.name },
            detail: { modelId: model.id, conversationId: row.id, reason: "history_has_images" },
          });
        }
        override = model.id;
      }
    }

    await this.runtime.setModelOverride(row.id, override);
    const { view, context } = await this.composeView(
      row,
      await this.viewContext(config),
    );
    return { conversation: view, model: view.model, context };
  }

  /**
   * 临时调思考强度（PRD F-B6 / F-B7）。
   *
   * 一样只活在内存里：改助手默认档是另一个动作（`agent.setThinking`），这一段对话的临时
   * 调整归运行时。档位名必须在该模型引用的策略表里 —— 表里没有的档发出去只会换来一句 400。
   */
  async setThinking(params: ConversationSetThinkingParams): Promise<ConversationSetThinkingResult> {
    const row = await this.requireConversation(params.conversationId);
    const level = requireId(params.level, "level");
    const context = await this.viewContext(await this.readConfig());
    const { model } = this.effectiveModel(row, context.config);
    if (!model) {
      throw new ServerError("not_found", {
        params: { entity: "model" },
        detail: { modelId: row.modelId },
      });
    }
    const preset = this.presetOf(model, context.presets);
    if (!preset) {
      throw new ServerError("unsupported", {
        params: { what: "thinking levels for this model" },
        detail: { modelId: model.id, preset: model.reasoningPreset ?? null },
      });
    }
    if (!Object.prototype.hasOwnProperty.call(preset.levels, level)) {
      throw new ServerError("invalid_params", {
        params: { field: "level" },
        detail: { field: "level", level, levels: Object.keys(preset.levels) },
      });
    }

    await this.runtime.setThinkingOverride(row.id, level);
    const agent = await this.loadAgent(row.agentId, context);
    return { thinking: this.buildThinking(row.id, model, agent, context.presets) };
  }

  /**
   * 把一批对话行拼成侧栏用的摘要（列表与搜索共用同一份口径）。
   *
   * `nameIsAuto` 由「名字是否还等于创建时间那个原名」推出来（PRD D2）：用户改名或自动命名
   * 之后名字就不再是原名，于是标记自然翻成 false。
   */
  async summarize(rows: Conversation[]): Promise<ConversationSummary[]> {
    const summaries: ConversationSummary[] = [];
    for (const row of rows) {
      const stored = await this.messages.listByConversation(row.id);
      const pending = await this.questions.listByConversation(row.id, "pending");
      summaries.push(this.toSummary(row, stored, pending.length));
    }
    return summaries;
  }

  /** 一行对话 → 侧栏摘要；`pendingCount` 是挂在这段对话上还没答的问题数 */
  private toSummary(
    row: Conversation,
    stored: StoredMessage[],
    pendingCount: number,
  ): ConversationSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      nameIsAuto: row.name === autoName(row.createdAt),
      pinned: row.pinned,
      agentId: row.agentId ?? "",
      modelId: row.modelId ?? "",
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      messageCount: stored.length,
      lastMessageAt: stored.length === 0 ? null : iso(latestCreatedAt(stored)),
      running: this.runtime.isRunning(row.id),
      hasPendingQuestion: pendingCount > 0,
    };
  }

  /** 拼一段对话的完整形状，顺带把 `setModel` 要的上下文占用一起算出来 */
  private async composeView(
    row: Conversation,
    context: ViewContext,
  ): Promise<{ view: ConversationView; context: ContextState }> {
    const stored = await this.messages.listByConversation(row.id);
    const pending = await this.questions.listByConversation(row.id, "pending");
    const workspace = await this.loadWorkspace(row.workspaceId, context);
    const agent = await this.loadAgent(row.agentId, context);
    const { model, overridden } = this.effectiveModel(row, context.config);

    const modelState: ConversationModelState = {
      modelId: model?.id ?? row.modelId ?? "",
      // 模型可能在配置里被删掉了：身份上的 id 仍然有效（L7），显示名退回那个 id
      name: model?.name ?? row.modelId ?? "",
      vision: model?.vision === true,
      overriddenThisSession: overridden,
    };
    const view: ConversationView = {
      ...this.toSummary(row, stored, pending.length),
      model: modelState,
      thinking: this.buildThinking(row.id, model, agent, context.presets),
      folder: await toFolderFact(workspace.cwd),
    };
    return { view, context: buildContext(model, lastUsage(stored)) };
  }

  /** 改完之后重新读一遍再拼视图：改名与置顶都要回写后的完整对象 */
  private async reloadView(conversationId: string): Promise<ConversationView> {
    const row = await this.conversations.get(conversationId);
    if (!row) {
      throw new ServerError("not_found", {
        params: { entity: "conversation" },
        detail: { conversationId },
      });
    }
    const { view } = await this.composeView(
      row,
      await this.viewContext(await this.readConfig()),
    );
    return view;
  }

  /**
   * 读配置。
   *
   * `config.json` 是手改得了的文件（F-G3 的同款思路）：它坏了要让用户看见「配置用不了 +
   * 哪一步读不动」，而不是一句「服务端内部错误」——所以解析失败在这里就折成 `config_invalid`。
   */
  private async readConfig(): Promise<AppConfig> {
    try {
      return await this.configManager.read();
    } catch (error) {
      throw new ServerError("config_invalid", {
        params: { reason: error instanceof Error ? error.message : String(error) },
        detail: { path: this.configManager.configPath },
        cause: error,
      });
    }
  }

  private async viewContext(
    config: AppConfig,
    workspaces: [string, WorkspaceRow][] = [],
    agents: [string, AgentDefinition | null][] = [],
  ): Promise<ViewContext> {
    return {
      config,
      presets: await this.configManager.readReasoningPresets(),
      workspaces: new Map(workspaces),
      agents: new Map(agents),
    };
  }

  private async requireConversation(conversationId: string): Promise<Conversation> {
    const id = typeof conversationId === "string" ? conversationId.trim() : "";
    const row = id.length === 0 ? undefined : await this.conversations.get(id);
    if (!row) {
      throw new ServerError("not_found", {
        params: { entity: "conversation" },
        detail: { conversationId },
      });
    }
    return row;
  }

  private async requireWorkspace(workspaceId: string): Promise<WorkspaceRow> {
    const id = typeof workspaceId === "string" ? workspaceId.trim() : "";
    const row = id.length === 0 ? undefined : await this.workspaces.get(id);
    if (!row) {
      throw new ServerError("not_found", {
        params: { entity: "workspace" },
        detail: { workspaceId },
      });
    }
    return row;
  }

  private async loadWorkspace(workspaceId: string, context: ViewContext): Promise<WorkspaceRow> {
    const cached = context.workspaces.get(workspaceId);
    if (cached) return cached;
    const row = await this.workspaces.get(workspaceId);
    if (!row) {
      throw new ServerError("not_found", {
        params: { entity: "workspace" },
        detail: { workspaceId },
      });
    }
    context.workspaces.set(workspaceId, row);
    return row;
  }

  private async loadAgent(agentId: string, context: ViewContext): Promise<AgentDefinition | null> {
    const cached = context.agents.get(agentId);
    if (cached !== undefined) return cached;
    const agent = await this.readAgentOrNull(agentId);
    context.agents.set(agentId, agent);
    return agent;
  }

  /** 读一个助手定义文件；不存在就是「没有这个助手」（PRD F-B5：不可用的也要说明原因） */
  private async readAgent(agentId: string): Promise<AgentDefinition> {
    const agent = await this.readAgentOrNull(agentId);
    if (!agent) {
      throw new ServerError("not_found", {
        params: { entity: "assistant" },
        detail: { agentId },
      });
    }
    return agent;
  }

  private async readAgentOrNull(agentId: string): Promise<AgentDefinition | null> {
    try {
      return await this.agents.read(agentId);
    } catch (error) {
      // 仓储会挡掉逃逸出 agents/ 目录的 id（抛的是普通 Error），这里转成参数错误
      throw new ServerError("invalid_params", {
        params: { field: "agentId" },
        detail: {
          field: "agentId",
          agentId,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /**
   * 这段对话**现在**用哪个模型：运行时里的临时覆盖优先，其次是创建时定死的那个。
   *
   * 被覆盖或兜底的那个模型可能已经从配置里删掉了 —— 那时 `model` 为空，调用方按 ID 显示。
   */
  private effectiveModel(
    row: Conversation,
    config: AppConfig,
  ): { model: Model | undefined; overridden: boolean } {
    const override = this.runtime.getModelOverride(row.id);
    const modelId = override ?? row.modelId ?? "";
    return {
      model: config.models.find((item) => item.id === modelId),
      overridden: override !== null && override !== row.modelId,
    };
  }

  /** 模型引用的思考策略（表里没有、或没有档位，就是「这个模型不可调」，F-B7） */
  private presetOf(model: Model, presets: ReasoningPresets): ReasoningPreset | undefined {
    const name = model.reasoningPreset;
    if (!name) return undefined;
    const preset = presets[name];
    return preset && Object.keys(preset.levels).length > 0 ? preset : undefined;
  }

  /**
   * 思考强度状态（PRD F-B6 / F-B7）。
   *
   * 三个来源：运行时里存着这段对话临时调的档（`manual`）；助手定义上的参数正好是某一档
   * （`following_default`）；模型没有思考策略（`not_adjustable`）。
   */
  private buildThinking(
    conversationId: string,
    model: Model | undefined,
    agent: AgentDefinition | null,
    presets: ReasoningPresets,
  ): ThinkingState {
    const presetName = model?.reasoningPreset ?? null;
    const preset = model ? this.presetOf(model, presets) : undefined;
    if (!preset) {
      return {
        preset: presetName,
        levels: [],
        selected: null,
        source: "not_adjustable",
        params: {},
      };
    }
    const levels = Object.keys(preset.levels);
    const override = this.runtime.getThinkingOverride(conversationId);
    if (override !== null && Object.prototype.hasOwnProperty.call(preset.levels, override)) {
      return {
        preset: presetName,
        levels,
        selected: override,
        source: "manual",
        params: preset.levels[override] ?? {},
      };
    }
    const detected = levels.find((level) =>
      matchesPatch(agent?.modelParams, preset.levels[level] ?? {}),
    );
    return {
      preset: presetName,
      levels,
      selected: detected ?? null,
      source: "following_default",
      params: detected ? preset.levels[detected] ?? {} : {},
    };
  }

  /** 历史里有没有图（D20 的依据：消息内容里的图片段，或这段对话名下带图的素材） */
  private async hasImages(conversationId: string): Promise<boolean> {
    const assets = await this.assets.listByConversation(conversationId);
    if (assets.some((asset) => asset.mime.startsWith("image/"))) return true;
    const stored = await this.messages.listByConversation(conversationId);
    return stored.some((message) => contentHasImage(toAgentMessage(message).content));
  }
}

/** 一批消息里最晚的创建时间（消息顺序按 seq，时间可能同毫秒，取最大值最稳） */
function latestCreatedAt(stored: StoredMessage[]): number {
  return stored.reduce(
    (latest, message) => (message.createdAt > latest ? message.createdAt : latest),
    0,
  );
}

/** 最近一次请求的用量：从后往前找第一条带 `usage` 的消息（assistant 才有，core 口径） */
function lastUsage(stored: StoredMessage[]): AgentNS.Usage {
  for (let index = stored.length - 1; index >= 0; index -= 1) {
    const usage = readUsage(stored[index]?.data);
    if (usage) return usage;
  }
  return { ...ZERO_USAGE };
}

/** 消息内容里是否有图片段（core 的 `image_url` 段） */
function contentHasImage(content: AgentNS.MessageContent | undefined): boolean {
  if (!content || typeof content === "string") return false;
  return content.some((section) => section.type === "image_url");
}

/**
 * 上下文占用（PRD F-D1 / D27）：最近一次请求的用量 + 这个模型的两条阈值。
 *
 * 阈值跟着模型走，所以换模型之后要用新模型的阈值重算；比例由客户端自己算。
 */
function buildContext(model: Model | undefined, usage: AgentNS.Usage): ContextState {
  const handoffThreshold = model?.tokenThresholds.handoff ?? 0;
  const guardThreshold = model?.tokenThresholds.guard ?? 0;
  return {
    usage,
    handoffThreshold,
    guardThreshold,
    overHandoff: handoffThreshold > 0 && usage.prompt_tokens >= handoffThreshold,
    overGuard: guardThreshold > 0 && usage.prompt_tokens >= guardThreshold,
  };
}
