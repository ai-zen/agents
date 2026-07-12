import { CallbackTool } from "@ai-zen/agents-core";
import * as fsp from "fs/promises";

/**
 * 计算字符串中指定文本出现的次数
 */
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

export const editTool = new CallbackTool({
  function: {
    name: "edit",
    description: "编辑文件中的文本，支持精确替换或替换所有匹配项",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径",
        },
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
          description: "是否替换所有匹配的文本（默认 false，仅替换首次匹配）。使用此功能前应确保你提供的 oldText 足够精确，避免误替换",
          default: false,
        },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    try {
      const path = input.path as string;
      const oldText = input.oldText as string;
      const newText = input.newText as string;
      const isReplaceAll = input.isReplaceAll as boolean | undefined;

      const content = await fsp.readFile(path, "utf-8");

      // 检查匹配次数
      const count = countOccurrences(content, oldText);

      if (count === 0) {
        return JSON.stringify({
          result: "文件中未精确匹配到要替换的文本",
          matchCount: 0,
        });
      }

      // 执行替换
      const newContent = isReplaceAll
        ? content.replaceAll(oldText, newText)
        : content.replace(oldText, newText);

      await fsp.writeFile(path, newContent);

      // 如果未开启替换所有，但找到了多处匹配，报警告
      if (!isReplaceAll && count > 1) {
        return JSON.stringify({
          result: `警告：未开启替换所有（isReplaceAll=false），但文本 "${oldText}" 在文件中出现了 ${count} 次，仅替换了首次匹配。如果希望替换所有匹配，请将 isReplaceAll 设为 true`,
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
  },
});
