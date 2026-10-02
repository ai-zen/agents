import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig, AgentDefinition } from "../types/index.js";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_DEFINITION,
  DEFAULT_SUBAGENT_ID,
  DEFAULT_SUBAGENT_DEFINITION,
  DEFAULT_APP_CONFIG,
  DEFAULT_MCP_CONFIG,
  CONFIG_SUB_DIRS,
} from "./constants.js";

/**
 * 配置管理器 — 负责配置文件的读写、目录初始化、默认实体创建。
 */
export class ConfigManager {
  readonly configPath: string;
  readonly basePath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.basePath = dirname(configPath);
  }

  // -----------------------------------------------------------------------
  // config.json
  // -----------------------------------------------------------------------

  /**
   * 读取配置。文件不存在时返回出厂默认配置。
   */
  async read(): Promise<AppConfig> {
    try {
      await fs.access(this.configPath);
    } catch {
      return { ...DEFAULT_APP_CONFIG };
    }
    const raw = await fs.readFile(this.configPath, "utf-8");
    return JSON.parse(raw) as AppConfig;
  }

  async write(config: AppConfig): Promise<void> {
    const dir = dirname(this.configPath);
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }

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
   * models / imageModels 中凡是**没有** `custom: true` 的条目一律视为出厂托管，
   * 会被移除并替换为 DEFAULT_APP_CONFIG 中的最新定义；标了 `custom: true` 的
   * 条目视为用户自有，原样保留。同步结果与磁盘内容一致时不写盘。
   */
  async ensureDefaultConfig(): Promise<AppConfig> {
    let existing: AppConfig;
    try {
      await fs.access(this.configPath);
      existing = await this.read();
    } catch {
      await this.ensureDirs();
      await this.write(DEFAULT_APP_CONFIG);
      return { ...DEFAULT_APP_CONFIG };
    }

    const synced = syncManagedModels(existing);
    if (JSON.stringify(synced) !== JSON.stringify(existing)) {
      await this.write(synced);
    }
    return synced;
  }

  /**
   * 确保 basePath/agents/default.json 存在。
   *
   * - default.json 已存在且 custom === true → 用户声明为自定义，原样返回，不做任何改动
   * - default.json 已存在且 custom !== true → 仅同步出厂提示词（messages），
   *   其余字段（name/permissions/modelId 等）保留；提示词一致时不写盘
   * - agents/ 为空 → 写入默认 Agent
   * - 已有其他 Agent → 返回 null
   */
  async ensureDefaultAgent(): Promise<AgentDefinition | null> {
    const agentsDir = join(this.basePath, "agents");
    const defaultPath = join(agentsDir, `${DEFAULT_AGENT_ID}.json`);

    try {
      const existing = JSON.parse(await fs.readFile(defaultPath, "utf-8")) as AgentDefinition;

      // 用户声明为自定义 → 完全跳过替换
      if (existing.custom === true) return existing;

      // 仅同步提示词；内容一致则不写盘、不动时间戳
      const messages = DEFAULT_AGENT_DEFINITION.messages;
      if (sameMessages(existing.messages ?? [], messages)) return existing;

      const updated: AgentDefinition = {
        ...existing,
        messages,
        updatedAt: new Date().toISOString(),
      };
      await fs.writeFile(defaultPath, JSON.stringify(updated, null, 2), "utf-8");
      return updated;
    } catch {
      // 文件不存在或不可解析，继续走初始化流程
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
   * - sub-agents/ 为空 → 写入默认通用助手 SubAgent
   * - 已有其他 SubAgent → 返回 null
   */
  async ensureDefaultSubAgent(): Promise<AgentDefinition | null> {
    const subDir = join(this.basePath, "sub-agents");
    const defaultPath = join(subDir, `${DEFAULT_SUBAGENT_ID}.json`);

    try {
      await fs.access(defaultPath);
      return JSON.parse(await fs.readFile(defaultPath, "utf-8")) as AgentDefinition;
    } catch {
      // 文件不存在，继续
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
    const config = await this.ensureDefaultConfig();
    const agent = await this.ensureDefaultAgent();
    const subAgent = await this.ensureDefaultSubAgent();
    await this.ensureDefaultMcpConfig();
    return { config, agent, subAgent };
  }

  // -----------------------------------------------------------------------
  // MCP 配置（~/.ai-zen/mcp.json）
  // -----------------------------------------------------------------------

  /** mcp.json 路径：{basePath}/mcp.json */
  get mcpPath(): string {
    return join(this.basePath, "mcp.json");
  }

  /**
   * 确保 basePath/mcp.json 存在。不存在时写入出厂默认 MCP 配置（含 socket-pty 与 chrome-devtools）。
   * 已有文件不被覆盖，尊重用户已配置的 MCP 服务器。
   * @returns 返回当前生效的 MCP 配置原始内容
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
    // 已存在 → 不覆盖，读取返回
    return JSON.parse(await fs.readFile(mcpPath, "utf-8")) as Record<string, unknown>;
  }

  /**
   * 读取 basePath/mcp.json，不存在时返回空结构。
   */
  async readMcpConfig(): Promise<{ mcpServers: Record<string, unknown> }> {
    const mcpPath = this.mcpPath;
    try {
      await fs.access(mcpPath);
    } catch {
      return { mcpServers: {} };
    }
    try {
      return JSON.parse(await fs.readFile(mcpPath, "utf-8")) as { mcpServers: Record<string, unknown> };
    } catch {
      return { mcpServers: {} };
    }
  }

  /**
   * 原子写入 mcp.json。
   */
  async writeMcpConfig(config: { mcpServers: Record<string, unknown> }): Promise<void> {
    await this.ensureDirs();
    await this.writeJson(this.mcpPath, config);
  }

  /** 原子写 JSON 文件（先写 .tmp 再 rename，避免半成品）。 */
  private async writeJson<T>(path: string, data: T): Promise<void> {
    const dir = dirname(path);
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }
    const tmpPath = path + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    await fs.rename(tmpPath, path);
  }
}

/**
 * 同步出厂托管的模型清单（与默认 Agent 的 custom 机制一致）。
 *
 * 规则：
 * - 未标 `custom: true` 的条目 → 由 SDK 托管，从结果中移除，改用 defaults 中的最新定义；
 * - 标了 `custom: true` 的条目 → 用户自有，原样保留；与出厂定义同 id 时用户版本优先；
 * - 默认模型 ID（defaultModel / defaultImageModel / defaultMigrationModel）
 *   在合并后若已不存在 → 回退到出厂默认，避免悬空引用。
 *
 * 端点（endpoints）不参与托管，始终保持用户配置。
 */
export function syncManagedModels(config: AppConfig): AppConfig {
  const pick = <T extends { id: string; custom?: boolean }>(existing: T[] | undefined, defaults: T[]): T[] => {
    const kept = (existing ?? []).filter((m) => m.custom === true);
    const keptIds = new Set(kept.map((m) => m.id));
    // 出厂定义在前，用户自有条目随后；同 id 时用户版本胜出（出厂侧已剔除）
    return [...defaults.filter((m) => !keptIds.has(m.id)), ...kept];
  };

  const models = pick(config.models, DEFAULT_APP_CONFIG.models);
  const imageModels = pick(config.imageModels, DEFAULT_APP_CONFIG.imageModels ?? []);

  const modelIds = new Set(models.map((m) => m.id));
  const imageIds = new Set(imageModels.map((m) => m.id));
  const resolve = (id: string | undefined, ids: Set<string>, fallback: string | undefined): string | undefined =>
    id && ids.has(id) ? id : fallback;

  return {
    ...config,
    models,
    imageModels,
    defaultModel: resolve(config.defaultModel, modelIds, DEFAULT_APP_CONFIG.defaultModel),
    defaultImageModel: resolve(config.defaultImageModel, imageIds, DEFAULT_APP_CONFIG.defaultImageModel),
    defaultMigrationModel: resolve(config.defaultMigrationModel, modelIds, DEFAULT_APP_CONFIG.defaultMigrationModel),
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
  DEFAULT_SUBAGENT_ID,
  DEFAULT_SUBAGENT_DEFINITION,
  DEFAULT_APP_CONFIG,
  DEFAULT_MCP_CONFIG,
  CONFIG_SUB_DIRS,
} from "./constants.js";
