/**
 * 动态 Tool 加载器
 *
 * 从文件系统发现并加载用户自定义工具，支持 JS 格式。
 * 工具文件和内置工具一样，会被注册为 CallbackTool 供 Agent 调用。
 *
 * 发现路径（项目级覆盖全局同名）：
 *   ~/.ai-zen/tools/           ← 全局工具
 *   ./.ai-zen/tools/           ← 项目级工具
 *
 * 文件格式（JS）：
 *   export default {
 *     name: "my_tool",
 *     description: "工具描述",
 *     parameters: { type: "object", properties: { ... } },
 *     callback: async (args) => { ... }
 *   };
 */

import chalk from "chalk";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { CallbackTool } from "@ai-zen/agents-core";
import { TOOLS_DIR } from "./config.js";

// ==================== 常量 ====================

/** 项目级工具目录 */
const PROJECT_TOOLS_DIR = join(process.cwd(), ".ai-zen", "tools");

// ==================== 扫描与加载 ====================

/**
 * 扫描所有工具目录，发现用户自定义工具文件
 * 返回文件路径列表（项目级覆盖全局同名）
 */
function scanToolFiles(): string[] {
  const fileMap = new Map<string, string>();

  // 1. 全局工具（优先级低）
  if (existsSync(TOOLS_DIR)) {
    const files = readdirSync(TOOLS_DIR);
    for (const file of files) {
      if (file.endsWith(".js") || file.endsWith(".mjs")) {
        fileMap.set(file, join(TOOLS_DIR, file));
      }
    }
  }

  // 2. 项目级工具（优先级高，覆盖全局同名）
  if (existsSync(PROJECT_TOOLS_DIR)) {
    const files = readdirSync(PROJECT_TOOLS_DIR);
    for (const file of files) {
      if (file.endsWith(".js") || file.endsWith(".mjs")) {
        fileMap.set(file, join(PROJECT_TOOLS_DIR, file));
      }
    }
  }

  return Array.from(fileMap.values());
}

/**
 * 加载单个工具文件，创建 CallbackTool 实例
 */
async function loadToolFile(filePath: string): Promise<CallbackTool | null> {
  try {
    const module = await import(filePath);
    const def = module.default || module;

    if (!def.name || !def.callback) {
      console.warn(
        chalk.yellow(`  ⚠️  工具文件 "${filePath}" 缺少 name 或 callback，已跳过`),
      );
      return null;
    }

    return new CallbackTool({
      function: {
        name: def.name,
        description: def.description || "",
        parameters: def.parameters || {
          type: "object",
          properties: {},
          required: [],
        },
      },
      callback: def.callback,
    });
  } catch (error: any) {
    console.warn(
      chalk.yellow(`  ⚠️  加载工具文件失败: ${filePath} - ${error.message}`),
    );
    return null;
  }
}

/**
 * 发现并加载所有用户自定义工具
 * 每次调用都重新扫描目录，保证最新
 */
export async function discoverUserTools(): Promise<CallbackTool[]> {
  const files = scanToolFiles();
  const tools: CallbackTool[] = [];

  for (const filePath of files) {
    const tool = await loadToolFile(filePath);
    if (tool) {
      tools.push(tool);
    }
  }

  return tools;
}
