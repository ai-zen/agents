import * as fsp from "fs/promises";

/**
 * 校验遍历/搜索的基目录。
 *
 * 没有这层校验时，`fsp.glob()` 对不存在的目录只会安静地返回空结果，模型会据此得出
 * 「这些文件不存在」的错误结论（`ls` 在同场景下是抛 `ENOENT` 的）。
 *
 * 返回错误文本；目录正常时返回 `null`。
 */
export async function checkBaseDirectory(dir: string): Promise<string | null> {
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat) return `Path does not exist: ${dir}`;
  if (!stat.isDirectory()) return `Not a directory: ${dir}`;
  return null;
}
