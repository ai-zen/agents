import type { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";

import { CwdTool } from "./CwdTool.js";
import { ReadFileTool } from "./ReadFileTool.js";
import { WriteFileTool } from "./WriteFileTool.js";
import { ExecTool } from "./ExecTool.js";
import { MkdirTool } from "./MkdirTool.js";
import { RmTool } from "./RmTool.js";
import { GlobTool } from "./GlobTool.js";
import { LsTool } from "./LsTool.js";
import { ExistTool } from "./ExistTool.js";
import { FindTextTool } from "./FindTextTool.js";
import { DownloadFileTool } from "./DownloadFileTool.js";
import { RenameTool } from "./RenameTool.js";
import { CopyTool } from "./CopyTool.js";
import { BatchEditTool } from "./BatchEditTool.js";
import { EditTool } from "./EditTool.js";
import { ExecAsyncTool } from "./ExecAsyncTool.js";
import { SleepTool } from "./SleepTool.js";
import { GenerateImageTool } from "./GenerateImageTool.js";

/**
 * 17 个无条件注册的内置工具类。
 * 工具类由 Provider 用 ToolEnv 实例化（每个 Provider 一套实例，注入其 cwd）。
 *
 * 注意：GenerateImageTool 依赖图片模型配置（defaultImageModel），
 * 由 discoverBuiltinTools 按条件实例化，不在此静态注册表中。
 */
export const BUILTIN_TOOL_CLASSES: Array<new (env: ToolEnv) => SdkCallbackTool> = [
  CwdTool,
  ReadFileTool,
  WriteFileTool,
  ExecTool,
  MkdirTool,
  RmTool,
  GlobTool,
  LsTool,
  ExistTool,
  FindTextTool,
  DownloadFileTool,
  RenameTool,
  CopyTool,
  BatchEditTool,
  EditTool,
  ExecAsyncTool,
  SleepTool,
];

export {
  CwdTool,
  ReadFileTool,
  WriteFileTool,
  ExecTool,
  MkdirTool,
  RmTool,
  GlobTool,
  LsTool,
  ExistTool,
  FindTextTool,
  DownloadFileTool,
  RenameTool,
  CopyTool,
  BatchEditTool,
  EditTool,
  ExecAsyncTool,
  SleepTool,
  GenerateImageTool,
};
