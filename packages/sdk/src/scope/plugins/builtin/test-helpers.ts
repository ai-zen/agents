import type { AppConfig, ToolEnv, ToolEnvDeps } from "../../../types/index.js";

/** 构造测试用 ToolEnv（deps 用于注入出网依赖，避免 mock openai 模块） */
export function makeEnv(
  cwd: string = process.cwd(),
  config: AppConfig = {} as AppConfig,
  deps?: ToolEnvDeps,
): ToolEnv {
  return deps ? { cwd, config, deps } : { cwd, config };
}
