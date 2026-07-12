import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AppConfig } from "../types";

/**
 * 返回默认配置。
 */
export function getDefaultConfig(): AppConfig {
  return {
    endpoints: [],
    models: [],
  };
}

/**
 * 读取 config.json。文件不存在时返回默认配置。
 */
export function readConfig(filepath: string): AppConfig {
  if (!existsSync(filepath)) {
    return getDefaultConfig();
  }
  const raw = readFileSync(filepath, "utf-8");
  return JSON.parse(raw) as AppConfig;
}

/**
 * 原子写入 config.json：先写临时文件，再 rename，防止写一半崩溃导致损坏。
 */
export function writeConfig(filepath: string, config: AppConfig): void {
  const dir = dirname(filepath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = filepath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tmpPath, filepath);
}
