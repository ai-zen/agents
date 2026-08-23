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
import { ViewImageTool } from "./ViewImageTool.js";
import { GenerateImageTool } from "./GenerateImageTool.js";

/**
 * 全部内置工具类（19 个）。
 * 工具类由 Provider 用 ToolEnv 实例化（每个 Provider 一套实例，注入其 cwd）。
 *
 * 发现层不做任何过滤——工具的可用性由各工具自行声明（SdkCallbackTool.isAvailable，
 * 入参含完整 config + 模型信息），在 buildTools/filter 阶段按声明过滤。
 * 如 GenerateImageTool 依赖 defaultImageModel、ViewImageTool 仅视觉模型可用。
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
  ViewImageTool,
  GenerateImageTool,
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
  ViewImageTool,
  GenerateImageTool,
};
