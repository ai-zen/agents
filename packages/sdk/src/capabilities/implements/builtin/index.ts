import type { Tool } from "@ai-zen/agents-core";

import { cwdTool } from "./cwd.js";
import { readFileTool } from "./readFile.js";
import { writeFileTool } from "./writeFile.js";
import { execTool } from "./exec.js";
import { mkdirTool } from "./mkdir.js";
import { rmTool } from "./rm.js";
import { globTool } from "./glob.js";
import { lsTool } from "./ls.js";
import { existTool } from "./exist.js";
import { findTextTool } from "./findText.js";
import { downloadFileTool } from "./downloadFile.js";
import { renameTool } from "./rename.js";
import { copyTool } from "./copy.js";
import { batchEditTool } from "./batchEdit.js";
import { editTool } from "./edit.js";

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
