import { readFileSync } from "node:fs";

/**
 * 本包的版本号，取自它的 `package.json`。
 *
 * 源码在 `src/infra/`、产物在 `dist/infra/`，两者往上两级都是包根，所以同一个相对路径对两边
 * 都成立。
 * 读不到就抛：这个文件是包的一部分，缺了说明安装本身是坏的，而这条路径上唯一有意义的结果是
 * 启动失败并留下原因，不是拿一个假版本继续跑。
 */
export function resolveHostVersion(): string {
  const url = new URL("../../package.json", import.meta.url);
  try {
    const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
    const version = (parsed as { version?: unknown }).version;
    if (typeof version !== "string" || version.trim() === "") {
      throw new Error("version is missing");
    }
    return version.trim();
  } catch (cause) {
    throw new Error(`Cannot read the host version from "${url.pathname}"`, { cause });
  }
}
