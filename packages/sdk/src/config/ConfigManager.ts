import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, readdirSync } from "node:fs";
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
  read(): AppConfig {
    if (!existsSync(this.configPath)) {
      return { ...DEFAULT_APP_CONFIG };
    }
    const raw = readFileSync(this.configPath, "utf-8");
    return JSON.parse(raw) as AppConfig;
  }

  write(config: AppConfig): void {
    const dir = dirname(this.configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const tmpPath = this.configPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    renameSync(tmpPath, this.configPath);
  }

  // -----------------------------------------------------------------------
  // 目录 & 默认实体
  // -----------------------------------------------------------------------

  /**
   * 确保基础目录结构存在。
   * 创建 basePath 及所有标准共享子目录（agents/、sub-agents/、skills/ 等）。
   */
  ensureDirs(): void {
    mkdirSync(this.basePath, { recursive: true });
    for (const dir of CONFIG_SUB_DIRS) {
      mkdirSync(join(this.basePath, dir), { recursive: true });
    }
  }

  /**
   * 确保 config.json 存在。不存在时写入出厂默认配置 DSL。
   */
  ensureDefaultConfig(): AppConfig {
    if (existsSync(this.configPath)) {
      return this.read();
    }
    this.ensureDirs();
    this.write(DEFAULT_APP_CONFIG);
    return { ...DEFAULT_APP_CONFIG };
  }

  /**
   * 确保 basePath/agents/default.json 存在。
   *
   * - default.json 已存在 → 返回已有定义，不覆盖
   * - agents/ 为空 → 写入默认 Agent
   * - 已有其他 Agent → 返回 null
   */
  ensureDefaultAgent(): AgentDefinition | null {
    const agentsDir = join(this.basePath, "agents");
    const defaultPath = join(agentsDir, `${DEFAULT_AGENT_ID}.json`);

    if (existsSync(defaultPath)) {
      return JSON.parse(readFileSync(defaultPath, "utf-8")) as AgentDefinition;
    }

    mkdirSync(agentsDir, { recursive: true });

    const existing = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
    if (existing.length > 0) {
      return null;
    }

    const now = new Date().toISOString();
    const definition: AgentDefinition = {
      ...DEFAULT_AGENT_DEFINITION,
      createdAt: now,
      updatedAt: now,
    };

    writeFileSync(defaultPath, JSON.stringify(definition, null, 2), "utf-8");
    return definition;
  }

  /**
   * 确保 basePath/sub-agents/{DEFAULT_SUBAGENT_ID}.json 存在。
   *
   * - 文件已存在 → 返回已有定义，不覆盖
   * - sub-agents/ 为空 → 写入默认通用助手 SubAgent
   * - 已有其他 SubAgent → 返回 null
   */
  ensureDefaultSubAgent(): AgentDefinition | null {
    const subDir = join(this.basePath, "sub-agents");
    const defaultPath = join(subDir, `${DEFAULT_SUBAGENT_ID}.json`);

    if (existsSync(defaultPath)) {
      return JSON.parse(readFileSync(defaultPath, "utf-8")) as AgentDefinition;
    }

    mkdirSync(subDir, { recursive: true });

    const existing = readdirSync(subDir).filter((f) => f.endsWith(".json"));
    if (existing.length > 0) {
      return null;
    }

    const now = new Date().toISOString();
    const definition: AgentDefinition = {
      ...DEFAULT_SUBAGENT_DEFINITION,
      createdAt: now,
      updatedAt: now,
    };

    writeFileSync(defaultPath, JSON.stringify(definition, null, 2), "utf-8");
    return definition;
  }

  /**
   * 一键初始化：目录 + config.json + 默认 Agent + 默认 SubAgent。
   * 已有文件不会被覆盖。
   */
  bootstrap(): {
    config: AppConfig;
    agent: AgentDefinition | null;
    subAgent: AgentDefinition | null;
  } {
    this.ensureDirs();
    const config = this.ensureDefaultConfig();
    const agent = this.ensureDefaultAgent();
    const subAgent = this.ensureDefaultSubAgent();
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
