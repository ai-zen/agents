import type { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";

import { CwdTool } from "./CwdTool.js";
import { ReadTool } from "./ReadTool.js";
import { InspectFileTool } from "./InspectFileTool.js";
import { WriteTool } from "./WriteTool.js";
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
import { SpawnTool } from "./SpawnTool.js";
import { SleepTool } from "./SleepTool.js";
import { AsyncExecTool } from "./AsyncExecTool.js";
import { AsyncTimeoutTool } from "./AsyncTimeoutTool.js";
import { ViewImageTool } from "./ViewImageTool.js";
import { GenerateImageTool } from "./GenerateImageTool.js";

/**
 * 内置工具类注册表。由 BuiltinToolsScopePlugin 用 ToolEnv 实例化（每个 Scope 一套实例，注入其 cwd）。
 */
export const BUILTIN_TOOL_CLASSES: Array<new (env: ToolEnv) => SdkCallbackTool> = [
  CwdTool,
  ReadTool,
  InspectFileTool,
  WriteTool,
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
  SpawnTool,
  SleepTool,
  AsyncExecTool,
  AsyncTimeoutTool,
  ViewImageTool,
  GenerateImageTool,
];

export {
  CwdTool,
  ReadTool,
  InspectFileTool,
  WriteTool,
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
  SpawnTool,
  SleepTool,
  AsyncExecTool,
  AsyncTimeoutTool,
  ViewImageTool,
  GenerateImageTool,
};
