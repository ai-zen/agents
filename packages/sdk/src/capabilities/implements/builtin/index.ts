import type { Tool } from "@ai-zen/agents-core";

import { cwdTool } from "./cwd";
import { readFileTool } from "./readFile";
import { writeFileTool } from "./writeFile";
import { execTool } from "./exec";
import { mkdirTool } from "./mkdir";
import { rmTool } from "./rm";
import { globTool } from "./glob";
import { lsTool } from "./ls";
import { existTool } from "./exist";
import { findTextTool } from "./findText";
import { downloadFileTool } from "./downloadFile";
import { renameTool } from "./rename";
import { copyTool } from "./copy";
import { batchEditTool } from "./batchEdit";
import { editTool } from "./edit";

/** 15 个内置工具实例，注册与实现一体。 */
export const BUILTIN_TOOLS: Tool[] = [
  cwdTool,
  readFileTool,
  writeFileTool,
  execTool,
  mkdirTool,
  rmTool,
  globTool,
  lsTool,
  existTool,
  findTextTool,
  downloadFileTool,
  renameTool,
  copyTool,
  batchEditTool,
  editTool,
];

export { cwdTool, readFileTool, writeFileTool, execTool, mkdirTool, rmTool, globTool, lsTool, existTool, findTextTool, downloadFileTool, renameTool, copyTool, batchEditTool, editTool };
