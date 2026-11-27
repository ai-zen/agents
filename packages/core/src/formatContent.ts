import type { AgentNS } from "./AgentNS.js";

/**
 * 内容段的字段白名单：类型 → 这一层能出网的键（`index` / `type` 之外的部分）。
 *
 * 依据是 `AgentNS` 里那三个内容段类型；不在表里的类型（厂商自造的、本地扩展的）没有已知字段。
 */
const SECTION_FIELDS: Record<string, readonly string[]> = {
  text: ["text"],
  image_url: ["image_url"],
  file: ["file_id", "file_data", "filename"],
};

/** `image_url` 内容块的字段表，只列出要出网的键 */
const IMAGE_URL_FIELDS: readonly string[] = ["url", "detail"];

/**
 * 一条消息内容里发给模型的那一份：字符串原样返回，数组逐段交给 {@link formatContentSection}。
 *
 * 它是内容格式化的入口：字符串上没有可剥的键，直接原样返回。
 */
export function formatContent(content: AgentNS.MessageContent): AgentNS.MessageContent {
  if (!Array.isArray(content)) return content;
  return content.map((section) => formatContentSection(section));
}

/**
 * 一段内容里能出网的那一份：按段类型取认识的字段重建，返回新对象（不改入参）。
 *
 * 认不出的键（`__` 开头的本地扩展、厂商额外添加的字段）与认不出的段类型都留不下东西：未知段
 * 类型只剩 `type`（有 `index` 就带上），因为不知道该留什么。
 */
export function formatContentSection(
  section: AgentNS.MessageContentSection,
): AgentNS.MessageContentSection {
  const source = section as unknown as Record<string, unknown>;
  const type = typeof source.type === "string" ? source.type : "";
  const kept: Record<string, unknown> = {};
  for (const key of ["index", "type", ...(SECTION_FIELDS[type] ?? [])]) {
    const value = source[key];
    if (value === undefined) continue;
    kept[key] = key === "image_url" ? pickImageUrl(value) : value;
  }
  return kept as unknown as AgentNS.MessageContentSection;
}

function pickImageUrl(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return { url: "" };
  const source = value as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of IMAGE_URL_FIELDS) {
    if (source[key] !== undefined) kept[key] = source[key];
  }
  return kept;
}
