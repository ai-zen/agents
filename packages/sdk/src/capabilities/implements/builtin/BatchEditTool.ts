import * as fsp from "fs/promises";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

interface Replacement {
  oldText: string;
  newText: string;
  isReplaceAll?: boolean;
}

export class BatchEditTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "batchEdit",
    description: "批量编辑文件文本，可以优先使用这个工具对文件进行编辑",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径",
        },
        replacements: {
          type: "array",
          description: "要替换的文本数组",
          items: {
            type: "object",
            properties: {
              oldText: {
                type: "string",
                description: "要替换的文本",
              },
              newText: {
                type: "string",
                description: "替换后的文本",
              },
              isReplaceAll: {
                type: "boolean",
                description:
                  "是否替换所有匹配的文本（默认仅替换首次匹配）。使用此功能前应确保你提供的 oldText 足够精确，避免误替换",
                default: false,
              },
            },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "replacements"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(input: { path: string; replacements: Replacement[] }): Promise<string> {
    try {
      const filePath = this.resolve(input.path);
      const content = await fsp.readFile(filePath, "utf-8");
      let newContent = content;
      let replacedCount = 0;
      // 仅回显"有问题"的替换项（未匹配到），便于模型据此修正；
      // 成功项不回显原文与新文，仅计入成功数，避免大段文本回显撑大输出
      const failed: { oldText: string; newText: string; reason: string }[] = [];

      for (const replacement of input.replacements) {
        if (!newContent.includes(replacement.oldText)) {
          failed.push({
            oldText: replacement.oldText,
            newText: replacement.newText,
            reason: "文件中未精确匹配到要替换的文本",
          });
          continue;
        }
        if (replacement.isReplaceAll) {
          newContent = newContent.replaceAll(replacement.oldText, replacement.newText);
        } else {
          newContent = newContent.replace(replacement.oldText, replacement.newText);
        }
        replacedCount++;
      }
      await fsp.writeFile(filePath, newContent);

      if (failed.length === 0) {
        return JSON.stringify({ result: "success", replacedCount });
      }
      return JSON.stringify({ result: "partial", replacedCount, failed });
    } catch (error: any) {
      return error?.message;
    }
  }
}
