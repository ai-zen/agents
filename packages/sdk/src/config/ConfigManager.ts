import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig, AgentDefinition } from "../types/index.js";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_DEFINITION,
  DEFAULT_SUBAGENT_ID,
  DEFAULT_SUBAGENT_DEFINITION,
  DEFAULT_APP_CONFIG,
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
   */
  async ensureDefaultConfig(): Promise<AppConfig> {
    try {
      await fs.access(this.configPath);
      return await this.read();
    } catch {
      await this.ensureDirs();
      await this.write(DEFAULT_APP_CONFIG);
      return { ...DEFAULT_APP_CONFIG };
    }
  }

  /**
   * 确保 basePath/agents/default.json 存在。
   *
   * - default.json 已存在 → 返回已有定义，不覆盖
   * - agents/ 为空 → 写入默认 Agent
   * - 已有其他 Agent → 返回 null
   */
  async ensureDefaultAgent(): Promise<AgentDefinition | null> {
    const agentsDir = join(this.basePath, "agents");
    const defaultPath = join(agentsDir, `${DEFAULT_AGENT_ID}.json`);

    try {
      await fs.access(defaultPath);
      return JSON.parse(await fs.readFile(defaultPath, "utf-8")) as AgentDefinition;
    } catch {
      // default.json 不存在，继续
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
   * 一键初始化：目录 + config.json + 默认 Agent + 默认 SubAgent。
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
    return { config, agent, subAgent };
  }
}

export {
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_DEFINITION,
  DEFAULT_SUBAGENT_ID,
  DEFAULT_SUBAGENT_DEFINITION,
  DEFAULT_APP_CONFIG,
  CONFIG_SUB_DIRS,
} from "./constants.js";
