/**
 * 文本替换的公共实现（`edit` / `batch_edit` 共用）。
 */

/** 统计 `text` 在 `content` 中非重叠的出现次数（`text` 为空时返回 0） */
export function countOccurrences(content: string, text: string): number {
  if (text === "") return 0;
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

/**
 * 执行一次替换，返回新内容与**实际替换次数**。
 *
 * 必须用回调式 replacer：字符串形式的替换值里，`$&`、`` $` ``、`$'`、`$$` 会被
 * `String.replace` 当作替换模式展开（写入的不再是字面量），而回调的返回值一律按字面量处理。
 *
 * `oldText` 为空时不做替换（空串会匹配每一个位置）：替换次数恒为 0，由调用方给出提示。
 */
export function replaceText(
  content: string,
  oldText: string,
  newText: string,
  isReplaceAll: boolean,
): { content: string; replacedCount: number } {
  const matches = countOccurrences(content, oldText);
  if (matches === 0) return { content, replacedCount: 0 };

  return {
    content: isReplaceAll
      ? content.replaceAll(oldText, () => newText)
      : content.replace(oldText, () => newText),
    replacedCount: isReplaceAll ? matches : 1,
  };
}
