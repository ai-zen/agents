/**
 * 会话服务：一段会话的诞生、改名、置顶、删除、撤回，以及三个「会话级调整」（换模型、换思考
 * 档位、两条阈值）。
 *
 * 两条贯穿这个文件的边界：
 *   1. **项目与助手创建即定死**：`workspaceId` / `agentId` 由 `create` 解析后落库，此后没有
 *      任何方法改它们。模型、思考档位与两条阈值不在这条线上：它们是这段会话自己的，存在会话
 *      行上、可以改 —— 前两个进 agent 的出厂配置（改了要重建，而且**只允许空闲时改**），两条
 *      阈值不进（改了不重建）。
 *   2. **服务层不缓存 agent、不驻留会话状态**：这段会话此刻落在哪一格、队里压着几条，都从注入的
 *      {@link SessionRuntimePort} 现取；模型与档位在库里，不在内存里存第二份。
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { AgentNS, Message } from "@ai-zen/agents-core";
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
import type { LogSink } from "@ai-zen/agents-logger";

import type { SessionDraftStore } from "../runtime/SessionDrafts.js";
import { hasThinkingKey } from "./thinking.js";
import { SessionDrafts } from "../runtime/SessionDrafts.js";
import type { ChatEventEmitter } from "../runtime/ChatRunner.js";
import type { AssetRepository } from "../storage/AssetRepository.js";
import type { SessionRepository } from "../storage/SessionRepository.js";
import type { MessageRepository } from "../storage/MessageRepository.js";
import type { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import type { Session, StoredMessage, WorkspaceRow } from "../storage/types.js";
import { HostError } from "../wire/errors.js";
import type { SessionChangeKind } from "../wire/events.js";
import type {
  CompactionMode,
  SessionCreateParams,
  SessionCreateResult,
  SessionDeleteParams,
  SessionDeleteResult,
  SessionGetParams,
  SessionGetResult,
  SessionListParams,
  SessionListResult,
  SessionModelState,
  SessionAgentState,
  SessionPinParams,
  SessionPinResult,
  SessionRenameParams,
  SessionRenameResult,
  SessionRevertParams,
  SessionRevertResult,
  SessionSetModelParams,
  SessionSetModelResult,
  SessionSetThinkingParams,
  SessionSetThinkingResult,
  SessionSetThresholdsParams,
  SessionSetThresholdsResult,
  SessionPresence,
  SessionSummary,
  SessionView,
  MessageInput,
  ModelSource,
  ThinkingState,
} from "../wire/index.js";
import { assetIdsOf } from "./AssetService.js";
import { toFolderFact } from "./WorkspaceService.js";

/**
 * 「谁开的这段会话」—— 宿主内部的那一份入参，**不进 wire**。
 *
 * 血缘与自动交接开关在 `session.create` 这条路上都是「用户建的」：用户建的会话血缘为 NULL、
 * 开关关（装不下时问一次）。只有 agent 开出来的平级会话才带这两项（父会话 id + 开关开），而
 * 那条路走的是宿主内部的 `PeerSessionService`，不经过客户端。
 *
 * 所以这两项不是契约面的一部分：谁也不能从外面把一段会话认成「不是我建的」。
 */
export interface SessionOriginInput {
  /** 谁开的这段会话（父会话 id）；不给 = 用户建的 */
  lineage?: string | null;
  /** 自动交接开关的初值；不给 = `false`（用户建的那一侧：装不下时问一次） */
  autoHandoff?: boolean;
}

/**
 * 运行时注入给会话服务的窄接口。
 *
 * 只有运行时才知道的几件事：
 *   - 这段会话此刻那四件事（现读，PRD 4.4：忙闲 / 输入闸 / 输出闸 / 死活）；
 *   - 队里还压着几条（侧栏那一格现读的 `inboxPending`）；
 *   - 会话（或它的项目）被删掉之后，把这段会话的现场丢掉（`ChatRunner.forget`）；
 *   - 换模型 / 换思考档位这两手的两件事：它**手上有没有活**（`agentState`），以及改完之后让那个
 *     agent 退役（`invalidateAgent` —— 出厂配置变了，它不能留着）。
 *
 * 模型与思考档位本身不在这里：它们存在会话行上（`modelId` / `thinkingLevel`），服务层自己读写库。
 *
 * 服务层只按它读，不 import `runtime/` 里的任何实现、也不自己存一份 —— 两份状态迟早
 * 有一份先漂。
 */
export interface SessionRuntimePort {
  /**
   * 这段会话此刻的**四件事**（`ChatRunner.state` 现读，不落库、不推算）：忙闲 / 输入闸 / 输出闸 /
   * 死活。侧栏那一段与 `session.state` 读的是同一份事实，所以这里给的就是那四件事。
   */
  presence(sessionId: string): SessionPresence;
  /** 队里还压着几条没落成消息的条目（侧栏摘要的那一格） */
  inboxPending(sessionId: string): number;
  /** 会话（或它的项目）被删掉之后，丢掉这段会话的现场（摘桥 + agent 硬着陆） */
  forget(sessionId: string): void | Promise<void>;
  /**
   * 这段会话**手上有没有活**（core 的那一格 `agent.state` 原样给出）：没有 agent（死的）回 `null`。
   *
   * 只读 `state`，不看 `isOutputPaused` —— 那是另一处状态（从下一批起还收不收件），不收件
   * 挡着也算手上没活。换模型 / 换思考档位的判据就是这一格（`assertNoWorkInHand`）。
   */
  agentState(sessionId: string): AgentNS.AgentState | null;
  /**
   * 这一段会话的出厂配置变了（模型 / 思考档位换过）：手里那个 agent 不能留着，让注册表处置它
   * （`AgentRegistry.invalidateSession`：空闲的当场退役，在跑的只打标记）。
   */
  invalidateAgent(sessionId: string): void;
}

/** `session.delete` 的结果：wire 字段 + 交给 asset 层按引用清的文件清单 */
export interface SessionRemovalReport extends SessionDeleteResult {
  /**
   * 这段会话引用过的素材 id。
   *
   * 行删了（关系行随外键级联消失）之后要交给素材层再问一次「还剩几张引用」：有人还在用就留着
   * 字节，归零才删。这里只交 id，不交路径 —— 还在用的那份不该被当成可删的。
   */
  assetIds: string[];
}

/**
 * 素材归零清扫口（`AssetService.sweepUnreferenced` 结构上满足）。
 *
 * 服务层不碰 `assets/` 下的文件：它只说「这几个素材可能没人用了」，删行删文件归素材层。
 */
export type AssetSweeper = (assetIds: string[]) => Promise<string[]>;

/**
 * 「这段会话现在挂着几道题」的口（`QuestionService.countPending` 结构上满足）。
 *
 * 题不落库（PRD 4.10）：它是进程内对象，所以这个数只能问它。不注入时算 0（= 没有题）。
 */
export interface SessionQuestionPort {
  countPending(sessionId: string): number;
}

export interface SessionServiceDeps {
  sessions: SessionRepository;
  messages: MessageRepository;
  workspaces: WorkspaceRepository;
  assets: AssetRepository;
  /** 引用归零的素材交给它删行删文件；不注入时字节会留在盘上（引用行已经没了） */
  sweepAssets?: AssetSweeper;
  /** 挂在这段上的题有几道（现读内存）；不注入时按「没有题」算 */
  questions?: SessionQuestionPort;
  /** 配置唯一入口（SDK）：助手定义在 `<basePath>/agents/`，模型与默认项在 `config.json` 里 */
  configManager: ConfigManager;
  runtime: SessionRuntimePort;
  /** 草稿：`create` 只记在这里，第一次真正用到它时才落库；不注入时用一份自己的 */
  drafts?: SessionDraftStore;
  /** 推 `session.changed`（多端在线同步）；不注入时不推 */
  emit?: ChatEventEmitter;
  /**
   * 助手那两格事实（定义上的名字 / 现在能不能跑）。
   *
   * 能不能跑要看模型 / 端点 / 密钥三处齐不齐，那是 `AgentService` 的活 —— 本服务不把
   * 那套判定重写一份（两份判定必漂），只向它要一个结论。没注入、或定义已经没了时两格都是
   * `null`（说「不知道」而不是编一个像真的名字）。
   */
  describeAgent?: (agentId: string) => Promise<{ name: string; available: boolean } | null>;
  /**
   * 缺省造助手定义仓储时用的日志口（可选）：`list()` 跳过读不出来的定义时那几句走它。
   * 不注就沿 SDK 的缺省（不记）—— 接线处给的是宿主自己那份 `withSource("sdk")`。
   */
  logger?: LogSink;
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
 * 会话的原名：创建时间（PRD D2「原名＝创建时间」，起不出名就保持它）。
 *
 * 用本地时区的 `YYYY-MM-DD HH:mm`：这是摆在侧栏里给人看的一句话，不是可排序的机器时间
 * （排序只按 `pinned` + `createdAt`）。
 *
 * 导出的理由：自动命名要拿它当**唯一**的判据 —— 「名字还是不是创建时这个默认值」。
 * 这个名字在一个地方算出来，判定与写入才对得上同一份口径。
 */
export function defaultSessionName(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 撤回时回填的正文只取纯文本段。
 *
 * 一条带附件的用户消息里既有正文又有 `image_url` / `file` 段；原样回填会让客户端既拿到
 * 已经转换好的段、又拿到 `assetIds`（图片会显示两遍）。附件靠 `assetIds` 复原。
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
    throw new HostError("invalid_params", {
      params: { field },
      detail: { field, reason: "empty" },
    });
  }
  return text;
}

/**
 * 两条阈值的取值校验（PRD 1.4 / 4.7）：省略（`undefined`）= 不动、`null` = 回到跟模型走、
 * 其余必须是**正整数**。
 *
 * `0` 不接受：阈值量的是「请求前的输入用量」的绝对 token 数，0 是个没有意义的线 —— 要「这条线
 * 不设」请给 `null`（它说的是「跟模型走」，不是「关掉」）。负数、小数、`NaN` / `Infinity` 同理。
 */
function requireThreshold(
  value: number | null | undefined,
  field: string,
): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HostError("invalid_params", {
      params: { field },
      detail: { field, reason: "not_positive_integer", value },
    });
  }
  return value;
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
 * 档位展开后写进 `AgentDefinition.modelParams` 的是参数而不是档位名，所以读的时候
 * 只能反过来按补丁认档位。补丁允许是定义参数的子集（定义里可能还有与思考无关的参数）。
 */
function matchesPatch(params: ModelParams | undefined, patch: ModelParams): boolean {
  if (!params) return false;
  const entries = Object.entries(patch);
  if (entries.length === 0) return false;
  return entries.every(([key, value]) => deepEqual(params[key], value));
}

export class SessionService {
  private readonly sessions: SessionRepository;
  private readonly messages: MessageRepository;
  private readonly workspaces: WorkspaceRepository;
  private readonly assets: AssetRepository;
  private readonly sweepAssets?: AssetSweeper;
  private readonly questions?: SessionQuestionPort;
  private readonly configManager: ConfigManager;
  private readonly runtime: SessionRuntimePort;
  private readonly drafts: SessionDraftStore;
  private readonly emit?: ChatEventEmitter;
  private readonly describeAgent?: SessionServiceDeps["describeAgent"];
  private readonly now: () => number;
  /** 正在落库的草稿：同一个 id 的并发调用共用同一次写入（key 是 sessionId） */
  private readonly persisting = new Map<string, Promise<Session>>();
  /** 助手定义是文件（一实体一文件），按配置根下的 `agents/` 目录读 */
  private readonly agents: AgentRepository;

  constructor(deps: SessionServiceDeps) {
    this.sessions = deps.sessions;
    this.messages = deps.messages;
    this.workspaces = deps.workspaces;
    this.assets = deps.assets;
    this.sweepAssets = deps.sweepAssets;
    this.questions = deps.questions;
    this.configManager = deps.configManager;
    this.runtime = deps.runtime;
    this.drafts = deps.drafts ?? new SessionDrafts();
    this.emit = deps.emit;
    this.describeAgent = deps.describeAgent;
    this.now = deps.now ?? Date.now;
    this.agents = new AgentRepository(join(deps.configManager.basePath, "agents"), deps.logger);
  }

  /**
   * 列表。
   *
   * 顺序由仓储定死：`pinned DESC, createdAt DESC`（同刻按 id）—— 活动、打开、改名都不影响
   * 它，所以这里除了按 Workspace / 置顶筛、按 `limit` / `offset` 切页之外，不再重排。
   *
   * 列表只给已经落库的会话：草稿（还没发过消息）不在侧栏里出现 —— 建了不发就断线
   * 的那段会话应该像没建过一样。
   */
  async list(params: SessionListParams = {}): Promise<SessionListResult> {
    const rows =
      params.workspaceId === undefined
        ? await this.sessions.list()
        : await this.sessions.listByWorkspace(params.workspaceId);

    const filtered =
      params.pinned === undefined ? rows : rows.filter((row) => row.pinned === params.pinned);
    const offset = params.offset === undefined ? 0 : Math.max(params.offset, 0);
    const page =
      params.limit === undefined
        ? filtered.slice(offset)
        : filtered.slice(offset, offset + Math.max(params.limit, 0));

    return { sessions: await this.summarize(page), total: filtered.length };
  }

  /**
   * 开一段新会话。
   *
   * 项目与助手在这里定死：项目就是入参的那个已登记项目（项目只走显式添加），助手从
   * 磁盘上的定义文件解析。模型的值也在这里算出来（SDK 的三级解析 `会话级 > 助手定义 > 配置里的
   * 兜底`，唯一实现在 `resolveModel`），但它落的是**会话行**：之后可以由 `setModel` 改。解析不
   * 出来就报错，不写半成品行 —— 一条没有助手或没有模型的会话没有可用的身份。
   *
   * **这一行不写库**：只把 id 与身份留在草稿里（没有用户消息就不写）。第一次真正用到它时
   * 由 {@link ensurePersisted} 用同一个 id 落库（PLAN §4）。
   */
  async create(params: SessionCreateParams & SessionOriginInput): Promise<SessionCreateResult> {
    const workspace = await this.requireWorkspace(requireId(params.workspaceId, "workspaceId"));
    const config = await this.readConfig();
    const agent = await this.readAgent(requireId(params.agentId, "agentId"));

    const sessionModelId =
      params.modelId == null ? undefined : requireId(params.modelId, "modelId");
    const resolved = resolveModel({
      sessionModelId,
      agentModelId: agent.modelId,
      defaultModel: config.defaultModel,
    });
    if (!resolved) {
      // 三级解析都没拿到模型：「给这个助手挑一个模型」那条文案，结构化原因在 detail 里
      throw new HostError("config_invalid", {
        messageKey: "error.modelUnresolved",
        detail: { agentId: agent.id, defaultModel: config.defaultModel ?? null },
      });
    }
    const model = config.models.find((item) => item.id === resolved.modelId);
    if (!model) {
      // 调用方点名要的模型不存在 → 找不到；配置自己指着不存在的模型 → 解析出来的模型用不了
      if (resolved.level === "session") {
        throw new HostError("not_found", {
          params: { entity: "model" },
          detail: { modelId: resolved.modelId, level: resolved.level },
        });
      }
      throw new HostError("config_invalid", {
        messageKey: "error.modelUnresolved",
        detail: { modelId: resolved.modelId, level: resolved.level, agentId: agent.id },
      });
    }

    const createdAt = this.now();
    const draft: Session = {
      id: randomUUID(),
      workspaceId: workspace.id,
      name: defaultSessionName(createdAt),
      nameIsAuto: true,
      pinned: false,
      agentId: agent.id,
      modelId: model.id,
      // 新建的会话不选档位：思考强度跟随助手定义上的那份
      thinkingLevel: null,
      // 新建的会话没压过：两条压缩路径各写各的（`markCompacted`）
      compactedAt: null,
      compactionMode: null,
      // 两条阈值不在这里定：NULL = 跟模型走，要给这一段单独调就写这两列
      handoffThreshold: null,
      guardThreshold: null,
      // 谁开的这段会话、自动交接开不开：**创建那一刻写死**（用户建 0 / 平级会话 1）
      autoHandoff: params.autoHandoff === true,
      lineage: params.lineage ?? null,
      // 待交接只由「答完交接题、当时不闲」这一条路写；刚建出来的会话没有待交接
      pendingHandoff: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.drafts.put(draft);

    const context = await this.viewContext(
      config,
      [[workspace.id, workspace]],
      [[agent.id, agent]],
    );
    const view = await this.composeView(draft, context);
    return { session: view };
  }

  /**
   * 把草稿落成 `sessions` 的一行：第一次真正用到它时用同一个 id 写（PLAN §4）。
   *
   * 五个调用方，全靠它幂等：`session.send`（首发即落库）、`session.start`（`ChatRunner.start`
   * 装配之前先落库）、`asset.begin`（素材行要按 `sessionId` 挂外键）、平级会话建会话、交接开
   * 新会话。谁先到谁写。
   *
   * 已经在库里就直接返回那一行；草稿不在、库里也没这一行就是 `not_found`。先把草稿摘掉再
   * 写库：两次并发的调用里后到的那一次就抢不到同一份草稿，不会两次插同一行；写失败时把草稿
   * 放回去，下一次还能再试。
   *
   * 但「抢不到草稿」不等于「这段会话不存在」：同一个 id 的并发调用（例如一次拖进四张图，
   * 每个上传都在 `asset.begin` 里调一次）在这里排队共用同一次写入，免得后到的那次误报
   * `not_found`、也免得那条隐藏的 cwd 消息被写两遍。
   *
   * 落行那一刻顺带写这段会话的第一条消息，见 {@link writeCwdMessage}。
   *
   * `sessionId` 的形状（非空字符串）不在这里判：`WsHub` 已经在分发前校过一次（入参 schema /
   * 唯一的执行点），这里直接用 —— 形状不对的值根本走不到这一层。
   */
  async ensurePersisted(sessionId: string): Promise<Session> {
    const existing = await this.sessions.get(sessionId);
    if (existing) {
      this.drafts.forget(sessionId);
      return existing;
    }
    const running = this.persisting.get(sessionId);
    if (running) return await running;
    const task = this.persistDraft(sessionId);
    this.persisting.set(sessionId, task);
    try {
      return await task;
    } finally {
      this.persisting.delete(sessionId);
    }
  }

  /** 草稿 → 库里那一行（含那条隐藏的 cwd 消息）；并发去重由 {@link ensurePersisted} 负责 */
  private async persistDraft(id: string): Promise<Session> {
    const draft = this.drafts.take(id);
    if (!draft) {
      throw new HostError("not_found", {
        params: { entity: "session" },
        detail: { sessionId: id },
      });
    }
    try {
      await this.sessions.create({
        id: draft.id,
        workspaceId: draft.workspaceId,
        name: draft.name,
        agentId: draft.agentId,
        modelId: draft.modelId,
        // 草稿期间用户先调过档的话，落库时跟着写进去
        thinkingLevel: draft.thinkingLevel,
        // v4 的四列：两条阈值跟模型走（NULL）、开关与血缘是创建时就定死的身份
        handoffThreshold: draft.handoffThreshold,
        guardThreshold: draft.guardThreshold,
        autoHandoff: draft.autoHandoff,
        lineage: draft.lineage,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
      });
      await this.writeCwdMessage(draft);
      // 新行默认是「自动命名、未置顶」；草稿期间用户改过名 / 置过顶的，落库时补写一次
      if (draft.nameIsAuto === false) {
        await this.sessions.renameByUser(draft.id, draft.name, draft.updatedAt);
      }
      if (draft.pinned) {
        await this.sessions.setPinned(draft.id, true, draft.updatedAt);
      }
    } catch (error) {
      this.drafts.put(draft);
      throw error;
    }

    const row = await this.sessions.get(id);
    if (!row) {
      throw new HostError("internal", {
        detail: { reason: "session vanished after insert", id },
      });
    }
    // 草稿变成真行那一刻才第一次出现在其它窗口的侧栏里，所以这里补一条 `created`
    this.emitChanged(row.id, row.workspaceId, "created");
    return row;
  }

  /**
   * 写会话开头那条 `hidden` 的 cwd 消息（`PLAN.md` §4、`CORE.md` §3）。
   *
   * 形状是死的：`role: user` + `hidden`（模型在上下文里能看到它，界面上
   * 不展示，core 的 `Message.hidden`）+ `source { kind: "system", label: "cwd" }`，**正文就是
   * 那个路径**。不拼一句渲染过的话：这条消息用户看不见，模型要的就是路径。
   *
   * 只写在**创建那一刻**：交接换完之后的记忆里没有这条（目录随时问 `cwd` 工具）。
   *
   * cwd 来自这段会话所属的 Workspace（一段会话绑一个项目，cwd 创建即定死），不读进程工作目录。
   */
  private async writeCwdMessage(draft: Session): Promise<void> {
    const workspace = await this.workspaces.get(draft.workspaceId);
    if (!workspace) {
      // 行已经写进去了、外键指着它，所以这里只可能是库被别处改坏了
      throw new HostError("internal", {
        detail: { reason: "workspace_missing", workspaceId: draft.workspaceId },
      });
    }
    // 造的就是 core 的那条消息，原样落库：`hidden` / `source` 都在它身上，不另拆列
    const message = new Message({
      role: AgentNS.Role.User,
      status: AgentNS.MessageStatus.Completed,
      content: workspace.cwd,
      hidden: true,
      // 宿主自己注入的那条消息，**宿主自己填 `source`**（`CORE.md` §3「一律带」/ §14
      // 「宿主注入的由宿主自己填」）：它不是用户说的话，所以不能落成 `{ kind: "user" }`。
      source: { kind: "system", label: "cwd" },
    });
    await this.messages.upsert({
      id: message.id,
      sessionId: draft.id,
      createdAt: this.now(),
      message,
    });
  }

  /** 按 id 打开一段会话（宿主只提供这一种打开方式） */
  async get(params: SessionGetParams): Promise<SessionGetResult> {
    const session = await this.requireSession(params.sessionId);
    const view = await this.composeView(session, await this.viewContext(await this.readConfig()));
    return { session: view };
  }

  /** 改名（PRD D1）：只换名字，id、身份与排序都不动；名字从此归用户 */
  async rename(params: SessionRenameParams): Promise<SessionRenameResult> {
    const session = await this.requireSession(params.sessionId);
    const name = requireId(params.name, "name");
    const updatedAt = this.now();

    const draft = this.drafts.get(session.id);
    if (draft) {
      this.drafts.put({ ...draft, name, nameIsAuto: false, updatedAt });
    } else {
      await this.sessions.renameByUser(session.id, name, updatedAt);
    }

    const view = await this.reloadView(session.id);
    this.emitChanged(view.id, view.workspaceId, "renamed");
    return { session: view };
  }

  /** 手动置顶：只动 `pinned`，不碰创建时间 */
  async pin(params: SessionPinParams): Promise<SessionPinResult> {
    const session = await this.requireSession(params.sessionId);
    if (typeof params.pinned !== "boolean") {
      throw new HostError("invalid_params", {
        params: { field: "pinned" },
        detail: { field: "pinned", reason: "not_boolean" },
      });
    }
    const updatedAt = this.now();

    const draft = this.drafts.get(session.id);
    if (draft) {
      this.drafts.put({ ...draft, pinned: params.pinned, updatedAt });
    } else {
      await this.sessions.setPinned(session.id, params.pinned, updatedAt);
    }

    const view = await this.reloadView(session.id);
    this.emitChanged(view.id, view.workspaceId, "pinned");
    return { session: view };
  }

  /**
   * 硬删一段会话。
   *
   * `dryRun` 先算账（消息数、素材数），客户端据此警告用户。真删是 delete 语句 + 外键级联：
   * 消息行、素材的引用关系（`session_assets`）随会话一起消失。素材行与 `assets/`
   * 下的文件不一定：那张图可能还有别的会话在用，所以把「这段会话引用过哪几份素材」交给
   * asset 层在删完之后再问一次「还剩几张引用」，归零才删（「图片按引用清理」）。
   *
   * 还没落库的草稿也能删：没有行、没有消息、没有素材，代价是零。
   */
  async delete(params: SessionDeleteParams): Promise<SessionRemovalReport> {
    const session = await this.requireSession(params.sessionId);

    const draft = this.drafts.get(session.id);
    if (draft) {
      const draftConsequences = { sessions: 1, messages: 0, assets: 0 };
      if (params.dryRun === true) {
        return { removed: false, consequences: draftConsequences, assetIds: [] };
      }
      this.drafts.forget(session.id);
      await this.runtime.forget(session.id);
      this.emitChanged(session.id, draft.workspaceId, "deleted");
      return { removed: true, consequences: draftConsequences, assetIds: [] };
    }

    const assetRows = await this.assets.listBySession(session.id);
    const consequences = {
      sessions: 1,
      // 这个数来自 `countBySession`（不含 `hidden` 的）：与侧栏摘要的 `messageCount`
      // （来自 `listBySession`）数的是同一批行 —— 两个数必须相等，见 `PLAN.md` §7。
      messages: await this.messages.countBySession(session.id),
      assets: assetRows.length,
    };
    const assetIds = assetRows.map((asset) => asset.id);

    if (params.dryRun === true) {
      return { removed: false, consequences, assetIds };
    }

    await this.runtime.forget(session.id);
    const changes = await this.sessions.delete(session.id);
    const removed = changes > 0;
    if (removed) {
      // 关系行已经随外键没了：现在问「还剩几张引用」，归零的那几份才删字节
      await this.sweepAssets?.(assetIds);
      this.emitChanged(session.id, session.workspaceId, "deleted");
    }
    return { removed, consequences, assetIds };
  }

  /**
   * 撤回。
   *
   * 撤回到某条**用户消息之前**：那条消息及其后全部硬删，被撤回的内容按 core 的内容形状
   * 回给客户端填回输入框（只有纯文本段 + 当时带的素材 id，「带图消息连图一起
   * 恢复」）。不留删除痕迹；agent 正忙时拒绝 —— 不然删的正是它正在写的那几条。
   */
  async revert(params: SessionRevertParams): Promise<SessionRevertResult> {
    const row = await this.requireSession(params.sessionId);
    const anchorId = requireId(params.beforeMessageId, "beforeMessageId");
    if (this.runtime.presence(row.id).status === "working") {
      throw new HostError("busy", { detail: { sessionId: row.id, action: "revert" } });
    }

    const anchorRow = await this.messages.get(anchorId);
    if (!anchorRow || anchorRow.sessionId !== row.id) {
      throw new HostError("not_found", {
        params: { entity: "message" },
        detail: { messageId: anchorId, sessionId: row.id },
      });
    }
    const anchor = anchorRow.message;
    if (anchor.role !== AgentNS.Role.User) {
      throw new HostError("invalid_params", {
        params: { field: "beforeMessageId" },
        detail: { field: "beforeMessageId", reason: "not_a_user_message", role: anchor.role },
      });
    }

    // 锚点已确认存在，所以这次取到的就是「从它开始（含它）」的那一段（A12）
    const doomed = await this.messages.listBySession(row.id, anchor.id);
    const removedMessageIds = doomed.map((message) => message.id);
    /**
     * 回填输入框要挂的素材（只给纯文本 + assetIds，图靠 id 复原）。
     *
     * 两个来源合并：
     *   - `session_assets`：消息落库时记下的关系行（这段会话引用过的素材都在里面）；
     *   - 消息内容里的 `__asset_id`：同一张图可以被好几条消息引用，而关系行是按消息记的 ——
     *     这条消息自己挂了哪几张，content 永远是那个事实。
     */
    const linkedIds = await this.assets.listAssetIdsByMessage(anchor.id);
    const assetIds = [...new Set([...linkedIds, ...assetIdsOf(anchor.content)])];
    const content = textOnlyContent(anchor.content);
    const restoredInput: MessageInput = assetIds.length > 0 ? { content, assetIds } : { content };

    // 关系行随消息级联消失：先记下这段区间的消息引用过哪些素材，删完再看谁归零了
    const doomedAssetIds = await this.collectAssetsOfMessages(removedMessageIds);
    await this.messages.deleteAfter(row.id, anchor.id, { includeSelf: true });
    await this.sweepAssets?.(doomedAssetIds);
    // 删掉的那几条逐条报出去：消息有自己的事件（`message.removed`），客户端按 id 摘掉它们。
    // 不给剩下的条数：条数客户端自己数（事件只说「哪一条没了」）。
    const at = iso(this.now());
    for (const messageId of removedMessageIds) {
      this.emit?.("message.removed", { sessionId: row.id, messageId, at });
    }
    return { removedMessageIds, restoredInput };
  }

  /**
   * 换这段会话的模型。
   *
   * 写的是**会话行**上的 `modelId`：这一段会话以后都用新模型，重开、重启都还是它。换模型
   * 同时把这段会话的思考档位清成「跟随助手定义」—— 档位是模型的档位，同一个名字在不同
   * 模型上对应不同参数，留着就变成把旧模型的参数发给新模型。
   *
   * 忙的时候拒（`busy` + `reason: "working"`），一个字节都不写库 —— 判词与理由见 `PLAN §5.5`：
   * 模型与思考参数是 agent**装配那一刻**读的，忙时改它，手里那批按旧事实跑完、下一批按新事实跑，
   * 同一段会话里两批就用了两个模型。空闲时改完则**当场让那个 agent 退役**
   * （`runtime.invalidateAgent`）—— 出厂配置变了，它不能留着；下一句话按新事实重新装配。
   *
   * `modelId: null` 表示回到助手定义上那个模型（它也没绑时用配置里的兜底）。
   * 历史里已经有图、而新模型不看图时拒绝，并说明原因。
   */
  async setModel(params: SessionSetModelParams): Promise<SessionSetModelResult> {
    const row = await this.requireSession(params.sessionId);
    // 判据在最前面：非空闲就直接拒，后面的校验与写库一步都不走
    this.assertNoWorkInHand(row.id);
    const config = await this.readConfig();

    const modelId =
      params.modelId == null
        ? await this.agentModelIdOf(row.agentId, config)
        : requireId(params.modelId, "modelId");
    const model = config.models.find((item) => item.id === modelId);
    if (!model) {
      throw new HostError("not_found", {
        params: { entity: "model" },
        detail: { modelId },
      });
    }
    if (model.vision !== true && (await this.hasImages(row.id))) {
      throw new HostError("model_unsupported", {
        params: { model: model.name },
        detail: { modelId: model.id, sessionId: row.id, reason: "history_has_images" },
      });
    }

    const updated = model.id === row.modelId ? row : await this.writeModel(row, model.id);
    // 出厂配置变了（模型进了 agent 的装配事实），所以那个 agent 不能留着：空闲的那一支当场退役，
    // 下一句话按新事实重新装配
    if (updated.modelId !== row.modelId) this.runtime.invalidateAgent(row.id);
    const view = await this.composeView(updated, await this.viewContext(config));
    // 换了的模型会出现在别的窗口的状态栏上，推一条让它们去拉
    if (updated.modelId !== row.modelId) {
      this.emitChanged(row.id, row.workspaceId, "settings_changed");
    }
    return { session: view, model: view.model };
  }

  /**
   * 调这段会话的思考档位。
   *
   * 写的是档位名（不是展开后的参数）：档位属于模型，同一个名字在不同模型的策略表里对应
   * 不同参数。`level: null` 表示回到「跟随助手定义」。改助手默认档是另一个动作
   * （`agent.setThinking`）。
   *
   * 与 `setModel` 同一条判据（`assertNoWorkInHand`，见 `PLAN §5.5`）：忙时拒，一个字节都不写库；
   * 空闲时改完同样当场让那个 agent 退役 —— 档位展开出来的参数也进 agent 的出厂配置。
   *
   * 档位名必须在该模型引用的策略表里 —— 表里没有的档发出去只会换来一句 400；模型没有
   * 可调档位时整件事不成立（`unsupported`）。
   */
  async setThinking(params: SessionSetThinkingParams): Promise<SessionSetThinkingResult> {
    const row = await this.requireSession(params.sessionId);
    // 判据在最前面：非空闲就直接拒（先于「这个模型能不能调档」那些校验）
    this.assertNoWorkInHand(row.id);
    const context = await this.viewContext(await this.readConfig());
    const model = this.effectiveModel(row, context.config);
    if (!model) {
      throw new HostError("not_found", {
        params: { entity: "model" },
        detail: { modelId: row.modelId },
      });
    }
    const preset = this.presetOf(model, context.presets);
    if (!preset) {
      throw new HostError("unsupported", {
        params: { what: "thinking levels for this model" },
        detail: { modelId: model.id, preset: model.reasoningPreset ?? null },
      });
    }
    const level = params.level == null ? null : requireId(params.level, "level");
    if (level !== null && !Object.prototype.hasOwnProperty.call(preset.levels, level)) {
      throw new HostError("invalid_params", {
        params: { field: "level" },
        detail: { field: "level", level, levels: Object.keys(preset.levels) },
      });
    }

    const updated = await this.writeThinkingLevel(row, level);
    // 出厂配置变了（档位展开的参数进了 agent 的装配事实）：空闲的那个当场退役，下一句按新事实装
    if (updated.thinkingLevel !== row.thinkingLevel) this.runtime.invalidateAgent(row.id);
    const agent = await this.loadAgent(row.agentId, context);
    this.emitChanged(row.id, row.workspaceId, "settings_changed");
    return { thinking: this.buildThinking(updated, model, agent, context.presets) };
  }

  /**
   * 写这段会话自己的两条阈值（PRD 1.4 的两格 / 4.7 的「有上游默认、会话可覆盖」）。
   *
   * 写的是**会话行**上的 `handoffThreshold`（软线）与 `guardThreshold`（硬线）：省略的那一格
   * 一个字节都不动，显式 `null` 才是「回到跟模型走」—— 模型上那份 `tokenThresholds` 是上游
   * 的默认数字。
   *
   * **这是宿主现读的配置，不是 agent 的出厂配置。** 出厂配置 = 模型 + 它的参数（模型与思考
   * 档位），两条阈值压根不在里面：读它们的那条线由宿主按会话行现读。所以这个方法**不碰 agent、
   * 不碰 Scope、不重建任何东西** —— 与 `setModel` / `setThinking` 正好相反，那两个改的是装配
   * 事实，改完下一次装配要照新事实重造 agent。
   *
   * 校验与建模型那一条同口径：给了就必须是正整数（`0` / 负数 / 小数都不收），两个都给且都不是
   * `null` 时要满足 `handoff < guard`（硬线得给软线留出余量）。
   */
  async setThresholds(params: SessionSetThresholdsParams): Promise<SessionSetThresholdsResult> {
    const row = await this.requireSession(params.sessionId);
    const handoffThreshold = requireThreshold(params.handoffThreshold, "handoffThreshold");
    const guardThreshold = requireThreshold(params.guardThreshold, "guardThreshold");

    // 只在两个都给（且都不是 `null`）时比大小：只给一条时另一条可能是 `null`（跟模型走），
    // 与它比大小没有意义 —— 那条线的数字此刻不在会话行上
    if (
      typeof handoffThreshold === "number" &&
      typeof guardThreshold === "number" &&
      guardThreshold <= handoffThreshold
    ) {
      throw new HostError("invalid_params", {
        params: { field: "guardThreshold" },
        detail: {
          field: "guardThreshold",
          reason: "handoff_not_below_guard",
          handoffThreshold,
          guardThreshold,
        },
      });
    }

    // 只带真的给了的那几格（`undefined` 不是「写空值」，它连这一列都不该出现在语句里）
    const patch: { handoffThreshold?: number | null; guardThreshold?: number | null } = {};
    if (handoffThreshold !== undefined) patch.handoffThreshold = handoffThreshold;
    if (guardThreshold !== undefined) patch.guardThreshold = guardThreshold;

    // 两格都没给：什么也不写、也不推事件（省略 = 不动），回当下的视图
    if (patch.handoffThreshold === undefined && patch.guardThreshold === undefined) {
      return { session: await this.reloadView(row.id) };
    }

    const changed =
      (patch.handoffThreshold !== undefined && patch.handoffThreshold !== row.handoffThreshold) ||
      (patch.guardThreshold !== undefined && patch.guardThreshold !== row.guardThreshold);

    const updated = await this.writeThresholds(row, patch);
    // 这两格在会话行上、也在侧栏摘要里，别的窗口读的是同一行 —— 变了就推一条让它们去拉
    if (changed) {
      this.emitChanged(row.id, row.workspaceId, "settings_changed");
    }
    return { session: await this.reloadView(updated.id) };
  }

  /**
   * 把一批会话行拼成侧栏用的摘要（列表与搜索共用同一份口径）。
   *
   * `nameIsAuto` 直接读库里的那一列：它是「这个名字是不是自动起的」的唯一真值，不由名字内容
   * 反推。
   */
  async summarize(rows: Session[]): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (const row of rows) {
      const stored = await this.messages.listBySession(row.id);
      summaries.push(this.toSummary(row, stored, this.pendingQuestions(row.id)));
    }
    return summaries;
  }

  /** 这段会话上挂着几道题：题在内存里，所以问 `QuestionService`，不查表（查也查不到） */
  private pendingQuestions(sessionId: string): number {
    return this.questions?.countPending(sessionId) ?? 0;
  }

  /** 一行会话 → 侧栏摘要；`pendingCount` 是挂在这段会话上还没答的问题数 */
  private toSummary(row: Session, stored: StoredMessage[], pendingCount: number): SessionSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      nameIsAuto: row.nameIsAuto,
      pinned: row.pinned,
      agentId: row.agentId,
      modelId: row.modelId,
      // 两条阈值：NULL 是常态（跟模型走）—— 这一格给的是会话行上的事实，客户端自己不去猜
      handoffThreshold: row.handoffThreshold,
      guardThreshold: row.guardThreshold,
      // 开关与血缘也是会话行上的事实：一个说明装不下时谁来拿主意，一个说明它从哪来
      autoHandoff: row.autoHandoff,
      lineage: row.lineage,
      // 谁建的：**从血缘派生**（`null` = 人建的），不落库、也不是会话行上的列
      createdBy: row.lineage === null ? "user" : "agent",
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      // 这个数来自 `listBySession` 的长度（不含 `hidden` 的）；删除代价那一边读的是
      // `countBySession`，数的是同一批行。
      messageCount: stored.length,
      lastMessageAt: stored.length === 0 ? null : iso(latestCreatedAt(stored)),
      // 四件事与「压着几条」都是**现读**：这几格不在库里，不是会话字段
      ...this.runtime.presence(row.id),
      inboxPending: this.runtime.inboxPending(row.id),
      hasPendingQuestion: pendingCount > 0,
      // 压缩那两格：成对出现，没压过就整对省略（空 = 没压过，不是「不知道」）
      ...(row.compactedAt === null || row.compactionMode === null
        ? {}
        : {
            compactedAt: iso(row.compactedAt),
            compactionMode: row.compactionMode,
          }),
    };
  }

  /**
   * 记一次压缩（会话行上的 `compactedAt` / `compactionMode`）。
   *
   * 两条压缩路径共用这一处：派生会话被 `AutoMigratePlugin` 自动压 → `auto`；用户答完交接问题、
   * 宿主开新会话 → `manual`（那一条在 `HandoffDocumentService` 里写，落的是同样两列）。
   *
   * 写库失败照抛：调用方（插件的迁移后回声）会把「标不出来」记成一条日志，而那一段上下文
   * 已经压过了 —— 标记是观测事实，不是状态机的输入。
   */
  async markCompacted(sessionId: string, mode: CompactionMode): Promise<void> {
    const row = await this.sessions.get(sessionId);
    if (!row) return;
    await this.sessions.markCompacted(row.id, mode, this.now());
    this.emitChanged(row.id, row.workspaceId, "settings_changed");
  }

  /** 拼一段会话的完整形状（身份 / 模型 / 思考档 / 目录） */
  private async composeView(row: Session, context: ViewContext): Promise<SessionView> {
    const stored = await this.messages.listBySession(row.id);
    const workspace = await this.loadWorkspace(row.workspaceId, context);
    const agent = await this.loadAgent(row.agentId, context);
    const model = this.effectiveModel(row, context.config);

    const modelState: SessionModelState = {
      modelId: model?.id ?? row.modelId,
      // 模型可能在配置里被删掉了：行上的 id 仍然有效（它是这段会话现在用的那个），显示名退回 id
      name: model?.name ?? row.modelId,
      vision: model?.vision === true,
      source: this.modelSource(row, agent, context.config),
    };
    const view: SessionView = {
      ...this.toSummary(row, stored, this.pendingQuestions(row.id)),
      agent: await this.agentState(row.agentId),
      model: modelState,
      thinking: this.buildThinking(row, model, agent, context.presets),
      folder: await toFolderFact(workspace.cwd),
    };
    return view;
  }

  /**
   * 这段会话的助手事实（名字 / 能不能跑）：向 `AgentService` 要结论，自己不下判断。
   *
   * 两格都可以是 `null` —— 没注入读数、或助手定义已经没了（被删 / 读不出来）。
   * 界面拿 `null` 就知道「不知道」，不会把 id 当名字、也不会把「不可用」当成「可用」。
   */
  private async agentState(agentId: string): Promise<SessionAgentState> {
    const described = this.describeAgent ? await this.describeAgent(agentId) : null;
    return {
      agentId,
      name: described?.name ?? null,
      available: described?.available ?? null,
    };
  }

  /** 改完之后重新读一遍再拼视图：改名与置顶都要回写后的完整对象 */
  private async reloadView(sessionId: string): Promise<SessionView> {
    const row = await this.requireSession(sessionId);
    return await this.composeView(row, await this.viewContext(await this.readConfig()));
  }

  /**
   * 推一条 `session.changed`（两个窗口同时开着时，对方界面靠它去拉）。
   *
   * 只报「什么变了 + 够用的定位信息」，不搬整个对象（PLAN §6）。消息的增删改不在这里：
   * 那三件事有自己的事件（带整条消息），这里也没有消息条数 —— 条数客户端自己数。
   */
  private emitChanged(sessionId: string, workspaceId: string, change: SessionChangeKind): void {
    this.emit?.("session.changed", {
      sessionId,
      workspaceId,
      change,
      at: iso(this.now()),
    });
  }

  /**
   * 读配置。
   *
   * `config.json` 是手改得了的文件，它坏了由 SDK 当场恢复出厂，所以这里不再把
   * 解析失败折成别的错——读到的要么是磁盘上那份，要么是已经写回磁盘的出厂配置。
   */
  private async readConfig(): Promise<AppConfig> {
    return await this.configManager.read();
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
   * 按 id 取一段会话：先看库里那一行，再看草稿。两者用同一份行形状，
   * 于是视图拼装、换模型、写档位这些路径对草稿一字不改。
   */
  private async requireSession(sessionId: string): Promise<Session> {
    const id = typeof sessionId === "string" ? sessionId.trim() : "";
    const row = id.length === 0 ? undefined : await this.sessions.get(id);
    if (row) return row;
    const draft = id.length === 0 ? undefined : this.drafts.get(id);
    if (draft) return draft;
    throw new HostError("not_found", {
      params: { entity: "session" },
      detail: { sessionId },
    });
  }

  /**
   * 换模型 / 换思考档位之前那一条判据：**这段会话手上没活**。
   *
   * 它**不是交接准入** —— 交接那一条是「能不能立刻接手一批」的四条判据（`ChatRunner.canHandoffNow`，
   * 含输出闸与交接态）。这一手只问一件事：「手上那批活」在不在。所以：
   *   - `isOutputPaused` 挡着（输出闸关着）也放行 —— 闸管的是「从下一批起还取不取」，不是「手上有没有活」；
   *   - 没有 agent（死的）也放行 —— 没有 agent，就没有「手上那一批活」可打岔；
   *   - 交接态也不在这里判：那时没有一个「手上那批活」要等，而谁能不能动这一段由交接自己那一处说了算。
   *
   * 拒的时候一个字节都不写库（拒因就是那套四个词里的 `working`）：这两手改的是 agent 的出厂
   * 配置（模型客户端 / 思考参数），忙的时候改它，手里那批还会按旧事实跑完、下一批按新事实跑 ——
   * 同一段会话里两批用了两个模型。
   */
  private assertNoWorkInHand(sessionId: string): void {
    const state = this.runtime.agentState(sessionId);
    if (state !== null && state !== "idle") {
      throw new HostError("busy", { detail: { sessionId, reason: "working" } });
    }
  }

  private async requireWorkspace(workspaceId: string): Promise<WorkspaceRow> {
    const id = typeof workspaceId === "string" ? workspaceId.trim() : "";
    const row = id.length === 0 ? undefined : await this.workspaces.get(id);
    if (!row) {
      throw new HostError("not_found", {
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
      throw new HostError("not_found", {
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

  /** 读一个助手定义文件；不存在就是「没有这个助手」（不可用的也要说明原因） */
  private async readAgent(agentId: string): Promise<AgentDefinition> {
    const agent = await this.readAgentOrNull(agentId);
    if (!agent) {
      throw new HostError("not_found", {
        params: { entity: "assistant" },
        detail: { agentId },
      });
    }
    return agent;
  }

  /**
   * 读一个助手定义文件；**文件不在**回 `null`（「没有这个助手」），文件在但读不出来报真实原因。
   *
   * 坏文件不是「没有这个助手」：那是配置坏了，按它自己抛出来的那句报 `config_invalid`。
   */
  private async readAgentOrNull(agentId: string): Promise<AgentDefinition | null> {
    try {
      return await this.agents.read(agentId);
    } catch (error) {
      throw new HostError("config_invalid", {
        messageKey: "agent.fileBroken",
        params: { name: agentId, reason: reasonOf(error) },
        detail: { agentId, reason: reasonOf(error) },
      });
    }
  }

  /**
   * 这段会话**现在**用哪个模型：就是会话行上那个 `modelId`。
   *
   * 它可能已经从配置里删掉了 —— 那时 `model` 为空，调用方按 ID 显示。
   */
  private effectiveModel(row: Session, config: AppConfig): Model | undefined {
    return config.models.find((item) => item.id === row.modelId);
  }

  /**
   * 这个模型是谁定的（两个动作的区别）。
   *
   * 会话行上的模型与助手定义绑的那个一致时算「跟着助手走」；否则算「会话自己定的」
   * （创建时点名，或 `setModel` 改过）。助手没绑模型时它实际上用配置里的兜底，那一档也算
   * 「跟着助手走」：装配时用的参数口径与这里同一个判断（见 `ChatRunner` 的 `sessionModelParams`）。
   */
  private modelSource(row: Session, agent: AgentDefinition | null, config: AppConfig): ModelSource {
    const agentModelId = agent?.modelId ?? config.defaultModel;
    return agentModelId !== undefined && agentModelId === row.modelId ? "agent" : "session";
  }

  /** 助手定义上那个模型（`/model` 不带 id 时回到它）；它没绑且没有兜底时报错 */
  private async agentModelIdOf(agentId: string, config: AppConfig): Promise<string> {
    const agent = await this.readAgentOrNull(agentId);
    const resolved = resolveModel({
      agentModelId: agent?.modelId,
      defaultModel: config.defaultModel,
    });
    if (!resolved) {
      throw new HostError("config_invalid", {
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
  private async writeModel(row: Session, modelId: string): Promise<Session> {
    const updatedAt = this.now();
    const draft = this.drafts.get(row.id);
    if (draft) {
      const next: Session = { ...draft, modelId, thinkingLevel: null, updatedAt };
      this.drafts.put(next);
      return next;
    }
    await this.sessions.setModel(row.id, modelId, updatedAt);
    return { ...row, modelId, thinkingLevel: null, updatedAt };
  }

  /**
   * 把两条阈值写进会话（只写给的那几格，`null` = 回到跟模型走），回写后的行。
   *
   * 草稿还没落库时写进草稿（落库那一刻跟着写进去），与 `writeModel` / `writeThinkingLevel`
   * 同一口径。除 `updatedAt` 之外不碰别的东西，尤其不碰模型与思考档位 —— 这两格与它们无关。
   */
  private async writeThresholds(
    row: Session,
    patch: { handoffThreshold?: number | null; guardThreshold?: number | null },
  ): Promise<Session> {
    const updatedAt = this.now();
    const draft = this.drafts.get(row.id);
    if (draft) {
      const next: Session = { ...draft, ...patch, updatedAt };
      this.drafts.put(next);
      return next;
    }
    await this.sessions.setThresholds(row.id, patch, updatedAt);
    return { ...row, ...patch, updatedAt };
  }

  /** 把思考档位写进会话（`null` = 回到跟随助手定义），回写后的行 */
  private async writeThinkingLevel(row: Session, thinkingLevel: string | null): Promise<Session> {
    const updatedAt = this.now();
    const draft = this.drafts.get(row.id);
    if (draft) {
      const next: Session = { ...draft, thinkingLevel, updatedAt };
      this.drafts.put(next);
      return next;
    }
    await this.sessions.setThinkingLevel(row.id, thinkingLevel, updatedAt);
    return { ...row, thinkingLevel, updatedAt };
  }

  /** 模型引用的思考策略（表里没有、或没有档位，就是「这个模型不可调」） */
  private presetOf(model: Model, presets: ReasoningPresets): ReasoningPreset | undefined {
    const name = model.reasoningPreset;
    if (!name) return undefined;
    const preset = presets[name];
    return preset && Object.keys(preset.levels).length > 0 ? preset : undefined;
  }

  /**
   * 思考强度状态。
   *
   * 三种来源：会话行上选了某一档（`manual`）；没选、而助手定义上的参数正好是某一档
   * （`following_default`）；模型没有思考策略（`not_adjustable`）。
   * 行上那个档位名在当前模型的策略表里不存在（换过模型、或策略表被改）时退回「跟随助手」。
   */
  private buildThinking(
    row: Session,
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
    // 手写在助手定义上、但凑不成任何一档（`detected === undefined` 且带着思考键）。
    //
    // 这一格不能直接用 `thinkingSourceOf()`：那一支会把「凑成一档」判成 `manual`，而**会话视图**
    // 里那仍然是「这一段没选档、跟着助手走」（`following_default` + `selected` 给了那一档）。
    // 两个视图问的问题不同：助手视图问「定义上写的是哪一档」，会话视图问「这一段自己选了吗」。
    const handWritten = detected === undefined && hasThinkingKey(agent?.modelParams, preset.levels);
    return {
      preset: presetName,
      levels,
      selected: detected ?? null,
      source: handWritten ? "custom" : "following_default",
      // 手写过参数时原样交回那一份（它是事实，不是「没设过」）；凑成一档时给那一档的补丁
      params:
        detected !== undefined
          ? (preset.levels[detected] ?? {})
          : handWritten
            ? (agent?.modelParams ?? {})
            : {},
    };
  }

  /** 历史里有没有图（依据：消息内容里的图片段，或这段会话名下带图的素材） */
  private async hasImages(sessionId: string): Promise<boolean> {
    const assets = await this.assets.listBySession(sessionId);
    if (assets.some((asset) => asset.mime.startsWith("image/"))) return true;
    const stored = await this.messages.listBySession(sessionId);
    return stored.some((message) => contentHasImage(message.message.content));
  }

  /** 一批消息引用过的素材 id（删消息之前读一次：关系行随消息级联消失） */
  private async collectAssetsOfMessages(messageIds: string[]): Promise<string[]> {
    const ids = new Set<string>();
    for (const messageId of messageIds) {
      for (const assetId of await this.assets.listAssetIdsByMessage(messageId)) ids.add(assetId);
    }
    return [...ids];
  }
}

/** 一批消息里最晚的创建时间（消息顺序按 seq，时间可能同毫秒，取最大值最稳） */
function latestCreatedAt(stored: StoredMessage[]): number {
  return stored.reduce(
    (latest, message) => (message.createdAt > latest ? message.createdAt : latest),
    0,
  );
}

/** 消息内容里是否有图片段（core 的 `image_url` 段） */
function contentHasImage(content: AgentNS.MessageContent | undefined): boolean {
  if (!content || typeof content === "string") return false;
  return content.some((section) => section.type === "image_url");
}

/** 读不出来时给用户看的那一句：读它的那一手抛出来的原始消息 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
