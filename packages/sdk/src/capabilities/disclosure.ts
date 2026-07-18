export interface DisclosureParam {
  type: "string";
  description: string;
  enum?: string[];
}

/**
 * 创建 load_skill / load_mcp 的参数 schema。
 * 有候选项时生成枚举，无候选项时退化为自由文本并在描述中追加提示。
 */
export function createDisclosureParam(
  ids: string[],
  baseDescription: string,
  emptyHint: string,
): DisclosureParam {
  if (ids.length === 0) {
    return {
      type: "string",
      description: `${baseDescription} ${emptyHint}`,
    };
  }

  return {
    type: "string",
    description: baseDescription,
    enum: ids,
  };
}
