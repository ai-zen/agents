import * as fsp from "fs/promises";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

interface Replacement {
  oldText: string;
  newText: string;
  isReplaceAll?: boolean;
}

export class BatchEditTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "batch_edit",
    description: [
      "Edit text in a file in batches. Prefer this tool when making edits to a file.",
      "Submit all changes to the same file in a single call (the replacements array) instead of calling edit in parallel multiple times — parallel edits to the same file overwrite each other.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path",
        },
        replacements: {
          type: "array",
          description: "Array of replacements",
          items: {
            type: "object",
            properties: {
              oldText: {
                type: "string",
                description: "Text to replace",
              },
              newText: {
                type: "string",
                description: "Replacement text",
              },
              isReplaceAll: {
                type: "boolean",
                description:
                  "Whether to replace all matches (by default only the first match is replaced). Make sure the oldText you provide is precise enough to avoid unintended replacements",
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
            reason: "No exact match found for the text to replace",
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
