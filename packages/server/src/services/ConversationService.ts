/**
 * 对话服务：一段对话的诞生、改名、置顶、删除、撤回，以及两个「会话级调整」（换模型、换思考档位）。
 *
 * 对应能力编号：F-C1（稳定 id）、F-C3（可改名字）、F-C5（置顶 + 创建时间倒序）、
 * F-C7（开新会话）、F-C8 / D24（撤回硬删 + 回填输入框）、F-C10 / D17（硬删 + 警告）、
 * F-B4 / D20（会话级换模型、历史有图时拒绝降级）、F-B6 / F-B7（思考档位）、
 * L5（重连按 id 拉）、L6（id 服务端分配）、R18（身份创建时必须有助手与模型）、
 * R22（消息原样用 core 的类型）。
 *
 * 两条贯穿这个文件的边界：
 *   1. **项目与助手创建即定死**：`workspaceId` / `agentId` 由 `create` 解析后落库，此后没有
 *      任何方法改它们。模型与思考档位不在这条线上：它们是这段会话自己的，存在会话行上、可以改。
 *   2. **服务层不缓存 agent、不驻留对话状态**：`running` 与「删掉之后的现场清理」都从注入的
 *      {@link ConversationRuntimePort} 现取现放；模型与档位在库里，不在内存里存第二份。
 */

import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

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

import type { ConversationDraftStore } from "../runtime/ConversationDrafts.js";
import { ConversationDrafts } from "../runtime/ConversationDrafts.js";
import type { ChatEventEmitter } from "../runtime/ChatRunner.js";
import { injectedContextOf } from "../runtime/ChatRunner.js";
import { DEFAULT_LANGUAGE } from "../i18n/index.js";
import type { Language } from "../i18n/index.js";
import type { AssetRepository } from "../storage/AssetRepository.js";
import type { ConversationRepository } from "../storage/ConversationRepository.js";
import type { MessageRepository } from "../storage/MessageRepository.js";
import type { QuestionRepository } from "../storage/QuestionRepository.js";
import type { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import type { Conversation, StoredMessage, WorkspaceRow } from "../storage/types.js";
import { ServerError } from "../wire/errors.js";
import type { ConversationChangeKind } from "../wire/events.js";
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
  ModelSource,
  ThinkingState,
} from "../wire/index.js";
import { readUsage, toAgentMessage } from "./MessageService.js";
import { toFolderFact } from "./WorkspaceService.js";

/**
 * 运行时注入给对话服务的窄接口。
 *
 * 只剩两件运行时才知道的事：
 *   - 这段对话现在有没有在跑一轮（PRD F-I3 / D14，真相在 `RunRegistry` 一处）；
 *   - 对话被删掉之后，把这一轮的现场丢掉（中止在跑的轮次）。
 *
 * 模型与思考档位不在这里：它们存在会话行上（`modelId` / `thinkingLevel`），服务层自己读写库。
 *
 * 服务层只按它读写，不 import `runtime/` 里的任何实现、也不自己存一份 —— 两份状态迟早
 * 有一份先漂（D28：agent 用完即弃、对话不驻留）。
 */
export interface ConversationRuntimePort {
  /** 这段对话现在是否在跑一轮 */
  isRunning(conversationId: string): boolean;
  /** 对话（或它的项目）被删掉之后，中止在跑的轮次并清掉现场 */
  forget(conversationId: string): void | Promise<void>;
}

/** `conversation.delete` 的结果：wire 字段 + 交给 asset 层按引用清的文件清单 */
export interface ConversationRemovalReport extends ConversationDeleteResult {
  /** 需要 asset 层按引用清掉的文件（数据根下的相对路径，来自 `assets.path`） */
  assetPaths: string[];
}

/**
 * 从项目定位的两条路得出「哪个项目」：已经登记的那个，或者一个还没登记的目录（PRD D10）。
 *
 * 做成联合类型而不是抛错：调用方（`conversation.create` 的接线层）要就「未登记」这件事
 * 问用户一次，那就不是一个错误。
 */
export type WorkspaceLocation =
  | { workspace: WorkspaceRow }
  | { needsRegistration: string };

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
  /** 草稿（R56）：`create` 只记在这里，首次 `send` 才落库；不注入时用一份自己的 */
  drafts?: ConversationDraftStore;
  /** 推 `conversation.changed`（多端在线同步，L5 / D22）；不注入时不推 */
  emit?: ChatEventEmitter;
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

/**
 * cwd 归一化成绝对路径。
 *
 * 与 `WorkspaceService` 同一套口径（D9 的 cwd 一旦定死就不再变）：相对路径不能拿
 * 进程工作目录去解，否则同一个入参在不同启动方式下会得到两个项目。
 */
function normalizeCwd(value: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw.length === 0) {
    throw new ServerError("invalid_params", {
      params: { field: "cwd" },
      detail: { field: "cwd", reason: "empty" },
    });
  }
  if (!isAbsolute(raw)) {
    throw new ServerError("invalid_params", {
      params: { field: "cwd" },
      detail: { field: "cwd", reason: "not_absolute", cwd: value },
    });
  }
  return resolve(raw);
}

/**
 * 撤回时回填的正文只取纯文本段（R62）。
 *
 * 一条带附件的用户消息里既有正文又有 `image_url` / `file` 段；原样回填会让客户端既拿到
 * 已经转换好的段、又拿到 `assetIds`（图片会显示两遍）。附件靠 `assetIds` 复原（F-H3）。
 */
function textOnlyContent(content: AgentNS.MessageContent | undefined): AgentNS.MessageContent {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  const sections = content.filter(
    (section): section is AgentNS.TextContentSection => section.type === "text",
  );
  return sections.length === 0 ? "" : sections;
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
  private readonly drafts: ConversationDraftStore;
  private readonly emit?: ChatEventEmitter;
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
    this.drafts = deps.drafts ?? new ConversationDrafts();
    this.emit = deps.emit;
    this.now = deps.now ?? Date.now;
    this.agents = new AgentRepository(join(deps.configManager.basePath, "agents"));
  }

  /**
   * 列表（PRD F-C5 / D13）。
   *
   * 顺序由仓储定死：`pinned DESC, createdAt DESC` —— 活动、打开、改名都不影响它，所以这里
   * 除了按 Workspace / 置顶筛、按 `limit` / `offset` 切页之外，不再重排。
   *
   * 列表只给已经落库的对话：草稿（还没发过消息，R56）不在侧栏里出现 —— 建了不发就断线
   * 的那段对话应该像没建过一样。
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
   * 定位这段对话所属的项目（PRD D9 / D10）。
   *
   * 两条路：给了 `workspaceId` 就是那个已登记的项目（`cwd` 忽略）；只给了 `cwd` 时按目录找
   * 已登记的那个，找不到就回一张「待登记」的事实单 —— 由接线层去问用户（D10 的「问一次」）。
   * 两个都没给就是参数不对，不当成「随便找个目录」。
   */
  async locateWorkspace(params: {
    workspaceId?: string;
    cwd?: string;
  }): Promise<WorkspaceLocation> {
    const workspaceId = typeof params.workspaceId === "string" ? params.workspaceId.trim() : "";
    if (workspaceId.length > 0) {
      return { workspace: await this.requireWorkspace(workspaceId) };
    }
    const cwd = params.cwd === undefined ? null : normalizeCwd(params.cwd);
    if (cwd === null) {
      throw new ServerError("invalid_params", {
        params: { field: "workspaceId" },
        detail: { field: "workspaceId", reason: "required", or: "cwd" },
      });
    }
    const existing = await this.workspaces.getByCwd(cwd);
    if (existing) return { workspace: existing };
    return { needsRegistration: cwd };
  }

  /**
   * 开一段新对话（PRD F-C7 / L7 / R18 / R56）。
   *
   * 项目与助手在这里定死：项目来自入参（`workspaceId` 或 `cwd`），助手从磁盘上的定义文件解析。
   * 模型的值也在这里算出来（SDK 的三级解析 `会话级 > 助手定义 > 配置里的兜底`，唯一实现在
   * `resolveModel`），但它落的是**会话行**：之后可以由 `setModel` 改。解析不出来就报错，
   * 不写半成品行 —— 一条没有助手或没有模型的对话没有可用的身份。
   *
   * **这一行现在不写库**：只把 id 与身份留在草稿里（R56 / F-C2「没有用户消息就不写」）。
   * 首次 `conversation.send` 时由 {@link ensurePersisted} 用同一个 id 落库。
   */
  async create(params: ConversationCreateParams): Promise<ConversationCreateResult> {
    const located = await this.locateWorkspace(params);
    if ("needsRegistration" in located) {
      // 直接调服务层的调用方（不经过接线层）拿不到提问通道：把它们导回「先登记」那一步
      throw new ServerError("invalid_params", {
        params: { field: "cwd" },
        detail: { field: "cwd", reason: "workspace_not_registered", cwd: located.needsRegistration },
      });
    }
    const workspace = located.workspace;
    const config = await this.readConfig();
    const agent = await this.readAgent(requireId(params.agentId, "agentId"));

    const sessionModelId = params.modelId == null ? undefined : requireId(params.modelId, "modelId");
    const resolved = resolveModel({
      sessionModelId,
      agentModelId: agent.modelId,
      defaultModel: config.defaultModel,
    });
    if (!resolved) {
      // 三级解析都没拿到模型：「给这个助手挑一个模型」那条文案（R38），结构化原因在 detail 里
      throw new ServerError("config_invalid", {
        messageKey: "error.modelUnresolved",
        detail: { agentId: agent.id, defaultModel: config.defaultModel ?? null },
      });
    }
    const model = config.models.find((item) => item.id === resolved.modelId);
    if (!model) {
      // 调用方点名要的模型不存在 → 找不到；配置自己指着不存在的模型 → 解析出来的模型用不了
      if (resolved.level === "session") {
        throw new ServerError("not_found", {
          params: { entity: "model" },
          detail: { modelId: resolved.modelId, level: resolved.level },
        });
      }
      throw new ServerError("config_invalid", {
        messageKey: "error.modelUnresolved",
        detail: { modelId: resolved.modelId, level: resolved.level, agentId: agent.id },
      });
    }

    const createdAt = this.now();
    const draft: Conversation = {
      id: randomUUID(),
      workspaceId: workspace.id,
      name: autoName(createdAt),
      nameIsAuto: true,
      pinned: false,
      agentId: agent.id,
      modelId: model.id,
      // 新建的会话不选档位：思考强度跟随助手定义上的那份（F-B6）
      thinkingLevel: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.drafts.put(draft);

    const context = await this.viewContext(
      config,
      [[workspace.id, workspace]],
      [[agent.id, agent]],
    );
    const { view } = await this.composeView(draft, context);
    return { conversation: view, requiresRegistration: false };
  }

  /**
   * 把草稿落成 `conversations` 的一行（R56：首次 `send` 时用同一个 id 写）。
   *
   * 已经在库里就直接返回那一行（重复调用是幂等的）；草稿不在、库里也没这一行就是
   * `not_found`。先把草稿摘掉再写库：两次并发的 `send` 里后到的那一次就抢不到同一份草稿，
   * 不会两次插同一行；写失败时把草稿放回去，下一次还能再试。
   *
   * 落行那一刻同时写上这段对话的第一条消息：一条 `hidden` 的 `user` 消息，告诉模型这段对话
   * 对应的 cwd（PRD F-D9）。它最先写，所以 `seq` 在真实用户消息之前；之后每轮都不再重写。
   * cwd 从这段对话的 Workspace 取（不是进程工作目录）；`workspaceId` 建会话时就定死了，
   * 这里只读不改。
   *
   * `language` 是这条消息正文的渲染语言（D8：调用方传发起这条连接的语言；不传时用缺省语言）。
   */
  async ensurePersisted(
    conversationId: string,
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<Conversation> {
    const id = requireId(conversationId, "conversationId");
    const existing = await this.conversations.get(id);
    if (existing) {
      this.drafts.forget(id);
      return existing;
    }
    const draft = this.drafts.take(id);
    if (!draft) {
      throw new ServerError("not_found", {
        params: { entity: "conversation" },
        detail: { conversationId },
      });
    }
    try {
      await this.conversations.create({
        id: draft.id,
        workspaceId: draft.workspaceId,
        name: draft.name,
        agentId: draft.agentId,
        modelId: draft.modelId,
        // 草稿期间用户先调过档的话，落库时跟着写进去
        thinkingLevel: draft.thinkingLevel,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
      });
      await this.writeCwdMessage(draft, language);
      // 新行默认是「自动命名、未置顶」；草稿期间用户改过名 / 置过顶的，落库时补写一次
      if (draft.nameIsAuto === false) {
        await this.conversations.renameByUser(draft.id, draft.name, draft.updatedAt);
      }
      if (draft.pinned) {
        await this.conversations.setPinned(draft.id, true, draft.updatedAt);
      }
    } catch (error) {
      this.drafts.put(draft);
      throw error;
    }

    const row = await this.conversations.get(id);
    if (!row) {
      throw new ServerError("internal", {
        detail: { reason: "conversation vanished after insert", id },
      });
    }
    // 草稿变成真行那一刻才第一次出现在其它窗口的侧栏里，所以这里补一条 `created`
    this.emitChanged(row.id, row.workspaceId, "created", 0);
    return row;
  }

  /**
   * 写会话开头那条 `hidden` 的 cwd 消息（PRD F-D9）。
   *
   * 它是一条普通的 `user` 消息，只是 `hidden` 为真：模型在上下文里能看到它，界面上不展示
   * 它（core 的 `Message.hidden`）。内容用的是 i18n 里那两条既有键的拼装（与临时对话共用
   * `injectedContextOf`）。
   *
   * cwd 来自这段对话所属的 Workspace（PRD D9：一段对话绑一个项目，cwd 创建即定死），
   * 不读进程工作目录。
   */
  private async writeCwdMessage(draft: Conversation, language: Language): Promise<void> {
    const workspace = await this.workspaces.get(draft.workspaceId);
    if (!workspace) {
      // 行已经写进去了、外键指着它，所以这里只可能是库被别处改坏了
      throw new ServerError("internal", {
        detail: { reason: "workspace_missing", workspaceId: draft.workspaceId },
      });
    }
    await this.messages.upsert({
      id: randomUUID(),
      conversationId: draft.id,
      role: AgentNS.Role.User as string,
      status: AgentNS.MessageStatus.Completed as string,
      omit: false,
      content: injectedContextOf(workspace.cwd, language),
      data: { hidden: true },
      createdAt: this.now(),
    });
  }

  /** 按 id 打开一段对话（PRD F-A6：服务端只提供「按 id 打开」） */
  async get(params: ConversationGetParams): Promise<ConversationGetResult> {
    const conversation = await this.requireConversation(params.conversationId);
    const { view } = await this.composeView(
      conversation,
      await this.viewContext(await this.readConfig()),
    );
    return { conversation: view };
  }

  /** 改名（PRD D1 / F-C3）：只换名字，id、身份与排序都不动；名字从此归用户（R35） */
  async rename(params: ConversationRenameParams): Promise<ConversationRenameResult> {
    const conversation = await this.requireConversation(params.conversationId);
    const name = requireId(params.name, "name");
    const updatedAt = this.now();

    const draft = this.drafts.get(conversation.id);
    if (draft) {
      this.drafts.put({ ...draft, name, nameIsAuto: false, updatedAt });
    } else {
      await this.conversations.renameByUser(conversation.id, name, updatedAt);
    }

    const view = await this.reloadView(conversation.id);
    this.emitChanged(view.id, view.workspaceId, "renamed", view.messageCount);
    return { conversation: view };
  }

  /** 手动置顶（PRD F-C5 / D13）：只动 `pinned`，不碰创建时间 */
  async pin(params: ConversationPinParams): Promise<ConversationPinResult> {
    const conversation = await this.requireConversation(params.conversationId);
    if (typeof params.pinned !== "boolean") {
      throw new ServerError("invalid_params", {
        params: { field: "pinned" },
        detail: { field: "pinned", reason: "not_boolean" },
      });
    }
    const updatedAt = this.now();

    const draft = this.drafts.get(conversation.id);
    if (draft) {
      this.drafts.put({ ...draft, pinned: params.pinned, updatedAt });
    } else {
      await this.conversations.setPinned(conversation.id, params.pinned, updatedAt);
    }

    const view = await this.reloadView(conversation.id);
    this.emitChanged(view.id, view.workspaceId, "pinned", view.messageCount);
    return { conversation: view };
  }

  /**
   * 硬删一段对话（PRD F-C10 / D17 / F-F9 / R7）。
   *
   * `dryRun` 先算账（消息数、素材数），客户端据此警告用户。真删是 delete 语句 + 外键级联，
   * 消息行、素材行、问题行随对话一起消失；`assets/` 下的文件由 asset 层按引用清，这里只
   * 把清单回出去（PRD D17「图片按引用清理」）。
   *
   * 还没落库的草稿也能删：没有行、没有消息、没有素材，代价是零。
   */
  async delete(params: ConversationDeleteParams): Promise<ConversationRemovalReport> {
    const conversation = await this.requireConversation(params.conversationId);

    const draft = this.drafts.get(conversation.id);
    if (draft) {
      const draftConsequences = { conversations: 1, messages: 0, assets: 0 };
      if (params.dryRun === true) {
        return { removed: false, consequences: draftConsequences, assetPaths: [] };
      }
      this.drafts.forget(conversation.id);
      await this.runtime.forget(conversation.id);
      this.emitChanged(conversation.id, draft.workspaceId, "deleted", null);
      return { removed: true, consequences: draftConsequences, assetPaths: [] };
    }

    const assetRows = await this.assets.listByConversation(conversation.id);
    const consequences = {
      conversations: 1,
      // 这个数来自 `countByConversation`：库里这段对话的全部消息行，**含子 Agent 的消息**
      // （它们落在同一张表、`parentToolCallId` 非空），但**不含 `hidden` 的**（会话创建时那条
      // cwd 消息、交接摘要）。所以它会比侧栏摘要里的 `messageCount` 大：那个数来自
      // `listByConversation`，只数主线。两者是两个不同的量（这一处是「删掉会少多少行」的代价，
      // 那一处是「侧栏显示几句话」），不互相换算。
      messages: await this.messages.countByConversation(conversation.id),
      assets: assetRows.length,
    };
    const assetPaths = assetRows.map((asset) => asset.path);

    if (params.dryRun === true) {
      return { removed: false, consequences, assetPaths };
    }

    await this.runtime.forget(conversation.id);
    const changes = await this.conversations.delete(conversation.id);
    const removed = changes > 0;
    if (removed) this.emitChanged(conversation.id, conversation.workspaceId, "deleted", null);
    return { removed, consequences, assetPaths };
  }

  /**
   * 撤回（PRD F-C8 / D24 / R10）。
   *
   * 撤回到某条**用户消息之前**：那条消息及其后全部硬删，被撤回的内容按 core 的内容形状
   * 回给客户端填回输入框（只有纯文本段 + 当时带的素材 id，R62 / F-H3「带图消息连图一起
   * 恢复」）。不留删除痕迹（R10）；正在跑一轮时拒绝，不然删的正是流式还在写的那几条。
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
    const content = textOnlyContent(anchor.content);
    const restoredInput: MessageInput = assetIds.length > 0
      ? { content, assetIds }
      : { content };

    await this.messages.deleteAfter(row.id, anchor.id, { includeSelf: true });
    const remaining = (await this.messages.listByConversation(row.id)).length;
    this.emitChanged(row.id, row.workspaceId, "message_removed", remaining);
    return { removedMessageIds, restoredInput };
  }

  /**
   * 换这段会话的模型（PRD F-B4 / F-B8 / D20）。
   *
   * 写的是**会话行**上的 `modelId`：这一段对话以后都用新模型，重开、重启都还是它。换模型
   * 同时把这段会话的思考档位清成「跟随助手定义」—— 档位是模型的档位，同一个名字在不同
   * 模型上对应不同参数，留着就变成把旧模型的参数发给新模型。
   *
   * `modelId: null` 表示回到助手定义上那个模型（它也没绑时用配置里的兜底）。
   * 历史里已经有图、而新模型不看图时拒绝（D20），并说明原因。
   */
  async setModel(params: ConversationSetModelParams): Promise<ConversationSetModelResult> {
    const row = await this.requireConversation(params.conversationId);
    const config = await this.readConfig();

    const modelId = params.modelId == null
      ? await this.agentModelIdOf(row.agentId, config)
      : requireId(params.modelId, "modelId");
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

    const updated = model.id === row.modelId ? row : await this.writeModel(row, model.id);
    const { view, context } = await this.composeView(
      updated,
      await this.viewContext(config),
    );
    // 换了的模型会出现在别的窗口的状态栏上（L5 / D22），推一条让它们去拉
    if (updated.modelId !== row.modelId) {
      this.emitChanged(row.id, row.workspaceId, "settings_changed", null);
    }
    return { conversation: view, model: view.model, context };
  }

  /**
   * 调这段会话的思考档位（PRD F-B6 / F-B7）。
   *
   * 写的是档位名（不是展开后的参数）：档位属于模型，同一个名字在不同模型的策略表里对应
   * 不同参数。`level: null` 表示回到「跟随助手定义」。改助手默认档是另一个动作
   * （`agent.setThinking`）。
   *
   * 档位名必须在该模型引用的策略表里 —— 表里没有的档发出去只会换来一句 400；模型没有
   * 可调档位时整件事不成立（`unsupported`）。
   */
  async setThinking(params: ConversationSetThinkingParams): Promise<ConversationSetThinkingResult> {
    const row = await this.requireConversation(params.conversationId);
    const context = await this.viewContext(await this.readConfig());
    const model = this.effectiveModel(row, context.config);
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
    const level = params.level == null ? null : requireId(params.level, "level");
    if (level !== null && !Object.prototype.hasOwnProperty.call(preset.levels, level)) {
      throw new ServerError("invalid_params", {
        params: { field: "level" },
        detail: { field: "level", level, levels: Object.keys(preset.levels) },
      });
    }

    const updated = await this.writeThinkingLevel(row, level);
    const agent = await this.loadAgent(row.agentId, context);
    this.emitChanged(row.id, row.workspaceId, "settings_changed", null);
    return { thinking: this.buildThinking(updated, model, agent, context.presets) };
  }

  /**
   * 把一批对话行拼成侧栏用的摘要（列表与搜索共用同一份口径）。
   *
   * `nameIsAuto` 直接读库里的那一列（R35）：它是「这个名字是不是自动起的」的唯一真值，
   * 不由名字内容反推。
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
      nameIsAuto: row.nameIsAuto,
      pinned: row.pinned,
      agentId: row.agentId ?? "",
      modelId: row.modelId ?? "",
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      // 这个数来自 `listByConversation` 的长度：只有**主线**消息（不含子 Agent 的，那些在同一个
      // 表里 `parentToolCallId` 非空），也不含 `hidden` 的。删除代价（`consequences.messages`）用的是另一条读数
      // `countByConversation`，数的是表里的全部行（只筛 `hidden`），所以同一段对话这两处数字可以不等。
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
    const model = this.effectiveModel(row, context.config);

    const modelState: ConversationModelState = {
      modelId: model?.id ?? row.modelId ?? "",
      // 模型可能在配置里被删掉了：行上的 id 仍然有效（它是这段会话现在用的那个），显示名退回 id
      name: model?.name ?? row.modelId ?? "",
      vision: model?.vision === true,
      source: this.modelSource(row, agent, context.config),
    };
    const view: ConversationView = {
      ...this.toSummary(row, stored, pending.length),
      model: modelState,
      thinking: this.buildThinking(row, model, agent, context.presets),
      folder: await toFolderFact(workspace.cwd),
    };
    return { view, context: buildContext(model, lastUsage(stored)) };
  }

  /** 改完之后重新读一遍再拼视图：改名与置顶都要回写后的完整对象 */
  private async reloadView(conversationId: string): Promise<ConversationView> {
    const row = await this.requireConversation(conversationId);
    const { view } = await this.composeView(
      row,
      await this.viewContext(await this.readConfig()),
    );
    return view;
  }

  /**
   * 推一条 `conversation.changed`（L5 / D22：两个窗口同时开着时，对方界面靠它去拉）。
   *
   * 只报「什么变了 + 够用的定位信息」，不搬整个对象（architecture §7）。
   */
  private emitChanged(
    conversationId: string,
    workspaceId: string,
    change: ConversationChangeKind,
    messageCount: number | null,
  ): void {
    this.emit?.("conversation.changed", {
      conversationId,
      workspaceId,
      change,
      messageCount,
      at: iso(this.now()),
    });
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

  /**
   * 按 id 取一段对话：先看库里那一行，再看草稿（R56）。两者用同一份行形状，
   * 于是视图拼装、换模型、写档位这些路径对草稿一字不改。
   */
  private async requireConversation(conversationId: string): Promise<Conversation> {
    const id = typeof conversationId === "string" ? conversationId.trim() : "";
    const row = id.length === 0 ? undefined : await this.conversations.get(id);
    if (row) return row;
    const draft = id.length === 0 ? undefined : this.drafts.get(id);
    if (draft) return draft;
    throw new ServerError("not_found", {
      params: { entity: "conversation" },
      detail: { conversationId },
    });
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
   * 这段对话**现在**用哪个模型：就是会话行上那个 `modelId`。
   *
   * 它可能已经从配置里删掉了 —— 那时 `model` 为空，调用方按 ID 显示。
   */
  private effectiveModel(row: Conversation, config: AppConfig): Model | undefined {
    return config.models.find((item) => item.id === row.modelId);
  }

  /**
   * 这个模型是谁定的（PRD F-B4 两个动作的区别）。
   *
   * 会话行上的模型与助手定义绑的那个一致时算「跟着助手走」；否则算「会话自己定的」
   * （创建时点名，或 `setModel` 改过）。助手没绑模型时它实际上用配置里的兜底，那一档也算
   * 「跟着助手走」：装配时用的参数口径与这里同一个判断（见 `ChatRunner` 的 `conversationModelParams`）。
   */
  private modelSource(
    row: Conversation,
    agent: AgentDefinition | null,
    config: AppConfig,
  ): ModelSource {
    const agentModelId = agent?.modelId ?? config.defaultModel;
    return agentModelId !== undefined && agentModelId === row.modelId
      ? "agent"
      : "conversation";
  }

  /** 助手定义上那个模型（`/model` 不带 id 时回到它）；它没绑且没有兜底时报错 */
  private async agentModelIdOf(agentId: string, config: AppConfig): Promise<string> {
    const agent = await this.readAgentOrNull(agentId);
    const resolved = resolveModel({
      agentModelId: agent?.modelId,
      defaultModel: config.defaultModel,
    });
    if (!resolved) {
      throw new ServerError("config_invalid", {
        messageKey: "error.modelUnresolved",
        detail: { agentId, defaultModel: config.defaultModel ?? null },
      });
    }
    return resolved.modelId;
  }

  /**
   * 把模型写进会话（草稿还没落库时写进草稿，落库那一刻跟着写进去）。
   *
   * 与仓储的 `setModel` 一个口径：档位跟着清掉（档位是模型的档位）。
   */
  private async writeModel(row: Conversation, modelId: string): Promise<Conversation> {
    const updatedAt = this.now();
    const draft = this.drafts.get(row.id);
    if (draft) {
      const next: Conversation = { ...draft, modelId, thinkingLevel: null, updatedAt };
      this.drafts.put(next);
      return next;
    }
    await this.conversations.setModel(row.id, modelId, updatedAt);
    return { ...row, modelId, thinkingLevel: null, updatedAt };
  }

  /** 把思考档位写进会话（`null` = 回到跟随助手定义），回写后的行 */
  private async writeThinkingLevel(
    row: Conversation,
    thinkingLevel: string | null,
  ): Promise<Conversation> {
    const updatedAt = this.now();
    const draft = this.drafts.get(row.id);
    if (draft) {
      const next: Conversation = { ...draft, thinkingLevel, updatedAt };
      this.drafts.put(next);
      return next;
    }
    await this.conversations.setThinkingLevel(row.id, thinkingLevel, updatedAt);
    return { ...row, thinkingLevel, updatedAt };
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
   * 三种来源：会话行上选了某一档（`manual`）；没选、而助手定义上的参数正好是某一档
   * （`following_default`）；模型没有思考策略（`not_adjustable`）。
   * 行上那个档位名在当前模型的策略表里不存在（换过模型、或策略表被改）时退回「跟随助手」。
   */
  private buildThinking(
    row: Conversation,
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
    const chosen = row.thinkingLevel;
    if (chosen !== null && Object.prototype.hasOwnProperty.call(preset.levels, chosen)) {
      return {
        preset: presetName,
        levels,
        selected: chosen,
        source: "manual",
        params: preset.levels[chosen] ?? {},
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
