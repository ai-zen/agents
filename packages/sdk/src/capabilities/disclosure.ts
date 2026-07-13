export interface DisclosureItem {
  id: string;
  description: string;
}

export interface DisclosureParam {
  type: "string";
  description: string;
  enum?: string[];
}

/**
 * 构建 load_skill / load_mcp 的参数 schema。
 * 有候选项时生成枚举，无候选项时退化为自由文本并在描述中追加提示。
 */
export function buildDisclosureParam(
  items: DisclosureItem[],
  baseDescription: string,
  emptyHint: string,
): DisclosureParam {
  if (items.length === 0) {
    return {
      type: "string",
      description: `${baseDescription} ${emptyHint}`,
    };
  }

  return {
    type: "string",
    description: baseDescription,
    enum: items.map((item) => item.id),
  };
}
