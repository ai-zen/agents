import { guardOutput, headTailPreview, type GuardDumpFile } from "./outputGuard.js";
import { MAX_BUFFER, type CommandResult } from "./commandRun.js";

/**
 * 一条命令的结果交给模型的那段正文 —— `exec` 与后台版共用这一份。
 *
 * 两件事只有这里做：
 *
 * - 输出保护：stdout + stderr 合计超过上限时，全文分文件落盘，正文换成「警告 + 头尾预览 +
 *   统计 + 缩小范围的办法」；
 * - 截断说明：输出撞到内存上限时，正文里必须说清尾部已经丢了，不能看起来像完整结果。
 *
 * `fields` 是调用方要一起带出去的字段（后台版用它写明这是哪一次任务），它们与结果同层，
 * 落盘那一支也一并带上。
 */
export async function commandOutputContent(options: {
  /** 工具名，落盘目录按它命名 */
  tool: string;
  /** 正文里额外带的字段 */
  fields?: Record<string, unknown>;
  result: CommandResult;
  /** 正文的字符上限（stdout + stderr 合计） */
  limit: number;
}): Promise<string> {
  const { tool, fields = {}, result, limit } = options;

  const truncationNote = result.truncated
    ? `Output exceeded the ${MAX_BUFFER}-byte in-memory cap: the process was terminated and the output was truncated there, so the tail is lost.`
    : undefined;

  const content = { ...fields, ...result };

  const guarded = await guardOutput({
    tool,
    content,
    isOverLimit: (output) => output.stdout.length + output.stderr.length > limit,
    dump: (_dir, output): GuardDumpFile[] => [
      { name: "stdout.log", content: output.stdout },
      { name: "stderr.log", content: output.stderr },
    ],
    buildWarning: (ctx) => {
      const stdout = headTailPreview(result.stdout);
      const stderr = headTailPreview(result.stderr);
      return JSON.stringify({
        ...fields,
        outputTooLarge: true,
        warning:
          `Output too large: stdout + stderr total ${result.stdout.length + result.stderr.length} characters, ` +
          `exceeds the limit of ${limit} characters. The output as captured is available in separate files (stdout.log / stderr.log); use read to fetch it in chunks`,
        ...(truncationNote ? { truncated: true, truncationNote } : {}),
        files: ctx.files,
        stdout: { chars: result.stdout.length, lines: countLines(result.stdout), ...stdout },
        stderr: { chars: result.stderr.length, lines: countLines(result.stderr), ...stderr },
        exitCode: result.exitCode,
        killed: result.killed,
        terminated: result.terminated,
      });
    },
  });

  // 未超限：content 为原始结果对象，按原有结构序列化；超限：buildWarning 已生成返回字符串
  if (typeof guarded === "string") return guarded;
  return JSON.stringify(
    result.truncated ? { ...guarded, truncated: true, truncationNote } : guarded,
  );
}

/** 统计文本行数（空文本记 0 行） */
function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}
