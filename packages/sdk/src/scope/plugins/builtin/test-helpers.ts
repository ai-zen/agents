import type { AppConfig, ToolEnv } from "../../../types/index.js";

/** 构造测试用 ToolEnv */
export function makeEnv(
  cwd: string = process.cwd(),
  config: AppConfig = {} as AppConfig,
): ToolEnv {
  return { cwd, config };
}
