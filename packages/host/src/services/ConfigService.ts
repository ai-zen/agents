/**
 * 配置服务：`config.*`（F-F1 / F-F2 / F-E2 / F-F6 / F-F7 / F-A8 / D21）。
 *
 * 配置只有一处真相：数据根下的 `config.json`，读写都经 SDK 的 `ConfigManager`（D21）。
 * 这个服务负责三件事：
 *
 *   1. **读得安全**：端点密钥读出即掩码（F-F2），明文不出网；顺带把「这份配置哪里不对」
 *      结构化地报出来（F-A8：配错了要能当场修，问题指到具体字段）。
 *   2. **写得及时**：每次写都回报「应用了什么」—— 哪些能力被重载、哪些 Workspace 的 Scope
 *      被回收（随之重连 MCP）。改完不用重启（F-E2），客户端据此提示「已生效」。
 *   3. **删得干净**：被引用的端点拒删并列出引用者（F-F2），默认项指向的东西不存在时
 *      要能指出来（F-F7）。
 *
 * 「保存」这个动作本身不是状态：每次写就是一次生效（F-F1 没有全局保存键）。
 */

import type { AgentRepository } from "@ai-zen/agents-sdk";
import type { AppConfig, ConfigManager, Endpoint } from "@ai-zen/agents-sdk";

import { DEFAULT_LANGUAGE, LANGUAGES, normalizeLanguage, render, type Language, type MessageKey } from "../i18n/index.js";
import { HostError } from "../wire/errors.js";
import { MAX_ASSETS_PER_MESSAGE, MAX_ASSET_BYTES } from "../wire/index.js";
import type {
  ConfigApplyReport,
  ConfigBehavior,
  ConfigDeleteEndpointParams,
  ConfigDeleteEndpointResult,
  ConfigDeleteMcpParams,
  ConfigDeleteMcpResult,
  ConfigGetDiscoveryParams,
  ConfigGetDiscoveryResult,
  ConfigGetParams,
  ConfigGetResult,
  ConfigIssue,
  ConfigLimits,
  ConfigPatch,
  ConfigPatchParams,
  ConfigPatchResult,
  ConfigSaveEndpointParams,
  ConfigSaveEndpointResult,
  ConfigSaveMcpParams,
  ConfigSaveMcpResult,
  ConfigSetDefaultsParams,
  ConfigSetDefaultsResult,
  ConfigView,
  DefaultSelection,
  EndpointInput,
  EndpointView,
  ReferenceList,
  HostReloadParams,
  HostReloadResult,
  HostReloadScope,
  McpEditableScope,
} from "../wire/index.js";
import { DiscoveryService, type WorkspaceCwdLookup } from "./DiscoveryService.js";
import { ModelService } from "./ModelService.js";

/** 改配置时用到的几类「生效」信号（→ {@link ConfigApplyReport}） */
export interface ConfigApplyChange {
  /** `config.json` 被改写了 */
  config: boolean;
  /** 某一层 Mcp 被改写了 */
  mcp: boolean;
  /** 助手定义被改写了（`agent.*` 域用得到，配置域自己不会置它） */
  agents: boolean;
  /** 具体改了哪些段落：`endpoints` / `models` / `imageModels` / `defaults` / `limits` / `behavior` / `mcp` */
  sections: string[];
  /** MCP 变更涉及哪些项目（user 作用域时为空） */
  workspaceIds: string[];
}

/** 改动生效之后能从组装层问到的事实 */
export interface ConfigApplyOutcome {
  /** 因为配置变化被回收（随后会重建）的 Workspace Scope */
  recycledWorkspaceIds?: string[];
  /** 这次改动合成的那一条通知（F-F9：一次改动合成一条通知） */
  noticeId?: string | null;
}

/**
 * 「让改动生效」的注入点。
 *
 * 谁能回收 Scope、谁能发通知，都是组装层知道的事（`ScopeRegistry` / 通知中心）；
 * 配置服务只描述「变了什么」，由这一跳去动手、并回报真的回收了哪些。
 */
export interface ConfigApplyPort {
  apply(change: ConfigApplyChange): Promise<ConfigApplyOutcome> | ConfigApplyOutcome;
}

/** 配置服务的依赖；由单根组装后注入 */
export interface ConfigServiceOptions {
  /** 配置唯一入口（SDK） */
  configManager: ConfigManager;
  /** 模型视图（`ConfigView.models` 与 `model.*` 用同一份口径）；缺省按本服务依赖造一个 */
  models?: ModelService;
  /** 能力发现（`config.getDiscovery` 与 `config.saveMcp` / `config.deleteMcp`）；缺省按本服务依赖造一个 */
  discovery?: DiscoveryService;
  /** 助手定义仓储（检查默认助手还在不在） */
  agents?: AgentRepository;
  /** 按 workspaceId 取 cwd（MCP 的 workspace 作用域要落到项目里） */
  findWorkspace?: WorkspaceCwdLookup;
  /** 让改动生效的注入点；不注入时回报「已重载配置、没有 Scope 被回收」 */
  apply?: ConfigApplyPort;
  /** 时钟，测试注入用；缺省 `Date.now` */
  now?: () => number;
}

/** `host.reload` 认的几档范围（与契约同源） */
const RELOAD_SCOPES: readonly HostReloadScope[] = ["config", "agents", "tools", "skills", "mcp"];

/** 可以写的三档行为开关取值（与 SDK `AppConfig` 的取值一致） */
const ABORTED_MESSAGE_STRATEGIES = ["keep", "drop"] as const;
const ABORTED_TOOL_ROUND_STRATEGIES = ["fill", "drop"] as const;
const AUTO_REFRESH_TOOLS = ["off", "outer-loop-start", "inner-loop-start"] as const;

/** `maxToolOutput` 读不到时的兜底值（与出厂配置一致） */
const FALLBACK_MAX_TOOL_OUTPUT = 32_768;

// ---------------------------------------------------------------------------
// 文案与掩码
// ---------------------------------------------------------------------------

/** 一条给人看的事实（码 = 文案键，与素材层同口径：存码不存句子，D8） */
function text(messageKey: MessageKey, params: Record<string, unknown> = {}): ConfigIssue["text"] {
  return {
    code: messageKey,
    messageKey,
    params,
    message: render(DEFAULT_LANGUAGE, messageKey, params),
  };
}

/**
 * 密钥的掩码（F-F2：明文不出网）。
 *
 * 短密钥整串都掩掉：`sk-1` 这种长度的密钥，露头露尾就等于把整串给人看了。
 */
export function maskApiKey(apiKey: string): string {
  const key = apiKey.trim();
  if (key === "") return "";
  if (key.length <= 8) return "…";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** 必填的文本参数 */
function requireText(value: unknown, field: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") {
    throw new HostError("invalid_params", {
      params: { field },
      detail: { field, reason: "empty" },
    });
  }
  return raw;
}

/** 端点的地址至少要像个 http(s) 地址：拼错的地址会在第一次发请求时才炸出来 */
function requireBaseUrl(value: unknown): string {
  const raw = requireText(value, "endpoint.baseUrl");
  if (!/^https?:\/\//i.test(raw)) {
    throw new HostError("invalid_params", {
      params: { field: "endpoint.baseUrl" },
      detail: { field: "endpoint.baseUrl", reason: "not_http_url", value: raw },
    });
  }
  return raw.replace(/\/+$/, "");
}

/** 只保留「入参真的给了」的字段（`undefined` 表示这次不改它） */
function definedOnly<T extends Record<string, unknown>>(input: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class ConfigService {
  private readonly configManager: ConfigManager;
  private readonly modelService: ModelService;
  private readonly discoveryService: DiscoveryService;
  private readonly agents?: AgentRepository;
  private readonly findWorkspace?: WorkspaceCwdLookup;
  private readonly applyPort?: ConfigApplyPort;
  private readonly now: () => number;

  constructor(options: ConfigServiceOptions) {
    this.configManager = options.configManager;
    this.agents = options.agents;
    this.findWorkspace = options.findWorkspace;
    this.modelService =
      options.models ?? new ModelService({ configManager: options.configManager, agents: options.agents });
    this.discoveryService =
      options.discovery ??
      new DiscoveryService({
        configManager: options.configManager,
        findWorkspace: options.findWorkspace,
      });
    this.applyPort = options.apply;
    this.now = options.now ?? Date.now;
  }

  /** 能力发现服务（组装层要 `scopeAbilityPaths` / `mcpPaths` 时从这里拿同一份） */
  get discovery(): DiscoveryService {
    return this.discoveryService;
  }

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  /** `config.get`（F-F1 / D21：读也走宿主，密钥掩码，同时报出配置问题） */
  async get(_params: ConfigGetParams = {}): Promise<ConfigGetResult> {
    const config = await this.readConfig();
    return { config: await this.toView(config), issues: await this.issuesOf(config) };
  }

  /** `config.getDiscovery`（F-G1 / F-G2 / F-F6）：转给发现服务，同一份口径 */
  async getDiscovery(params: ConfigGetDiscoveryParams = {}): Promise<ConfigGetDiscoveryResult> {
    return await this.discoveryService.discover(params);
  }

  // -------------------------------------------------------------------------
  // 写：小设置
  // -------------------------------------------------------------------------

  /**
   * `config.patch`（F-F1 / F-E2）：默认项、上限、行为开关这些散落的小设置。
   *
   * 端点与模型各有自己的写方法（要做引用检查与掩码处理），不从这里进。
   */
  async patch(params: ConfigPatchParams): Promise<ConfigPatchResult> {
    const config = await this.readConfig();
    const patch: ConfigPatch = params.patch ?? {};
    const sections: string[] = [];
    let next: AppConfig = config;

    if (patch.defaults !== undefined) {
      next = { ...next, ...(await this.mergeDefaults(next, patch.defaults)) };
      sections.push("defaults");
    }
    if (patch.limits !== undefined) {
      next = { ...next, ...this.mergeLimits(next, patch.limits) };
      sections.push("limits");
    }
    if (patch.behavior !== undefined) {
      next = { ...next, ...this.mergeBehavior(next, patch.behavior) };
      sections.push("behavior");
    }

    if (sections.length === 0) {
      // 空补丁也要回报一次（客户端拿它当「已是最新」的确认），但不写盘
      return { config: await this.toView(config), applied: await this.apply({ sections, config: false }) };
    }

    await this.configManager.write(next);
    return {
      config: await this.toView(next),
      applied: await this.apply({ config: true, sections }),
    };
  }

  /**
   * `config.setDefaults`（F-F7 / D2 / D6 / R58）。
   *
   * 与 `config.patch` 的 `defaults` 是同一件事，只是入口更窄：默认助手、兜底模型、
   * 迁移模型、图片模型、取名模型、自动命名开关，以及缺省语言（`hello` 没声明语言时用哪种）。
   */
  async setDefaults(params: ConfigSetDefaultsParams): Promise<ConfigSetDefaultsResult> {
    const config = await this.readConfig();
    const defaults: Partial<DefaultSelection> = params.defaults ?? {};
    const next: AppConfig = { ...config, ...(await this.mergeDefaults(config, defaults)) };
    await this.configManager.write(next);
    return {
      config: await this.toView(next),
      applied: await this.apply({ config: true, sections: ["defaults"] }),
    };
  }

  /**
   * `host.reload`（PRD F-E1 / 裁定 R63）：从磁盘重读一遍，让改动生效。
   *
   * 不写盘：改的是磁盘上的东西（`config.json`、助手定义、技能 / 工具目录、MCP 文件），这里只
   * 把「哪几类要重新装配」交给注入的生效一跳（回收受影响的 Scope + 合成一条通知），出参与
   * `config.patch` 同一份形状，客户端于是可以用同一套提示。
   */
  async reload(params: HostReloadParams = {}): Promise<HostReloadResult> {
    const scope = params.scope;
    if (scope !== undefined && !RELOAD_SCOPES.includes(scope)) {
      throw new HostError("invalid_params", {
        params: { field: "scope" },
        detail: { field: "scope", reason: "not_allowed", value: scope, allowed: [...RELOAD_SCOPES] },
      });
    }
    const reloaded = reloadedOf(scope);
    const config = await this.readConfig();
    const outcome = this.applyPort ? await this.applyPort.apply(reloadChangeOf(reloaded)) : {};
    return {
      config: await this.toView(config),
      applied: {
        appliedAt: new Date(this.now()).toISOString(),
        reloaded,
        recycledWorkspaceIds: outcome.recycledWorkspaceIds ?? [],
        // 重载本身不需要重启：Scope 回收之后下一次请求会按新读到的磁盘状态重建
        restartRequired: false,
        noticeId: outcome.noticeId ?? null,
      },
    };
  }

  // -------------------------------------------------------------------------
  // 写：端点
  // -------------------------------------------------------------------------

  /**
   * `config.saveEndpoint`（F-F2）：同一个方法兼创建与修改。
   *
   * `apiKey` 省略 = 保留原值。把掩码当密钥存回去是这条路上最容易犯的错，所以：
   *   - 省略 → 保留；
   *   - 传回来的值正好等于当前掩码 → 当作「没改」（客户端把读到的整行原样写回来了）；
   *   - 空串 → 把密钥清掉（这是唯一能清掉它的写法）。
   */
  async saveEndpoint(params: ConfigSaveEndpointParams): Promise<ConfigSaveEndpointResult> {
    const input: EndpointInput = params.endpoint;
    const id = requireText(input?.id, "endpoint.id");
    const config = await this.readConfig();
    const existing = config.endpoints.find((endpoint) => endpoint.id === id);

    const apiKey = this.resolveApiKey(input.apiKey, existing);
    const saved: Endpoint = {
      ...(existing ?? { id, name: "", baseUrl: "", apiKey: "" }),
      id,
      name: requireText(input.name, "endpoint.name"),
      baseUrl: requireBaseUrl(input.baseUrl),
      apiKey,
      ...definedOnly({
        description: input.description,
        capabilities: input.capabilities,
      }),
    };

    const endpoints = existing
      ? config.endpoints.map((endpoint) => (endpoint.id === id ? saved : endpoint))
      : [...config.endpoints, saved];
    const next: AppConfig = { ...config, endpoints };
    await this.configManager.write(next);

    return {
      endpoint: toEndpointView(saved),
      applied: await this.apply({ config: true, sections: ["endpoints"] }),
    };
  }

  /**
   * `config.deleteEndpoint`（F-F2）：被模型引用时拒删并列出引用者。
   *
   * `dryRun` 只算引用：客户端先拿这份清单去问用户（F-F9 的二次确认）。
   */
  async deleteEndpoint(params: ConfigDeleteEndpointParams): Promise<ConfigDeleteEndpointResult> {
    const endpointId = requireText(params.endpointId, "endpointId");
    const config = await this.readConfig();
    if (!config.endpoints.some((endpoint) => endpoint.id === endpointId)) {
      throw new HostError("not_found", { params: { entity: "endpoint" }, detail: { endpointId } });
    }

    const references = referencesToEndpoint(config, endpointId);
    if (references.referenced) {
      throw new HostError("config_invalid", {
        messageKey: "config.referenced",
        params: {
          count: references.items.length,
          names: references.items.map((item) => item.name).join(", "),
        },
        detail: { endpointId, references },
      });
    }
    if (params.dryRun === true) return { removed: false, references };

    const next: AppConfig = {
      ...config,
      endpoints: config.endpoints.filter((endpoint) => endpoint.id !== endpointId),
    };
    await this.configManager.write(next);
    return { removed: true, references };
  }

  // -------------------------------------------------------------------------
  // 写：MCP（按 id 增删改）
  // -------------------------------------------------------------------------

  /**
   * `config.saveMcp`（F-F6 / F-G1）：有 id 则改、无则建，一次只动一条。
   *
   * `workspace` 作用域要落到某个项目自己的 `.ai-zen/mcp.json` 里，所以必须给 `workspaceId`。
   * 合并与落盘的规则不在这里：发现服务的写入口只作一件事（把这一条叠到磁盘原文上），
   * 于是这一版不认识的字段与 `oauth` 原样保留（F-F6）。
   */
  async saveMcp(params: ConfigSaveMcpParams): Promise<ConfigSaveMcpResult> {
    const cwd = await this.mcpWriteCwd(params.scope, params.workspaceId);
    const layer = await this.discoveryService.writeMcpEntry(params.scope, params.entry, cwd);
    return {
      layer,
      applied: await this.apply({
        mcp: true,
        sections: ["mcp"],
        workspaceIds: params.scope === "workspace" && params.workspaceId ? [params.workspaceId] : [],
      }),
    };
  }

  /**
   * `config.deleteMcp`（F-F6）：删掉这一层里的一条。
   *
   * `id` 本来就不在这一层里时不是失败（`removed: false`）：重试一次删除、或另一个客户端
   * 先一步删掉了，都不该变成一个错误（与 `config.deleteEndpoint` 的 `removed` 同口径）。
   */
  async deleteMcp(params: ConfigDeleteMcpParams): Promise<ConfigDeleteMcpResult> {
    const cwd = await this.mcpWriteCwd(params.scope, params.workspaceId);
    const { layer, removed } = await this.discoveryService.deleteMcpEntry(
      params.scope,
      params.id,
      cwd,
    );
    return {
      layer,
      removed,
      applied: await this.apply({
        mcp: true,
        sections: ["mcp"],
        workspaceIds: params.scope === "workspace" && params.workspaceId ? [params.workspaceId] : [],
      }),
    };
  }

  /** MCP 写到哪：`user` 作用域与项目无关，`workspace` 作用域必须能拿到项目的 cwd */
  private async mcpWriteCwd(
    scope: McpEditableScope,
    workspaceId: string | undefined,
  ): Promise<string | null> {
    return scope === "workspace" ? await this.requireWorkspaceCwd(workspaceId) : null;
  }

  // -------------------------------------------------------------------------
  // 视图
  // -------------------------------------------------------------------------

  /** 整个配置的只读形状（密钥掩码，F-F2） */
  async toView(config: AppConfig): Promise<ConfigView> {
    const presets = await this.configManager.readReasoningPresets();
    return {
      endpoints: config.endpoints.map((endpoint) => toEndpointView(endpoint)),
      models: config.models.map((model) => this.modelService.toView(config, model, presets)),
      imageModels: (config.imageModels ?? []).map((model) => ({
        id: model.id,
        name: model.name,
        endpointId: model.endpointId,
        modelName: model.modelName,
        description: model.description ?? null,
        defaultSize: model.defaultSize ?? null,
        defaultQuality: model.defaultQuality ?? null,
        custom: model.custom === true,
      })),
      defaults: {
        defaultAgent: config.defaultAgent ?? null,
        defaultModel: config.defaultModel ?? null,
        defaultMigrationModel: config.defaultMigrationModel ?? null,
        defaultImageModel: config.defaultImageModel ?? null,
        namingModel: config.namingModel ?? null,
        autoTitle: config.autoTitle !== false,
        // 没设置就是 `null`（不是 `"en"`）：读回来的要能与「设成了英文」区分开
        language: config.language ?? null,
      },
      limits: {
        maxToolOutput: config.maxToolOutput ?? FALLBACK_MAX_TOOL_OUTPUT,
        maxAssetBytes: this.assetLimits().maxAssetBytes,
        maxAssetsPerMessage: this.assetLimits().maxAssetsPerMessage,
      },
      behavior: {
        // 读出来的永远是「运行时真正会用的那一档」：SDK 的迁移会把缺失的中断策略补成出厂默认，
        // 工具刷新时机缺省按 inner-loop-start 算
        abortedMessageStrategy: config.abortedMessageStrategy ?? "keep",
        abortedToolRoundStrategy: config.abortedToolRoundStrategy ?? "fill",
        autoRefreshTools: config.autoRefreshTools ?? "inner-loop-start",
      },
      configDir: this.configManager.basePath,
    };
  }

  // -------------------------------------------------------------------------
  // 内部：校验与合并
  // -------------------------------------------------------------------------

  private async readConfig(): Promise<AppConfig> {
    return await this.configManager.read();
  }

  /** 端点的密钥：省略 / 等于当前掩码 → 保留原值；空串 → 清掉 */
  private resolveApiKey(incoming: string | undefined, existing: Endpoint | undefined): string {
    if (incoming === undefined) return existing?.apiKey ?? "";
    const next = incoming.trim();
    if (existing && existing.apiKey !== "" && next === maskApiKey(existing.apiKey)) {
      return existing.apiKey;
    }
    return next;
  }

  /**
   * 默认项合并（F-F7）。
   *
   * 每个 id 都要能落到实处：默认助手要真有定义文件，模型要在模型清单里，图片模型要在图片模型
   * 清单里。传 `null` 表示清空（不是「不改」——不改就不传这个键）。
   */
  private async mergeDefaults(
    config: AppConfig,
    input: Partial<DefaultSelection>,
  ): Promise<
    Pick<
      AppConfig,
      | "defaultAgent"
      | "defaultModel"
      | "defaultMigrationModel"
      | "defaultImageModel"
      | "namingModel"
      | "autoTitle"
      | "language"
    >
  > {
    const modelIds = new Set(config.models.map((model) => model.id));
    const imageModelIds = new Set((config.imageModels ?? []).map((model) => model.id));

    if (input.defaultAgent !== undefined && input.defaultAgent !== null) {
      const agentId = requireText(input.defaultAgent, "defaults.defaultAgent");
      const exists = this.agents ? (await this.agents.read(agentId)) !== null : true;
      if (!exists) {
        throw new HostError("invalid_params", {
          params: { field: "defaults.defaultAgent" },
          detail: { field: "defaults.defaultAgent", reason: "agent_not_found", agentId },
        });
      }
    }

    const requireModel = (value: string | null | undefined, field: string): void => {
      if (value === undefined || value === null) return;
      const modelId = requireText(value, field);
      if (!modelIds.has(modelId)) {
        throw new HostError("invalid_params", {
          params: { field },
          detail: { field, reason: "model_not_found", modelId },
        });
      }
    };
    requireModel(input.defaultModel, "defaults.defaultModel");
    requireModel(input.defaultMigrationModel, "defaults.defaultMigrationModel");
    requireModel(input.namingModel, "defaults.namingModel");

    if (input.defaultImageModel !== undefined && input.defaultImageModel !== null) {
      const imageModelId = requireText(input.defaultImageModel, "defaults.defaultImageModel");
      if (!imageModelIds.has(imageModelId)) {
        throw new HostError("invalid_params", {
          params: { field: "defaults.defaultImageModel" },
          detail: {
            field: "defaults.defaultImageModel",
            reason: "image_model_not_found",
            imageModelId,
          },
        });
      }
    }

    // `null` → 清空：字段删掉，读出来就是「还没选」
    return {
      defaultAgent: pickDefault(config.defaultAgent, input.defaultAgent),
      defaultModel: pickDefault(config.defaultModel, input.defaultModel),
      defaultMigrationModel: pickDefault(config.defaultMigrationModel, input.defaultMigrationModel),
      defaultImageModel: pickDefault(config.defaultImageModel, input.defaultImageModel),
      namingModel: pickDefault(config.namingModel, input.namingModel),
      autoTitle: input.autoTitle === undefined ? config.autoTitle : input.autoTitle,
      language: pickLanguage(config.language, input.language, "defaults.language"),
    };
  }

  /** 上限合并（F-F8：工具输出上限） */
  private mergeLimits(config: AppConfig, input: Partial<Pick<ConfigLimits, "maxToolOutput">>): Pick<AppConfig, "maxToolOutput"> {
    if (input.maxToolOutput === undefined) return { maxToolOutput: config.maxToolOutput };
    const value = input.maxToolOutput;
    if (!Number.isInteger(value) || value <= 0) {
      throw new HostError("invalid_params", {
        params: { field: "limits.maxToolOutput" },
        detail: { field: "limits.maxToolOutput", reason: "not_positive_integer", value },
      });
    }
    return { maxToolOutput: value };
  }

  /** 行为开关合并（D15 的中断修复口径 + F-E2 的工具刷新时机） */
  private mergeBehavior(
    config: AppConfig,
    input: Partial<ConfigBehavior>,
  ): Pick<AppConfig, "abortedMessageStrategy" | "abortedToolRoundStrategy" | "autoRefreshTools"> {
    if (input.abortedMessageStrategy !== undefined) {
      requireChoice(input.abortedMessageStrategy, "behavior.abortedMessageStrategy", ABORTED_MESSAGE_STRATEGIES);
    }
    if (input.abortedToolRoundStrategy !== undefined) {
      requireChoice(input.abortedToolRoundStrategy, "behavior.abortedToolRoundStrategy", ABORTED_TOOL_ROUND_STRATEGIES);
    }
    if (input.autoRefreshTools !== undefined) {
      requireChoice(input.autoRefreshTools, "behavior.autoRefreshTools", AUTO_REFRESH_TOOLS);
    }
    return {
      abortedMessageStrategy: input.abortedMessageStrategy ?? config.abortedMessageStrategy,
      abortedToolRoundStrategy: input.abortedToolRoundStrategy ?? config.abortedToolRoundStrategy,
      autoRefreshTools: input.autoRefreshTools ?? config.autoRefreshTools,
    };
  }

  /** workspace 作用域的 MCP 要写到项目里，所以必须能拿到 cwd */
  private async requireWorkspaceCwd(workspaceId: string | undefined): Promise<string> {
    const id = requireText(workspaceId, "workspaceId");
    const workspace = this.findWorkspace ? await this.findWorkspace(id) : undefined;
    if (!workspace) {
      throw new HostError("not_found", {
        params: { entity: "workspace" },
        detail: {
          workspaceId: id,
          reason: this.findWorkspace ? "workspace_not_found" : "workspace_lookup_not_configured",
        },
      });
    }
    return workspace.cwd;
  }

  /** 附件上限（D5：20MB/张、4 张/条）：与 wire 层的常量同源 */
  private assetLimits(): { maxAssetBytes: number; maxAssetsPerMessage: number } {
    return { maxAssetBytes: MAX_ASSET_BYTES, maxAssetsPerMessage: MAX_ASSETS_PER_MESSAGE };
  }

  // -------------------------------------------------------------------------
  // 内部：配置问题（F-A8）
  // -------------------------------------------------------------------------

  /**
   * 这份配置现在有什么问题。
   *
   * `error` 是「这么用会立刻失败」（模型指向不存在的端点、默认模型没了）；
   * `warning` 是「能跑但不对劲」（端点还没配密钥、交接线不低于硬线）。
   * 每条都带 `path`，客户端据此把光标放到那一栏。
   */
  private async issuesOf(config: AppConfig): Promise<ConfigIssue[]> {
    const issues: ConfigIssue[] = [];

    config.endpoints.forEach((endpoint, index) => {
      if (endpoint.apiKey.trim() === "") {
        issues.push({
          severity: "warning",
          code: "endpoint_no_key",
          text: text("endpoint.noKey", { endpoint: endpoint.name === "" ? endpoint.id : endpoint.name }),
          path: `endpoints[${index}].apiKey`,
        });
      }
    });

    config.models.forEach((model, index) => {
      if (!config.endpoints.some((endpoint) => endpoint.id === model.endpointId)) {
        issues.push({
          severity: "error",
          code: "model_endpoint_missing",
          text: text("model.endpointMissing", { model: model.name, id: model.endpointId }),
          path: `models[${index}].endpointId`,
        });
      }
      if (model.tokenThresholds.handoff >= model.tokenThresholds.guard) {
        issues.push({
          severity: "warning",
          code: "threshold_order",
          text: text("config.issue.thresholdOrder", {
            name: model.name,
            handoff: model.tokenThresholds.handoff,
            guard: model.tokenThresholds.guard,
          }),
          path: `models[${index}].tokenThresholds`,
        });
      }
    });

    const modelIds = new Set(config.models.map((model) => model.id));
    const defaultChecks: { field: string; value: string | undefined }[] = [
      { field: "defaultModel", value: config.defaultModel },
      { field: "defaultMigrationModel", value: config.defaultMigrationModel },
      { field: "namingModel", value: config.namingModel },
    ];
    for (const check of defaultChecks) {
      if (check.value !== undefined && !modelIds.has(check.value)) {
        issues.push({
          severity: "error",
          code: "default_model_missing",
          text: text("config.issue.defaultMissing", { field: check.field, id: check.value }),
          path: check.field,
        });
      }
    }

    if (config.defaultImageModel !== undefined) {
      const imageIds = new Set((config.imageModels ?? []).map((model) => model.id));
      if (!imageIds.has(config.defaultImageModel)) {
        issues.push({
          severity: "error",
          code: "default_image_model_missing",
          text: text("config.issue.defaultMissing", {
            field: "defaultImageModel",
            id: config.defaultImageModel,
          }),
          path: "defaultImageModel",
        });
      }
    }

    if (config.defaultAgent !== undefined && this.agents) {
      const exists = (await this.agents.read(config.defaultAgent)) !== null;
      if (!exists) {
        issues.push({
          severity: "warning",
          code: "default_agent_missing",
          text: text("config.issue.defaultAgentMissing", { id: config.defaultAgent }),
          path: "defaultAgent",
        });
      }
    }

    return issues;
  }

  // -------------------------------------------------------------------------
  // 内部：生效报告（F-E2）
  // -------------------------------------------------------------------------

  /**
   * 把一次改动「说出来」。
   *
   * `reloaded` 按改动涉及的段落推：端点 / 模型 / 图片模型 / 上限会改变工具与模型的可用性，
   * MCP 会改变工具清单，所以这两种都算 `tools` 重载；`skills` 是每次装配现扫的目录，
   * 配置改动不改变它。
   */
  private async apply(
    change: Partial<ConfigApplyChange> & { sections: string[] },
  ): Promise<ConfigApplyReport> {
    const mcp = change.mcp === true;
    const sections = change.sections;
    const touchesTools =
      mcp ||
      sections.some((section) =>
        ["endpoints", "models", "imageModels", "limits"].includes(section),
      );
    const outcome = this.applyPort
      ? await this.applyPort.apply({
          config: change.config === true,
          mcp,
          agents: change.agents === true,
          sections,
          workspaceIds: change.workspaceIds ?? [],
        })
      : {};

    return {
      appliedAt: new Date(this.now()).toISOString(),
      reloaded: {
        config: change.config === true,
        tools: touchesTools,
        skills: false,
        agents: change.agents === true,
        mcp,
      },
      recycledWorkspaceIds: outcome.recycledWorkspaceIds ?? [],
      // 配置变更走「重连能力」这条路（F-E2），没有需要重启才生效的配置项
      restartRequired: false,
      noticeId: outcome.noticeId ?? null,
    };
  }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 端点定义 → 对外形状（密钥只给掩码，F-F2） */
function toEndpointView(endpoint: Endpoint): EndpointView {
  const apiKey = endpoint.apiKey ?? "";
  return {
    id: endpoint.id,
    name: endpoint.name,
    baseUrl: endpoint.baseUrl,
    apiKeyMasked: maskApiKey(apiKey),
    apiKeySet: apiKey.trim() !== "",
    description: endpoint.description ?? null,
    capabilities: { filesApi: endpoint.capabilities?.filesApi === true },
  };
}

/** 谁在指向这个端点：模型与图片模型 */
function referencesToEndpoint(config: AppConfig, endpointId: string): ReferenceList {
  const items: ReferenceList["items"] = [];
  for (const model of config.models) {
    if (model.endpointId === endpointId) {
      items.push({ kind: "model", id: model.id, name: model.name });
    }
  }
  for (const model of config.imageModels ?? []) {
    if (model.endpointId === endpointId) {
      items.push({ kind: "image_model", id: model.id, name: model.name });
    }
  }
  return { referenced: items.length > 0, items };
}

/** 这次要求重载的范围里，哪几类东西要重新装配（不给范围 = 全部） */
function reloadedOf(scope: HostReloadScope | undefined): ConfigApplyReport["reloaded"] {
  const all = scope === undefined;
  return {
    config: all || scope === "config",
    tools: all || scope === "tools",
    skills: all || scope === "skills",
    agents: all || scope === "agents",
    mcp: all || scope === "mcp",
  };
}

/**
 * 重载要交给生效一跳的改动描述。
 *
 * 只表达「哪几类变了」：重载不写盘，`sections` 于是不参与任何写入，只用来把范围说清楚；
 * `workspaceIds` 留空表示影响所有项目（重读的是全局的磁盘文件）。
 */
function reloadChangeOf(reloaded: ConfigApplyReport["reloaded"]): ConfigApplyChange {
  const sections = Object.entries(reloaded)
    .filter(([, on]) => on)
    .map(([section]) => section);
  return {
    config: reloaded.config,
    mcp: reloaded.mcp,
    agents: reloaded.agents,
    sections,
    workspaceIds: [],
  };
}

/** `null` 表示清空（返回 `undefined`，写盘时字段消失，读出来就是「还没选」） */
function pickDefault(current: string | undefined, incoming: string | null | undefined): string | undefined {
  if (incoming === undefined) return current;
  if (incoming === null) return undefined;
  return incoming.trim() === "" ? undefined : incoming.trim();
}

/**
 * 缺省语言（裁定 R58）：`undefined` 不改，`null` 清掉（回落英文），其余必须是受支持的语言。
 *
 * 不认的值直接驳回而不是悄悄换成英文：界面语言被悄悄改掉，用户会以为自己点错了。
 */
function pickLanguage(
  current: Language | undefined,
  incoming: Language | null | undefined,
  field: string,
): Language | undefined {
  if (incoming === undefined) return current;
  if (incoming === null) return undefined;
  if (typeof incoming !== "string" || !(LANGUAGES as readonly string[]).includes(incoming)) {
    throw new HostError("invalid_params", {
      params: { field },
      detail: { field, reason: "not_a_language", value: incoming, allowed: [...LANGUAGES] },
    });
  }
  return normalizeLanguage(incoming);
}

/** 枚举型字段的取值校验 */
function requireChoice<T extends string>(
  value: string,
  field: string,
  allowed: readonly T[],
): void {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new HostError("invalid_params", {
      params: { field },
      detail: { field, reason: "not_allowed", value, allowed },
    });
  }
}
