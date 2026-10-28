import * as fsp from "fs/promises";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

function countOccurrences(content: string, text: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    pos = content.indexOf(text, pos);
    if (pos === -1) break;
    count++;
    pos += text.length;
  }
  return count;
}

export class EditTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "edit",
    description: [
      "Edit text in a file, supporting exact replacement or replacing all matches.",
      "",
      "Concurrency limit (important): never edit the same file in parallel. Do not issue multiple edit calls for the same path within one reply — each call reads the old content and writes it back, so the later write overwrites the earlier one, losing changes or corrupting the file.",
      "To apply multiple changes to one file, use batch_edit instead and submit all replacements in a single call. Only edit different files in parallel.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path",
        },
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
          description: "Whether to replace all matches (default false, only the first match is replaced). Make sure the oldText you provide is precise enough to avoid unintended replacements",
          default: false,
        },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(input: { path: string; oldText: string; newText: string; isReplaceAll?: boolean }): Promise<string> {
    try {
      const filePath = this.resolve(input.path);
      const oldText = input.oldText;
      const newText = input.newText;
      const isReplaceAll = input.isReplaceAll ?? false;

      const content = await fsp.readFile(filePath, "utf-8");

      const count = countOccurrences(content, oldText);

      if (count === 0) {
        return JSON.stringify({
          result: "No exact match found for the text to replace",
          matchCount: 0,
        });
      }

      const newContent = isReplaceAll
        ? content.replaceAll(oldText, newText)
        : content.replace(oldText, newText);

      await fsp.writeFile(filePath, newContent);

      if (!isReplaceAll && count > 1) {
        return JSON.stringify({
          result: `Warning: replace-all is off (isReplaceAll=false), but the text "${oldText}" occurs ${count} times in the file; only the first match was replaced. Set isReplaceAll to true to replace all matches`,
          matchCount: count,
          replacedCount: 1,
        });
      }

      return JSON.stringify({
        result: "success",
        matchCount: count,
        replacedCount: isReplaceAll ? count : 1,
      });
    } catch (error: any) {
      return error?.message;
    }
  }
}
