import { rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

/**
 * 收掉工具落盘留下的目录，并把**因此变空**的祖先目录一并删掉。
 *
 * ## 为什么需要
 *
 * 工具落盘的基准是 `os.tmpdir()/ai-zen/tool-output/<tool>-<时间戳>-<随机>/`（见
 * `scope/plugins/builtin/outputGuard.ts`），那是生产语义，不该为测试加开关。于是
 * 「输出超限要落盘」这类用例只能**事后收**：不收的后果不是断言失败，而是每次跑测试
 * 都往 `/tmp` 里加几个目录 —— `exec-…/`、`ls-…/`、`glob-…/`、`call_mcp_tool-…/`，
 * 一次全量十几二十个，跑一个月就是上千个。
 *
 * ## 为什么祖先用 `rmdirSync` 而不是 `rmSync(recursive)`
 *
 * sdk 的测试是 `isolate: false`，而**文件之间是并行**的：直接删掉整棵 `<tmp>/ai-zen`
 * 会把另一个文件正在读的文件一起删掉，表现成随机失败。`rmdirSync` 遇到非空就抛 ——
 * 那正好等于「别人还在用，别动」。所以：先删自己那一个子目录，再逐级往上收**空的**父目录。
 */
export function cleanupDumpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  const root = tmpdir();
  let parent = dirname(dir);
  // 一路往上收空目录，但绝不越过 `tmpdir()` 本身
  while (parent.startsWith(root) && parent.length > root.length) {
    try {
      rmdirSync(parent);
    } catch {
      return; // 非空（或已被别的文件删掉）→ 到此为止
    }
    parent = dirname(parent);
  }
}
