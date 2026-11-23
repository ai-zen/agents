import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig, AgentDefinition, ReasoningPresets } from "../types/index.js";
import { SILENT_LOG, type LogSink } from "../shared/logger.js";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_DEFINITION,
  DEFAULT_SUBAGENT_ID,
  DEFAULT_SUBAGENT_DEFINITION,
  DEFAULT_APP_CONFIG,
  DEFAULT_MCP_CONFIG,
  CONFIG_SUB_DIRS,
} from "./constants.js";
import { FACTORY_SKILLS, isCustomSkill } from "./factory-skills.js";
import { FACTORY_REASONING_PRESETS, REASONING_PRESETS_FILE } from "./reasoning-presets.js";
import { normalizeConfig } from "./normalize.js";

/**
 * 配置坏了、已经按出厂恢复之后的回调（参数是坏掉的那个文件路径）。
 *
 * 恢复本身在读的那一刻就做完了（写回出厂配置 + 返回出厂配置）；这个回调只负责让上层
 * 能告诉用户「你的配置被重置过一次」。
 */
export type ConfigRecoveredHandler = (path: string) => void | Promise<void>;

/**
 * 配置管理器 — 负责配置文件的读写、目录初始化、默认实体创建。
 */
export class ConfigManager {
  readonly configPath: string;
  readonly basePath: string;

  /** 当前配置里的模型 id 集合（bootstrap 时填充，供默认 Agent 校验 modelId） */
  private knownModelIds: Set<string> = new Set();

  /** 配置坏了被恢复出厂之后要通知的那一下（不注入就只是恢复，不告诉任何人） */
  private readonly onRecovered?: ConfigRecoveredHandler;

  /** 日志口（不注入就不记）：策略表 / 出厂 Skill 读不出来时的那几句话走它 */
  private readonly logger: LogSink;

  /**
   * @param configPath `config.json` 的路径（`basePath` 取它的同级目录）
   * @param onRecovered 配置被恢复出厂之后的回调（可选）
   * @param logger 日志口（可选）：读不出来但已降级的那几处从这里报一句；缺省不记
   */
  constructor(
    configPath: string,
    onRecovered?: ConfigRecoveredHandler,
    logger: LogSink = SILENT_LOG,
  ) {
    this.configPath = configPath;
    this.basePath = dirname(configPath);
    this.onRecovered = onRecovered;
    this.logger = logger;
  }

  // -----------------------------------------------------------------------
  // config.json
  // -----------------------------------------------------------------------

  /**
   * 读取配置。文件不存在时返回出厂默认配置；文件坏了（解析不了 / 不是对象）时
   * 恢复出厂并写回磁盘，也返回出厂默认配置（见 `readRaw`）。
   *
   * 读到即**补位**（`config/normalize.ts`）：缺字段或非法值补成出厂值，上层拿到的永远是
   * 合法形状（阈值两条齐、中断策略合法、端点能力位不缺）。
   * 补位结果不在这里落盘——落盘只在 `ensureDefaultConfig()` 做一次。
   */
  async read(): Promise<AppConfig> {
    const raw = await this.readRaw();
    return raw ? normalizeConfig(raw).config : { ...DEFAULT_APP_CONFIG };
  }

  /**
   * 读磁盘原文（不做任何补位/同步），供 `ensureDefaultConfig()` 对比写盘用。
   *
   * 文件在但读不成配置（JSON 解析不了、或者解析出来不是对象）就是一档「坏」：先把坏文件
   * 改名留档，再用出厂配置写回磁盘，再回调一次，返回出厂配置。写回是为了让下次启动不再
   * 遇到同一个坏文件 —— 只返回默认值不落盘，用户每次开客户端都会再撞一次。
   *
   * 留档不是为了兜底，是为了数据：`config.json` 一恢复，用户的端点与密钥就全没了，
   * 残骸是唯一能查回「我原来配了什么」的地方。
   */
  private async readRaw(): Promise<AppConfig | null> {
    try {
      await fs.access(this.configPath);
    } catch {
      return null;
    }
    const raw = await fs.readFile(this.configPath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 解析不了与「解析出来不是对象」是同一档坏
      parsed = null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      await this.archiveBroken(this.configPath);
      await this.write(DEFAULT_APP_CONFIG);
      await this.onRecovered?.(this.configPath);
      return { ...DEFAULT_APP_CONFIG };
    }
    return parsed as AppConfig;
  }

  async write(config: AppConfig): Promise<void> {
    // `mkdir(recursive)` 幂等：目录已在时直接返回，不必先用 `access` 探一遍
    await fs.mkdir(dirname(this.configPath), { recursive: true });

    const tmpPath = this.configPath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    await fs.rename(tmpPath, this.configPath);
  }

  // -----------------------------------------------------------------------
  // 目录 & 默认实体
  // -----------------------------------------------------------------------

  /**
   * 确保基础目录结构存在。
   * 创建 basePath 及所有标准共享子目录（agents/、sub-agents/、skills/ 等）。
   */
  async ensureDirs(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
    for (const dir of CONFIG_SUB_DIRS) {
      await fs.mkdir(join(this.basePath, dir), { recursive: true });
    }
  }

  /**
   * 确保 config.json 存在。不存在时写入出厂默认配置 DSL。
   *
   * 已存在时执行「出厂模型清单同步」（见 syncManagedModels）：
   * models / imageModels 中凡是**没有** `custom: true` 的 InboxEntry 一律视为出厂托管，
   * 会被移除并替换为 DEFAULT_APP_CONFIG 中的最新定义；标了 `custom: true` 的
   * InboxEntry 视为用户自有，原样保留。同步结果与磁盘内容一致时不写盘。
   */
  async ensureDefaultConfig(): Promise<AppConfig> {
    const onDisk = await this.readRaw();
    if (!onDisk) {
      await this.ensureDirs();
      await this.write(DEFAULT_APP_CONFIG);
      return { ...DEFAULT_APP_CONFIG };
    }

    // 先把缺的字段补成出厂值，再同步出厂模型清单；两者结果与磁盘原文不同才写盘
    const normalized = normalizeConfig(onDisk).config;
    const synced = syncManagedModels(normalized);
    if (JSON.stringify(synced) !== JSON.stringify(onDisk)) {
      await this.write(synced);
    }
    return synced;
  }

  /**
   * 确保 basePath/agents/default.json 存在。
   *
   * - default.json 已存在且 custom === true → 用户声明为自定义，不替换提示词（缺 modelId 仍补）
   * - default.json 已存在且 custom !== true → 同步出厂提示词（messages），
   *   其余字段（name/permissions 等）保留；提示词与 modelId 都一致时不写盘
   * - agents/ 为空 → 写入默认 Agent（含 modelId）
   * - 已有其他 Agent → 返回 null
   *
   * 模型按三级解析（` 会话级覆盖 > AgentDefinition.modelId > AppConfig.defaultModel`）。
   * 这里只负责把默认 Agent 的 `modelId` 补齐 —— 老配置里的 Agent 定义可能根本没写
   * `modelId`（用户的兜底是 `config.defaultModel`），补齐时优先用它，升级才不会改变用户
   * 实际在用的模型。
   *
   * @param defaultModel 配置里的 `defaultModel`（三级解析的兜底那一级）。仅在默认 Agent
   *   **既无 modelId** 且该模型仍在模型清单里时用它补齐，让升级不改变用户实际在用的模型。
   *   注意它不是「永远生效的兜底」：Agent 自己绑了模型就轮不到它（见 `resolveModel`）。
   */
  async ensureDefaultAgent(defaultModel?: string): Promise<AgentDefinition | null> {
    const agentsDir = join(this.basePath, "agents");
    const defaultPath = join(agentsDir, `${DEFAULT_AGENT_ID}.json`);
    const fallbackModelId =
      defaultModel && this.knownModelIds.has(defaultModel)
        ? defaultModel
        : DEFAULT_AGENT_DEFINITION.modelId;

    try {
      const existing = JSON.parse(await fs.readFile(defaultPath, "utf-8")) as AgentDefinition;

      // 缺 modelId → 补上（历史配置升级路径）
      const withModel: AgentDefinition = existing.modelId
        ? existing
        : { ...existing, modelId: fallbackModelId };
      const modelPatched = !existing.modelId;

      // 用户声明为自定义 → 不替换提示词，但补上的 modelId 要落盘
      if (withModel.custom === true) {
        if (modelPatched) {
          await fs.writeFile(defaultPath, JSON.stringify(withModel, null, 2), "utf-8");
        }
        return withModel;
      }

      // 仅同步提示词；内容一致则不写盘、不动时间戳
      const messages = DEFAULT_AGENT_DEFINITION.messages;
      const sameMsgs = sameMessages(withModel.messages ?? [], messages);
      if (sameMsgs && !modelPatched) return withModel;

      const updated: AgentDefinition = {
        ...withModel,
        messages,
        updatedAt: sameMsgs ? withModel.updatedAt : new Date().toISOString(),
      };
      await fs.writeFile(defaultPath, JSON.stringify(updated, null, 2), "utf-8");
      return updated;
    } catch (error) {
      // 文件不在 → 正常首次启动，走下面的初始化流程。
      // 读得到却读不出来（不是合法 JSON、权限不对）是另一件事：**不能当成「没有这个文件」** ——
      // 下面的「目录里已有文件就返回 null」会让它静默消失，用户永远不知道自己的定义坏了
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await fs.mkdir(agentsDir, { recursive: true });

    let existing: string[];
    try {
      const allFiles = await fs.readdir(agentsDir);
      existing = allFiles.filter((f) => f.endsWith(".json"));
    } catch {
      existing = [];
    }

    if (existing.length > 0) {
      return null;
    }

    const now = new Date().toISOString();
    const definition: AgentDefinition = {
      ...DEFAULT_AGENT_DEFINITION,
      createdAt: now,
      updatedAt: now,
    };

    await fs.writeFile(defaultPath, JSON.stringify(definition, null, 2), "utf-8");
    return definition;
  }

  /**
   * 确保 basePath/sub-agents/{DEFAULT_SUBAGENT_ID}.json 存在。
   *
   * - 文件已存在 → 返回已有定义，不覆盖
   * - sub-agents/ 为空 → 写入默认通用 AgentDefinition SubAgent
   * - 已有其他 SubAgent → 返回 null
   */
  async ensureDefaultSubAgent(): Promise<AgentDefinition | null> {
    const subDir = join(this.basePath, "sub-agents");
    const defaultPath = join(subDir, `${DEFAULT_SUBAGENT_ID}.json`);

    // 不必先 `access`：`readFile` 在文件不在时自己抛 ENOENT
    try {
      return JSON.parse(await fs.readFile(defaultPath, "utf-8")) as AgentDefinition;
    } catch (error) {
      // 只有「本来就没有」才继续往下建；解析不了 / 读不出来要抛，不能当成「没有」
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await fs.mkdir(subDir, { recursive: true });

    let existing: string[];
    try {
      const allFiles = await fs.readdir(subDir);
      existing = allFiles.filter((f) => f.endsWith(".json"));
    } catch {
      existing = [];
    }

    if (existing.length > 0) {
      return null;
    }

    const now = new Date().toISOString();
    const definition: AgentDefinition = {
      ...DEFAULT_SUBAGENT_DEFINITION,
      createdAt: now,
      updatedAt: now,
    };

    await fs.writeFile(defaultPath, JSON.stringify(definition, null, 2), "utf-8");
    return definition;
  }

  /**
   * 一对初始化：目录 + config.json + 默认 Agent + 默认 SubAgent + 默认 MCP。
   * 已有文件不会被覆盖。
   */
  async bootstrap(): Promise<{
    config: AppConfig;
    agent: AgentDefinition | null;
    subAgent: AgentDefinition | null;
  }> {
    await this.ensureDirs();
    // 先把配置读到当前形状（内含补位），再从里面取 `defaultModel` 去补默认 Agent 的模型
    const config = await this.ensureDefaultConfig();
    this.knownModelIds = new Set((config.models ?? []).map((m) => m.id));
    const agent = await this.ensureDefaultAgent(config.defaultModel);
    const subAgent = await this.ensureDefaultSubAgent();
    await this.ensureDefaultMcpConfig();
    await this.ensureFactorySkills();
    await this.ensureReasoningPresets();
    return { config, agent, subAgent };
  }

  // -----------------------------------------------------------------------
  // 思考策略表（{basePath}/reasoning-presets.json）
  // -----------------------------------------------------------------------

  /** 策略表文件路径（与 config.json 同级） */
  get reasoningPresetsPath(): string {
    return join(this.basePath, REASONING_PRESETS_FILE);
  }

  /**
   * 读取思考策略表。
   *
   * 文件缺失或无法解析时返回出厂种子（内存值，不写盘）——保证调用方永远拿到可用的表：
   * 用户误删文件后客户端仍能正常选档位，下次 `ensureReasoningPresets()` 会重新释放。
   */
  async readReasoningPresets(): Promise<ReasoningPresets> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.reasoningPresetsPath, "utf-8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as ReasoningPresets;
      }
      this.logger.error("[ConfigManager] 思考策略表不是合法对象，按出厂值提供服务");
    } catch (error) {
      // 文件还没释放过是首次启动的正常路径，不吵；其余（读不出来、不是 JSON）要说一声 ——
      // 交出厂表是调用方要的（它要一张能用的表），但换了一张表不能装成没换
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.error(`[ConfigManager] 思考策略表读不出来，按出厂值提供服务：${String(error)}`);
      }
    }
    return { ...FACTORY_REASONING_PRESETS };
  }

  /**
   * 释放 / 同步出厂思考策略。
   *
   * 覆盖策略与 `syncManagedModels` 同构，**按策略逐个判断**（粒度到单个策略）：
   *   - 文件不存在 → 写入出厂种子；
   *   - 某策略标了 `custom: true` → 用户自有，原样保留；
   *   - 某策略未标 → 用出厂版覆盖该策略（内容相同则不写盘）；
   *   - 用户自建的非出厂策略 → 始终保留。
   *
   * @returns 实际写入的策略名列表（未变化 / 用户自有 均不计入）
   */
  async ensureReasoningPresets(): Promise<string[]> {
    let onDisk: ReasoningPresets | null = null;
    try {
      onDisk = JSON.parse(
        await fs.readFile(this.reasoningPresetsPath, "utf-8"),
      ) as ReasoningPresets;
    } catch (error) {
      // 只有「还没有这个文件」可以当成要释放出厂值。文件在却读不出来（不是 JSON、权限不对）
      // 时**不覆盖** —— 那会把用户标了 `custom: true` 的 InboxEntry 一起抹掉，那是「擅自修」
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.error(
          `[ConfigManager] 思考策略表读不出来，本次不写盘（你的表原样留着）：${String(error)}`,
        );
        return [];
      }
    }

    if (!onDisk || typeof onDisk !== "object" || Array.isArray(onDisk)) {
      await fs.mkdir(this.basePath, { recursive: true });
      await fs.writeFile(
        this.reasoningPresetsPath,
        JSON.stringify(FACTORY_REASONING_PRESETS, null, 2),
        "utf-8",
      );
      return Object.keys(FACTORY_REASONING_PRESETS);
    }

    const next: ReasoningPresets = { ...onDisk };
    const written: string[] = [];
    for (const [name, preset] of Object.entries(FACTORY_REASONING_PRESETS)) {
      const existing = onDisk[name];
      if (existing?.custom === true) continue; // 用户改过 → 冻结
      if (JSON.stringify(existing) === JSON.stringify(preset)) continue; // 已是最新
      next[name] = preset;
      written.push(name);
    }

    if (written.length > 0) {
      await fs.writeFile(this.reasoningPresetsPath, JSON.stringify(next, null, 2), "utf-8");
    }
    return written;
  }

  // -----------------------------------------------------------------------
  // 出厂 Skill（{basePath}/skills/<id>/SKILL.md）
  // -----------------------------------------------------------------------

  /**
   * 释放 / 同步出厂 Skill。
   *
   * 覆盖策略与 `syncManagedModels` 同构：
   *   - 磁盘上不存在 → 写入出厂内容；
   *   - 存在且 frontmatter 标了 `custom: "true"` → 用户自有，原样保留；
   *   - 存在但未标 → 视为出厂托管，同步为当前版本内容（内容相同则不写盘）。
   *
   * @returns 实际写入的 Skill id 列表（内容未变化 / 用户自有 均不计入）
   */
  async ensureFactorySkills(): Promise<string[]> {
    const written: string[] = [];

    for (const skill of FACTORY_SKILLS) {
      const dir = join(this.basePath, "skills", skill.id);
      const file = join(dir, "SKILL.md");

      // 读不出来 ≠ 不存在：只有 ENOENT 才能当「还没释放过」，否则下面会拿出厂内容把它盖掉
      let existing: string | null = null;
      try {
        existing = await fs.readFile(file, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger.error(
            `[ConfigManager] 出厂 Skill「${skill.id}」读不出来，本次不覆盖：${String(error)}`,
          );
          continue;
        }
      }

      // 用户声明自有 → 永不覆盖
      if (existing != null && isCustomSkill(existing)) continue;
      // 内容已一致 → 不重复写盘
      if (existing === skill.content) continue;

      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, skill.content, "utf-8");
      written.push(skill.id);
    }

    return written;
  }

  // -----------------------------------------------------------------------
  // MCP 配置（~/.ai-zen/mcp.json）
  // -----------------------------------------------------------------------

  /** mcp.json 路径：{basePath}/mcp.json */
  get mcpPath(): string {
    return join(this.basePath, "mcp.json");
  }

  /**
   * 确保 basePath/mcp.json 存在，三种情况分开（与 `config.json` / `host.json` 同一口径）：
   *
   * - **不存在** → 写入出厂默认 MCP 配置（含 socket-pty 与 chrome-devtools）。这是正常首启，
   *   不回调；
   * - **存在且解析得成对象** → 原样返回，不动用户的文件（哪怕里面全是用户自己的服务器）；
   * - **存在但坏了**（读不了 / 不是 JSON / 不是对象 / 是数组）→ 恢复出厂：先把坏文件改名
   *   留档为 `mcp.json.broken`，再写回出厂默认配置，然后回调一次。
   *
   * @returns 当前生效的 MCP 配置原始内容
   */
  async ensureDefaultMcpConfig(): Promise<Record<string, unknown>> {
    const mcpPath = this.mcpPath;
    try {
      await fs.access(mcpPath);
    } catch {
      // 不存在 → 写入默认
      await this.ensureDirs();
      await this.writeJson(mcpPath, DEFAULT_MCP_CONFIG);
      return { ...DEFAULT_MCP_CONFIG };
    }

    // 存在：读不出来、解析不了、解析出来不是对象（含数组）都是同一档「坏」
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await fs.readFile(mcpPath, "utf-8"));
    } catch {
      parsed = null;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }

    // 恢复出厂：先留一份残骸（用户会问「我原来那些服务器去哪了」），再写回出厂配置
    await this.archiveBroken(mcpPath);
    await this.writeJson(mcpPath, DEFAULT_MCP_CONFIG);
    await this.onRecovered?.(mcpPath);
    return { ...DEFAULT_MCP_CONFIG };
  }

  /**
   * 把坏掉的配置文件改名留档为 `<文件名>.broken`（`config.json` 与 `mcp.json` 同一口径）。
   *
   * 同名残骸已经在就带上时间戳（同一毫秒再撞上就补序号），免得把上一份残骸覆盖掉。
   */
  private async archiveBroken(path: string): Promise<void> {
    const base = `${path}.broken`;
    let target = base;
    for (let index = 0; await this.exists(target); index += 1) {
      target = index === 0 ? `${base}.${Date.now()}` : `${base}.${Date.now()}-${index}`;
    }
    await fs.rename(path, target);
  }

  /** 这个路径在不在（`access` 不抛就是在） */
  private async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /** 原子写 JSON 文件（先写 .tmp 再 rename，避免半成品）。 */
  private async writeJson<T>(path: string, data: T): Promise<void> {
    // 同上：`mkdir(recursive)` 幂等，不必先探测
    await fs.mkdir(dirname(path), { recursive: true });
    const tmpPath = path + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    await fs.rename(tmpPath, path);
  }
}

/**
 * 同步出厂托管的模型清单（与默认 Agent 的 custom 机制一致）。
 *
 * 规则：
 * - 未标 `custom: true` 的 InboxEntry → 由 SDK 托管，从结果中移除，改用 defaults 中的最新定义；
 * - 标了 `custom: true` 的 InboxEntry → 用户自有，原样保留；与出厂定义同 id 时用户版本优先；
 * - 默认模型 ID（defaultImageModel / defaultMigrationModel）
 *   在合并后若已不存在 → 回退到出厂默认，避免悬空引用。
 *
 * `defaultModel`（三级解析的全局兜底）**不在这里校验、也不在这里改写**：它指向一个已被删掉
 * 的模型时，`createAgent` 会在真要跑的时候报 `ModelDefinition "x" not found` —— 那时用户看得见自己
 * 刚删了什么；而在这里默默换成别的模型，只会让「我明明没改它」变成一宗悬案。
 *
 * 端点（endpoints）不参与托管，始终保持用户配置。
 */
export function syncManagedModels(config: AppConfig): AppConfig {
  const pick = <T extends { id: string; custom?: boolean }>(
    existing: T[] | undefined,
    defaults: T[],
  ): T[] => {
    const kept = (existing ?? []).filter((m) => m.custom === true);
    const keptIds = new Set(kept.map((m) => m.id));
    // 出厂定义在前，用户自有 InboxEntry 随后；同 id 时用户版本胜出（出厂侧已剔除）
    return [...defaults.filter((m) => !keptIds.has(m.id)), ...kept];
  };

  const models = pick(config.models, DEFAULT_APP_CONFIG.models);
  const imageModels = pick(config.imageModels, DEFAULT_APP_CONFIG.imageModels ?? []);

  const modelIds = new Set(models.map((m) => m.id));
  const imageIds = new Set(imageModels.map((m) => m.id));
  const resolve = (
    id: string | undefined,
    ids: Set<string>,
    fallback: string | undefined,
  ): string | undefined => (id && ids.has(id) ? id : fallback);

  return {
    ...config,
    models,
    imageModels,
    defaultImageModel: resolve(
      config.defaultImageModel,
      imageIds,
      DEFAULT_APP_CONFIG.defaultImageModel,
    ),
    defaultMigrationModel: resolve(
      config.defaultMigrationModel,
      modelIds,
      DEFAULT_APP_CONFIG.defaultMigrationModel,
    ),
  };
}

/**
 * 比较两段消息列表的提示词内容是否一致。
 *
 * 只比较 role 与 content，忽略 id 等每次生成都可能变化的字段，
 * 避免因 id 差异导致无意义的重复写盘与时间戳漂移。
 */
function sameMessages(a: AgentDefinition["messages"], b: AgentDefinition["messages"]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (message, index) =>
      message.role === b[index].role &&
      JSON.stringify(message.content) === JSON.stringify(b[index].content),
  );
}

export {
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_DEFINITION,
  DEFAULT_MODEL_ID,
  DEFAULT_SUBAGENT_ID,
  DEFAULT_SUBAGENT_DEFINITION,
  DEFAULT_APP_CONFIG,
  DEFAULT_MCP_CONFIG,
  CONFIG_SUB_DIRS,
} from "./constants.js";
