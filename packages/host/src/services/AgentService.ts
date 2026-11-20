/**
 * 助手服务：助手与 subagent 定义的增删改查、改默认模型、改思考档位（F-B1…F-B7 / F-F5 / F-G3）。
 *
 * 助手定义是**配置**而不是用户数据（F-G3）：一实体一文件，存在数据根的 `agents/` 与
 * `sub-agents/` 下，能进 git、能手改。所以这里的读写全走 SDK 的 `AgentRepository`，
 * 不碰数据库。有 `function` 字段的那些是 subagent（SDK 的发现口径），落在 `sub-agents/`。
 *
 * 产品的两条硬要求：
 *   - **不可用的也要列出并说明原因**（F-B5）：文件读不出来、模型没了、端点没配密钥，都算
 *     不可用，但都照样出现在清单里，带着一句为什么。
 *   - **删默认助手要连带清默认**（F-F5）：删完还留着一个指向空处的默认助手，下一次建会话
 *     才会炸出来。
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { AgentNS } from "@ai-zen/agents-core";
import {
  AgentRepository,
  DEFAULT_AGENT_DEFINITION,
  DEFAULT_AGENT_ID,
  DEFAULT_SUBAGENT_DEFINITION,
} from "@ai-zen/agents-sdk";
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

import { DEFAULT_LANGUAGE, render, type MessageKey } from "../i18n/index.js";
import { hasThinkingKey, thinkingSourceOf } from "./thinking.js";
import { HostError } from "../wire/errors.js";
import type {
  AgentCreateParams,
  AgentCreateResult,
  AgentDeleteParams,
  AgentDeleteResult,
  AgentGetParams,
  AgentGetResult,
  AgentListResult,
  AgentRestoreFactoryParams,
  AgentRestoreFactoryResult,
  AgentSetModelParams,
  AgentSetModelResult,
  AgentSetThinkingParams,
  AgentSetThinkingResult,
  AgentUpdateParams,
  AgentUpdateResult,
  AgentView,
  ProblemFact,
  ReferenceList,
  ThinkingState,
} from "../wire/index.js";
import { findModel, modelUnavailableProblem, reasoningPresetOf } from "./ModelService.js";

/** 数据根下的两个定义目录（与 SDK 的 `CONFIG_SUB_DIRS` 同口径） */
const DIR_AGENTS = "agents";
const DIR_SUB_AGENTS = "sub-agents";

/** 定义文件名的后缀：文件名 = `<id>.json` */
const JSON_SUFFIX = ".json";

/**
 * 出厂定义的形状：SDK 的那两份常量不带时间戳（时间戳是实例化时补的）。
 */
type FactoryAgentDefinition = Omit<AgentDefinition, "createdAt" | "updatedAt">;

/**
 * 出厂清单：只有 SDK 的出厂定义才有「出厂版本」可恢复，用户自建的助手没有。
 *
 * 与模型那边（`DEFAULT_APP_CONFIG.models`）同一个口径：出厂那一份由 SDK 持有，宿主不另存一份。
 */
const FACTORY_AGENTS: readonly FactoryAgentDefinition[] = [
  DEFAULT_AGENT_DEFINITION,
  DEFAULT_SUBAGENT_DEFINITION,
];

/** 助手服务的依赖；由单根组装后注入 */
export interface AgentServiceOptions {
  /** 配置唯一入口（SDK）：默认助手、兜底模型、思考策略表都在这里 */
  configManager: ConfigManager;
  /** 助手定义仓储；缺省按 `<basePath>/agents/` 造一个 */
  agents?: AgentRepository;
  /** subagent 定义仓储；缺省按 `<basePath>/sub-agents/` 造一个 */
  subAgents?: AgentRepository;
  /**
   * 缺省造那两个仓储时用的日志口（可选）：`list()` 跳过读不出来的定义时那几句走它。
   * 已经注入 `agents` / `subAgents` 时它不用 —— 那两份的日志由造它们的人给。
   */
  logger?: LogSink;
  /** 时钟，测试注入用；缺省 `Date.now` */
  now?: () => number;
}

/** 一条定义来自哪个仓储（决定删除时该删哪个文件） */
type AgentHome = "agents" | "sub-agents";

/**
 * 一个助手的最小只读事实：它现在叫什么、现在能不能用。
 *
 * `describe()` 的返回值。会话视图的助手块（`SessionView.agent`）只要「它现在叫什么、现在能不能
 * 用」这两条：那一块不展示提示词、权限、思考档位，所以不必把整份 `AgentView` 搬过去。
 */
export interface AgentDescription {
  /** 定义上的 id（与传入的 `agentId` 相同） */
  agentId: string;
  /** 定义上的显示名 */
  name: string;
  /** 现在能不能跑（模型 / 端点 / 密钥都齐才算，与 `agent.list` 同一份口径） */
  available: boolean;
}

/**
 * 仓储里读到的一条定义。
 *
 * 两种形状分得开：读出来了（`brokenReason` 为 `null`），或者**文件在但读不出来**
 * （`definition` 为 `null`，原因在 `brokenReason` 里）—— 「没有这个文件」不在这里，它是 `null`。
 */
type LoadedAgent =
  | { id: string; home: AgentHome; definition: AgentDefinition; brokenReason: null }
  | { id: string; home: AgentHome; definition: null; brokenReason: string };

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

/** 一条给人看的事实（码 = 文案键，与素材层同口径：存码不存句子，D8） */
function text(messageKey: MessageKey, params: Record<string, unknown> = {}): ProblemFact {
  return {
    code: messageKey,
    messageKey,
    params,
    message: render(DEFAULT_LANGUAGE, messageKey, params),
  };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 必填的标识：只允许字母数字与 `-` `_` `.`，它同时是文件名（F-G3） */
function requireId(value: unknown, field: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") {
    throw new HostError("invalid_params", {
      params: { field },
      detail: { field, reason: "empty" },
    });
  }
  if (!/^[A-Za-z0-9._-]+$/.test(raw) || raw === "." || raw === "..") {
    throw new HostError("invalid_params", {
      params: { field },
      detail: { field, reason: "not_a_file_name", value: raw },
    });
  }
  return raw;
}

/** 必填的显示名 */
function requireName(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") {
    throw new HostError("invalid_params", {
      params: { field: "agent.name" },
      detail: { field: "agent.name", reason: "empty" },
    });
  }
  return raw;
}

/** 结构相等（思考档位的补丁与定义上的参数要能对得上） */
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
 * 定义上的参数是否「就是这一档」：档位补丁的每个键都在，且值相等。
 *
 * 写进去的是参数而不是档位名（F-B6），所以反推档位时按补丁逐键比对；
 * 补丁允许是定义参数的子集（定义里可能还有与思考无关的参数）。
 */
function matchesPatch(params: ModelParams | undefined, patch: ModelParams): boolean {
  if (!params) return false;
  const entries = Object.entries(patch);
  if (entries.length === 0) return false;
  return entries.every(([key, value]) => deepEqual(params[key], value));
}

/**
 * 去掉「属于某个思考策略档位」的那些参数键，回剩下的参数（没有剩下时 `undefined`）。
 *
 * 判断一个键是不是思考参数只看一件事：它在策略表里出现过（SDK 那套表就是这么定的，
 * 不硬编码任何键名）。换模型之后旧档位的键留在定义上，下一次请求就会把旧模型才认的参数
 * 发给新模型。
 */
function withoutThinkingParams(
  params: ModelParams | undefined,
  preset: ReasoningPreset | undefined,
): ModelParams | undefined {
  if (!params) return undefined;
  if (!preset) return params;
  const levelKeys = new Set(
    Object.values(preset.levels).flatMap((patch) => Object.keys(patch ?? {})),
  );
  if (levelKeys.size === 0) return params;
  const kept: ModelParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (!levelKeys.has(key)) kept[key] = value;
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/** 只保留「入参真的给了」的字段（`undefined` 表示这次不改它） */
function definedOnly<T extends Record<string, unknown>>(input: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

/** 预设消息的校验：至少要有一条（没有 system 的助手定义跑起来没有行为约束） */
function requireMessages(value: unknown): AgentNS.Message[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HostError("invalid_params", {
      params: { field: "agent.messages" },
      detail: { field: "agent.messages", reason: "empty" },
    });
  }
  const messages = value as AgentNS.Message[];
  const hasSystem = messages.some((message) => message.role === AgentNS.Role.System);
  if (!hasSystem) {
    throw new HostError("invalid_params", {
      params: { field: "agent.messages" },
      detail: { field: "agent.messages", reason: "no_system_message" },
    });
  }
  return messages;
}

/**
 * 两份提示词是不是同一份。
 *
 * 只比角色与内容：`Message.System()` 每次都生成新 id，落盘再读回来的 id 不会与出厂常量相等，
 * 拿 id 比永远比不中。SDK 判断「出厂提示词是否已被改过」用的也是这个口径。
 */
function samePrompts(left: readonly AgentNS.Message[], right: readonly AgentNS.Message[]): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (message, index) =>
      message.role === right[index]?.role &&
      JSON.stringify(message.content) === JSON.stringify(right[index]?.content),
  );
}

/**
 * 这条定义是不是已经就是出厂那一份（时间戳不比，`custom` 只看有没有被声明为自定义）。
 *
 * 用来回答「还需要恢复吗」：本来就一样时恢复是空动作，不该报成一次恢复成功。
 */
function isFactoryState(current: AgentDefinition, factory: FactoryAgentDefinition): boolean {
  if (current.custom === true) return false;
  return (
    current.name === factory.name &&
    (current.description ?? null) === (factory.description ?? null) &&
    (current.modelId ?? null) === (factory.modelId ?? null) &&
    deepEqual(current.modelParams ?? {}, factory.modelParams ?? {}) &&
    deepEqual(current.permissions ?? null, factory.permissions ?? null) &&
    deepEqual(current.function ?? null, factory.function ?? null) &&
    samePrompts(current.messages ?? [], factory.messages)
  );
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class AgentService {
  private readonly configManager: ConfigManager;
  private readonly repos: Record<AgentHome, AgentRepository>;
  private readonly now: () => number;

  constructor(options: AgentServiceOptions) {
    this.configManager = options.configManager;
    this.repos = {
      agents:
        options.agents ??
        new AgentRepository(join(options.configManager.basePath, DIR_AGENTS), options.logger),
      "sub-agents":
        options.subAgents ??
        new AgentRepository(join(options.configManager.basePath, DIR_SUB_AGENTS), options.logger),
    };
    this.now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  /**
   * 助手清单（F-B2 / F-B3 / F-B5）。
   *
   * 主助手在前、subagent 在后，各自按 id 排 —— 同一份磁盘状态每次给同一个顺序。
   * 读不出来的定义文件也列出来（`available: false` + 原因）：藏起来会让人以为它没了。
   *
   * `workspaceId` 现在没用上：助手定义的可用性（模型、端点、密钥）是全局配置的事实，与项目
   * 无关；「这个项目里能不能用」要等可用的 Skill / MCP 清单定下来才有答案。
   */
  async list(): Promise<AgentListResult> {
    const config = await this.configManager.read();
    const presets = await this.configManager.readReasoningPresets();
    const loaded = await this.loadAll();

    const agents: AgentView[] = loaded.map((item) => this.toView(config, presets, item));
    return { agents, defaultAgentId: this.resolveDefaultAgentId(config, loaded) };
  }

  /** 按 id 取一个助手 */
  async get(params: AgentGetParams): Promise<AgentGetResult> {
    const id = requireId(params.agentId, "agentId");
    const found = await this.load(id);
    if (!found) {
      throw new HostError("not_found", { params: { entity: "agent" }, detail: { agentId: id } });
    }
    const config = await this.configManager.read();
    const presets = await this.configManager.readReasoningPresets();
    return { agent: this.toView(config, presets, found) };
  }

  /**
   * 一个助手现在叫什么、能不能用（最小只读导出，PRD F-I6 的状态栏助手块用）。
   *
   * 与 `get()` 走同一份 `load()` / `toView()` 口径，只是只回这两条事实：调用方（会话现场快照）
   * 要的是「这个 id 现在叫什么、还能不能跑」，不是整份定义。
   *
   * 拿不到就回 `null`：定义文件已经没了（助手被删，而会话仍记着那个 id，L7），或者文件在但
   * 读不出来（坏 JSON）。这两种情况下「名字」与「可用性」都没有可报的事实。
   */
  async describe(agentId: string): Promise<AgentDescription | null> {
    const id = requireId(agentId, "agentId");
    const found = await this.load(id);
    if (!found || found.definition === null) return null;
    const config = await this.configManager.read();
    const presets = await this.configManager.readReasoningPresets();
    const view = this.toView(config, presets, found);
    return { agentId: view.id, name: view.name, available: view.available };
  }

  // -------------------------------------------------------------------------
  // 写
  // -------------------------------------------------------------------------

  /** 新建助手定义（一实体一文件，F-G3） */
  async create(params: AgentCreateParams): Promise<AgentCreateResult> {
    const input = params.agent;
    const id = requireId(input?.id, "agent.id");
    const existing = await this.load(id);
    if (existing) {
      throw new HostError("invalid_params", {
        params: { field: "agent.id" },
        detail: { field: "agent.id", reason: "already_exists", agentId: id },
      });
    }

    const config = await this.configManager.read();
    this.assertModelReference(config, input.modelId);

    const timestamp = new Date(this.now()).toISOString();
    const definition: AgentDefinition = {
      id,
      name: requireName(input.name),
      ...definedOnly({
        description: input.description,
        modelId: input.modelId,
        modelParams: input.modelParams,
        permissions: input.permissions,
        function: input.function,
      }),
      messages: requireMessages(input.messages),
      // 通过 API 写下的定义算用户自有：SDK 初始化时不会再拿出厂提示词覆盖它
      custom: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const home = this.homeOf(definition);
    await this.repos[home].write(definition);
    const presets = await this.configManager.readReasoningPresets();
    return { agent: this.toView(config, presets, { id, home, definition, brokenReason: null }) };
  }

  /** 编辑助手定义（局部更新；`modelId: ""` 表示把绑定清掉，交给配置里的兜底模型） */
  async update(params: AgentUpdateParams): Promise<AgentUpdateResult> {
    const id = requireId(params.agentId, "agentId");
    const found = await this.requireEditable(id);
    const patch = params.patch ?? {};
    const config = await this.configManager.read();
    this.assertModelReference(config, patch.modelId);

    const base = found.definition;
    const merged: AgentDefinition = {
      ...base,
      ...definedOnly({
        name: patch.name === undefined ? undefined : requireName(patch.name),
        description: patch.description,
        modelParams: patch.modelParams,
        permissions: patch.permissions,
        function: patch.function,
      }),
      messages: patch.messages === undefined ? base.messages : requireMessages(patch.messages),
      // 空串表示「清掉绑定」（三级解析会落到配置里的兜底模型）
      modelId:
        patch.modelId === undefined
          ? base.modelId
          : patch.modelId === ""
            ? undefined
            : patch.modelId,
      custom: true,
      updatedAt: new Date(this.now()).toISOString(),
    };

    const home = this.homeOf(merged);
    await this.repos[home].write(merged);
    if (home !== found.home) await this.repos[found.home].delete(id);

    const presets = await this.configManager.readReasoningPresets();
    return {
      agent: this.toView(config, presets, { id, home, definition: merged, brokenReason: null }),
    };
  }

  /**
   * 删除助手定义（F-F5）。
   *
   * 删的正好是默认助手时连带把默认清掉（`defaultsCleared`）。其它指向关系（别的助手在
   * 权限里点名它的 function）只报在 `references` 里 —— 那些是权限白名单里的一个名字，
   * 删掉定义之后那条名字什么都不指，不是「不能删」。
   *
   * `agentId` 的形状（非空、可做文件名）不在这里判：入参 schema 已经在 `WsHub` 那一处校过
   * （`schema/session.ts` 的 `agentIdSchema`），这里只判「这个助手在不在」。
   */
  async delete(params: AgentDeleteParams): Promise<AgentDeleteResult> {
    const id = params.agentId;
    const found = await this.load(id);
    if (!found) {
      throw new HostError("not_found", { params: { entity: "agent" }, detail: { agentId: id } });
    }

    const config = await this.configManager.read();
    const references = await this.referencesOf(config, id, found.definition);
    const wasDefault =
      config.defaultAgent === id || (config.defaultAgent === undefined && id === DEFAULT_AGENT_ID);

    if (params.dryRun === true) {
      return { removed: false, references, defaultsCleared: false };
    }

    await this.repos[found.home].delete(id);
    if (wasDefault) {
      const next: AppConfig = { ...config };
      delete next.defaultAgent;
      await this.configManager.write(next);
    }
    return { removed: true, references, defaultsCleared: wasDefault };
  }

  /**
   * 改助手的默认模型（F-B4 / F-B1：影响以后的会话，与「改这段会话的模型」是两个动作）。
   *
   * 换了模型就同时把定义上「旧模型档位带来的那些参数」去掉：定义上的参数是给旧模型配的，
   * 旧模型才认的键（例如某个厂商的 `thinking` 形状）发给新模型只会换来一句 400。
   * 定义上与其无关的参数（`temperature` 之类）不动。
   */
  async setModel(params: AgentSetModelParams): Promise<AgentSetModelResult> {
    const id = requireId(params.agentId, "agentId");
    const found = await this.requireEditable(id);
    const modelId = requireId(params.modelId, "modelId");
    const config = await this.configManager.read();
    if (!findModel(config, modelId)) {
      throw new HostError("not_found", { params: { entity: "model" }, detail: { modelId } });
    }

    const presets = await this.configManager.readReasoningPresets();
    const previousModelId = found.definition.modelId ?? config.defaultModel;
    const modelParams =
      previousModelId === modelId
        ? found.definition.modelParams
        : withoutThinkingParams(
            found.definition.modelParams,
            reasoningPresetOf(
              previousModelId ? findModel(config, previousModelId) : undefined,
              presets,
            ),
          );

    const updated: AgentDefinition = {
      ...found.definition,
      modelId,
      custom: true,
      updatedAt: new Date(this.now()).toISOString(),
    };
    if (modelParams === undefined) delete updated.modelParams;
    else updated.modelParams = modelParams;

    await this.repos[found.home].write(updated);
    return {
      agent: this.toView(config, presets, {
        id,
        home: found.home,
        definition: updated,
        brokenReason: null,
      }),
    };
  }

  /**
   * 把思考档位展开成参数写进助手定义（F-B6：写进去的是参数，档位名只是标签）。
   *
   * 档位必须在这个模型的思考策略表里：表里没有的档发出去只会换来一句 400。
   * 合并口径是「在现有参数上叠加这一档的补丁」—— 与思考无关的参数（temperature 之类）不动。
   *
   * `level: null` 是撤回设值：把定义里属于思考策略的那些参数删掉，其余参数照旧留着；
   * 删完不剩任何参数时 `modelParams` 整个从定义里去掉，让「参数即真相」回到模型的默认参数。
   * 与会话那一侧的 `session.setThinking(null)`（改成会话行上的档位名）是两件事。
   */
  async setThinking(params: AgentSetThinkingParams): Promise<AgentSetThinkingResult> {
    const id = requireId(params.agentId, "agentId");
    const found = await this.requireEditable(id);
    const config = await this.configManager.read();
    const presets = await this.configManager.readReasoningPresets();

    const agent = found.definition;
    const modelId = agent.modelId ?? config.defaultModel;
    const model = modelId ? findModel(config, modelId) : undefined;
    if (!model) {
      throw new HostError("not_found", {
        params: { entity: "model" },
        detail: { agentId: id, modelId: modelId ?? null, reason: "no_model_for_agent" },
      });
    }
    const preset = reasoningPresetOf(model, presets);
    if (!preset) {
      throw new HostError("unsupported", {
        params: { what: "thinking levels for this model" },
        detail: { modelId: model.id, preset: model.reasoningPreset ?? null },
      });
    }
    const level = params.level === null ? null : requireId(params.level, "level");
    if (level !== null && !Object.prototype.hasOwnProperty.call(preset.levels, level)) {
      throw new HostError("invalid_params", {
        params: { field: "level" },
        detail: { field: "level", level, levels: Object.keys(preset.levels) },
      });
    }

    // `null` 走「删掉思考那些键」，否则走「叠加这一档的补丁」
    const modelParams =
      level === null
        ? withoutThinkingParams(agent.modelParams, preset)
        : { ...(agent.modelParams ?? {}), ...(preset.levels[level] ?? {}) };

    const updated: AgentDefinition = {
      ...agent,
      custom: true,
      updatedAt: new Date(this.now()).toISOString(),
    };
    if (modelParams === undefined) delete updated.modelParams;
    else updated.modelParams = modelParams;

    await this.repos[found.home].write(updated);
    const view = this.toView(config, presets, {
      id,
      home: found.home,
      definition: updated,
      brokenReason: null,
    });
    return { agent: view, thinking: view.thinking };
  }

  /**
   * 恢复出厂（F-F5：整条替换，与 `model.restoreFactory` 同一个语义）。
   *
   * 出厂那一份来自 SDK 的出厂定义（`DEFAULT_AGENT_DEFINITION` / `DEFAULT_SUBAGENT_DEFINITION`），
   * 用户自建的助手不在出厂清单里，没有可恢复的版本。恢复之后这一条重新归 SDK 托管
   * （`custom: false`，下次初始化会跟着出厂定义同步提示词），提示词 / 模型 / 权限 / 思考参数
   * 全回到出厂那份；`createdAt` 是这个实体诞生的时刻，留着，`updatedAt` 是这次写入。
   *
   * `dryRun` 只算出「恢复之后会是什么样」，不落盘；本来就和出厂一致时回 `restored: false`
   * （没有可恢复的改动，不是失败）。
   */
  async restoreFactory(params: AgentRestoreFactoryParams): Promise<AgentRestoreFactoryResult> {
    const id = requireId(params.agentId, "agentId");
    const found = await this.requireEditable(id);
    const factory = FACTORY_AGENTS.find((item) => item.id === id);
    if (!factory) {
      throw new HostError("invalid_params", {
        messageKey: "agent.notFactory",
        params: { id },
        detail: { agentId: id, reason: "not_a_factory_agent" },
      });
    }

    const config = await this.configManager.read();
    const presets = await this.configManager.readReasoningPresets();
    if (isFactoryState(found.definition, factory)) {
      return { agent: this.toView(config, presets, found), restored: false };
    }

    const restored: AgentDefinition = {
      ...structuredClone(factory),
      createdAt: found.definition.createdAt,
      updatedAt: new Date(this.now()).toISOString(),
    };
    const home = this.homeOf(restored);
    const after = { id, home, definition: restored, brokenReason: null };
    if (params.dryRun === true) {
      return { agent: this.toView(config, presets, after), restored: true };
    }

    await this.repos[home].write(restored);
    // 出厂那份放在另一个目录时（比如被手改到 agents/ 里的 subagent），旧文件跟着删掉
    if (home !== found.home) await this.repos[found.home].delete(id);
    return { agent: this.toView(config, presets, after), restored: true };
  }

  // -------------------------------------------------------------------------
  // 视图
  // -------------------------------------------------------------------------

  /** 一条定义（或一个读不出来的文件）→ 对外形状 */
  toView(config: AppConfig, presets: ReasoningPresets, item: LoadedAgent): AgentView {
    if (item.definition === null) {
      // 文件在但读不出来：照样占一行，说明为什么用不了（F-B5）。原因就是读它的那一手
      // 抛出来的那句话（不是 JSON / 没权限）
      return {
        id: item.id,
        name: item.id,
        description: null,
        modelId: null,
        modelParams: {},
        permissions: null,
        // 提示词与 subagent 定义都读不出来：说「不知道」比编一个空数组诚实
        messages: null,
        function: null,
        isSubAgent: item.home === "sub-agents",
        custom: false,
        isDefault: config.defaultAgent === item.id,
        available: false,
        unavailableReason: text("agent.fileBroken", {
          name: item.id,
          reason: item.brokenReason,
        }),
        thinking: {
          preset: null,
          levels: [],
          selected: null,
          source: "not_adjustable",
          params: {},
        },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    }

    const definition = item.definition;
    const modelId = definition.modelId ?? config.defaultModel ?? null;
    const model = modelId ? findModel(config, modelId) : undefined;
    const unavailable = this.unavailableProblem(config, modelId, model);
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description ?? null,
      modelId: definition.modelId ?? null,
      modelParams: definition.modelParams ?? {},
      permissions: definition.permissions ?? null,
      // 定义本身的形状：提示词与 subagent 定义原样给出（手改的文件可能没写 `messages`，那也归到 null）
      messages: definition.messages ?? null,
      function: definition.function ?? null,
      isSubAgent: definition.function !== undefined,
      custom: definition.custom === true,
      isDefault: config.defaultAgent === definition.id,
      available: unavailable === null,
      unavailableReason: unavailable,
      thinking: this.thinkingOf(model, presets, definition.modelParams),
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
    };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 这个助手现在能不能跑：没模型、模型没了、端点没了/没密钥，各有各的说法 */
  private unavailableProblem(
    config: AppConfig,
    modelId: string | null,
    model: Model | undefined,
  ): ProblemFact | null {
    if (modelId === null) return text("error.modelUnresolved");
    if (!model) return text("agent.modelMissing", { id: modelId });
    return modelUnavailableProblem(config, model);
  }

  /**
   * 思考强度的状态（F-B6 / F-B7）。
   *
   * `manual` = 定义上的参数正好是某一档；`following_default` = 定义没指定，跟着模型默认走；
   * `not_adjustable` = 这个模型引用的策略表里一条档位都没有。
   */
  private thinkingOf(
    model: Model | undefined,
    presets: ReasoningPresets,
    params: ModelParams | undefined,
  ): ThinkingState {
    const presetName = model?.reasoningPreset ?? null;
    const preset = reasoningPresetOf(model, presets);
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
    const detected = levels.find((level) => matchesPatch(params, preset.levels[level] ?? {}));
    return {
      preset: presetName,
      levels,
      selected: detected ?? null,
      source: thinkingSourceOf(detected, hasThinkingKey(params, preset.levels)),
      // 手写过参数时把那一条原样交回去（它是事实，不是「没设过」）；凑成一档时给那一档的补丁
      params:
        detected !== undefined
          ? (preset.levels[detected] ?? {})
          : hasThinkingKey(params, preset.levels)
            ? (params ?? {})
            : {},
    };
  }

  /** 默认助手 id：配置里那个还在就用它，否则回落 `default`，再否则取清单第一个 */
  private resolveDefaultAgentId(config: AppConfig, loaded: LoadedAgent[]): string | null {
    const usable = loaded.filter((item) => item.definition !== null);
    const byId = (id: string | undefined): boolean =>
      id !== undefined && usable.some((item) => item.id === id);
    if (byId(config.defaultAgent)) return config.defaultAgent as string;
    if (byId(DEFAULT_AGENT_ID)) return DEFAULT_AGENT_ID;
    return usable[0]?.id ?? null;
  }

  /** 哪个目录该放这条定义：有 `function` 的是 subagent（SDK 的发现口径） */
  private homeOf(definition: AgentDefinition): AgentHome {
    return definition.function === undefined ? "agents" : "sub-agents";
  }

  /** 读一个定义（两个目录都找）；两个目录都没有这个 id 才回 `null` */
  private async load(id: string): Promise<LoadedAgent | null> {
    for (const home of ["agents", "sub-agents"] as const) {
      const item = await this.loadIn(home, id);
      if (item) return item;
    }
    return null;
  }

  /** 读全部定义（两个目录），读不出来的也占一行 */
  private async loadAll(): Promise<LoadedAgent[]> {
    const result: LoadedAgent[] = [];
    for (const home of ["agents", "sub-agents"] as const) {
      for (const id of await listJsonIds(this.repoDir(home))) {
        const item = await this.loadIn(home, id);
        if (item) result.push(item);
      }
    }
    return result;
  }

  /**
   * 读某个目录里的一个定义。
   *
   * 三件事分得开：读出来了 / 这个目录里没有这个文件（回 `null`，换下一个目录找）/ 文件在但
   * 读不出来（照占一行，原因是读它的那一手抛出来的那句话）。所以这里不需要先 `stat` 探一次
   * 「文件在不在」——「不在」与「坏了」本来就是两个答案。
   */
  private async loadIn(home: AgentHome, id: string): Promise<LoadedAgent | null> {
    try {
      const definition = await this.repos[home].read(id);
      return definition === null ? null : { id, home, definition, brokenReason: null };
    } catch (error) {
      return { id, home, definition: null, brokenReason: reasonOf(error) };
    }
  }

  /** 仓储对应的目录 */
  private repoDir(home: AgentHome): string {
    return join(this.configManager.basePath, home === "agents" ? DIR_AGENTS : DIR_SUB_AGENTS);
  }

  /** 要改定义时先把它读出来；读不出来（坏文件）就没有可改的内容 */
  private async requireEditable(
    id: string,
  ): Promise<LoadedAgent & { definition: AgentDefinition }> {
    const found = await this.load(id);
    if (!found) {
      throw new HostError("not_found", { params: { entity: "agent" }, detail: { agentId: id } });
    }
    if (found.definition === null) {
      throw new HostError("config_invalid", {
        messageKey: "agent.fileBroken",
        params: { name: id, reason: found.brokenReason },
        detail: { agentId: id, path: join(this.repoDir(found.home), `${id}${JSON_SUFFIX}`) },
      });
    }
    return found;
  }

  /** 引用：默认助手 + 别的助手在权限里点名的 subagent function */
  private async referencesOf(
    config: AppConfig,
    agentId: string,
    definition: AgentDefinition | null,
  ): Promise<ReferenceList> {
    const items: ReferenceList["items"] = [];
    if (config.defaultAgent === agentId) {
      items.push({ kind: "default", id: "defaultAgent", name: agentId });
    }

    const functionName = definition?.function?.name;
    if (functionName !== undefined) {
      const loaded = await this.loadAll();
      for (const item of loaded) {
        if (item.id === agentId || item.definition === null) continue;
        if (mentionsSubagent(item.definition, functionName)) {
          items.push({ kind: "agent", id: item.id, name: item.definition.name });
        }
      }
    }
    return { referenced: items.length > 0, items };
  }

  /** `modelId` 给了就必须指向一个存在的模型（写进定义的 id 不能是悬空的） */
  private assertModelReference(config: AppConfig, modelId: string | undefined): void {
    if (modelId === undefined || modelId === "") return;
    if (!findModel(config, modelId)) {
      throw new HostError("invalid_params", {
        params: { field: "agent.modelId" },
        detail: { field: "agent.modelId", reason: "model_not_found", modelId },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 别的助手的权限四维里有没有点名这个 subagent（`allow` / `deny` 都算） */
function mentionsSubagent(definition: AgentDefinition, functionName: string): boolean {
  const policy = definition.permissions?.subagents;
  if (!policy) return false;
  const list = "allow" in policy ? policy.allow : policy.deny;
  return list.includes(functionName);
}

/** 目录下的 `.json` 文件名（去掉后缀）→ id 列表；目录不存在就是空 */
async function listJsonIds(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((file) => file.endsWith(JSON_SUFFIX))
      .map((file) => file.slice(0, -JSON_SUFFIX.length))
      .sort();
  } catch {
    return [];
  }
}

/** 读不出来时给用户看的那一句：读它的那一手抛出来的原始消息，原样带出去 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
