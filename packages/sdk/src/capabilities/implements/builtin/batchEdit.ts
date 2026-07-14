import { CallbackTool } from "@ai-zen/agents-core";
import * as fsp from "fs/promises";

export const batchEditTool = new CallbackTool({
  function: {
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
  },
  async callback(input): Promise<string> {
    try {
      const content = await fsp.readFile(input.path as string, "utf-8");
      let newContent = content;
      const results: { oldText: string; newText: string; result: string }[] = [];
      for (const replacement of input.replacements as any[]) {
        if (!newContent.includes(replacement.oldText as string)) {
          results.push({
            oldText: replacement.oldText as string,
            newText: replacement.newText as string,
            result: "文件中未精确匹配到要替换的文本",
          });
          continue;
        }
        if (replacement.isReplaceAll) {
          newContent = newContent.replaceAll(
            replacement.oldText as string,
            replacement.newText as string,
          );
        } else {
          newContent = newContent.replace(
            replacement.oldText as string,
            replacement.newText as string,
          );
        }
        results.push({
          oldText: replacement.oldText as string,
          newText: replacement.newText as string,
          result: "success",
        });
      }
      await fsp.writeFile(input.path as string, newContent);
      return JSON.stringify(results);
    } catch (error: any) {
      return error?.message;
    }
  },
});
