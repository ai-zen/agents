import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

/**
 * 工具输出上限的缺省值（字符数）。
 *
 * 可由 AppConfig.maxToolOutput 覆盖；上限由各工具自行读取并判定，
 * 骨架不感知配置，以便不同工具按自身口径（如 stdout/stderr 合计）判断。
 */
export const DEFAULT_MAX_TOOL_OUTPUT = 32_768;

/** 待落盘的文件：文件名（不含目录）+ 内容 */
export interface GuardDumpFile {
  /** 文件名，如 "stdout.log" */
  name: string;
  /** 文件内容 */
  content: string;
}

/** buildWarning 回调收到的落盘结果 */
export interface GuardWarningContext {
  /** 本次落盘目录；未落盘（工具未提供 dump）时为 null */
  dir: string | null;
  /** 已落盘文件：文件名 → 绝对路径；未落盘时为空对象 */
  files: Record<string, string>;
}

/** guardOutput 入参：骨架所需的一切（判定、落盘、警告）均由工具以回调提供 */
export interface OutputGuardOptions<T> {
  /** 工具名，用于落盘目录命名（如 "exec"） */
  tool: string;
  /** 工具本应返回的完整内容 */
  content: T;
  /** 超限判定：上限由工具自行从 config 读取，骨架不传参 */
  isOverLimit: (content: T) => boolean;
  /**
   * 落盘内容组织（可选）。缺省表示"只警告、不落盘"（如 readFile）。
   * 返回的文件按顺序写入本次调用专属的目录。
   */
  dump?: (dir: string, content: T) => GuardDumpFile[] | Promise<GuardDumpFile[]>;
  /** 生成超限时的返回体（各工具自定义，可含头尾预览、统计、原有字段等） */
  buildWarning: (ctx: GuardWarningContext) => string;
}

/**
 * 标准输出保护骨架。
 *
 * 各工具在 call() 出口调用，只需提供三个回调：
 *   1) isOverLimit  —— 是否超过上限（工具自读 config 判定，未被超限即原样返回 content）；
 *   2) dump         —— 超限时落盘哪些文件（可省略 = 只警告不落盘）；
 *   3) buildWarning —— 超限时返回给模型的内容。
 *
 * 骨架职责：判定 → 未超限原样返回 / 超限时创建独立目录并写文件 → 交给 buildWarning。
 *
 * 落盘目录：<os.tmpdir()>/ai-zen/tool-output/<tool>-<时间戳>-<随机串>/，
 * 每次调用独立目录，互不覆盖；不做自清理，依赖系统对临时目录的清理策略。
 *
 * 落盘失败（磁盘满、权限不足等）不吞异常，直接向上抛出。
 */
export async function guardOutput<T>(options: OutputGuardOptions<T>): Promise<T | string> {
  const { tool, content, isOverLimit, dump, buildWarning } = options;

  if (!isOverLimit(content)) return content;

  if (!dump) return buildWarning({ dir: null, files: {} });

  const dir = await createDumpDir(tool);
  const files = await dump(dir, content);

  const paths: Record<string, string> = {};
  for (const file of files) {
    const target = path.join(dir, file.name);
    await fsp.writeFile(target, file.content, "utf-8");
    paths[file.name] = target;
  }

  return buildWarning({ dir, files: paths });
}

/** 头部预览 */
export interface HeadPreview {
  /** 头部内容（最多 size 字符） */
  head: string;
  /** 被省略的字符数；为 0 表示无省略（此时 head 为全文） */
  omitted: number;
}

/**
 * 生成头部预览：最多 size 字符。
 *
 * 适用于结果按出现顺序排列、尾部参考价值低的工具（如 findText）。
 */
export function headPreview(text: string, size = 1000): HeadPreview {
  if (text.length <= size) return { head: text, omitted: 0 };
  return { head: text.slice(0, size), omitted: text.length - size };
}

/** 头尾预览 */
export interface HeadTailPreview {
  /** 头部内容（最多 size 字符） */
  head: string;
  /** 尾部内容（最多 size 字符）；无省略时为空串 */
  tail: string;
  /** 被省略的字符数；为 0 表示无省略（此时 head 为全文） */
  omitted: number;
}

/**
 * 生成头尾预览：头部最多 size 字符 + 尾部最多 size 字符。
 *
 * 供各工具的 buildWarning 按需取用（也可自行组织预览，骨架不做限制）。
 */
export function headTailPreview(text: string, size = 1000): HeadTailPreview {
  if (text.length <= size * 2) return { head: text, tail: "", omitted: 0 };
  return {
    head: text.slice(0, size),
    tail: text.slice(-size),
    omitted: text.length - size * 2,
  };
}

/** 创建本次调用专属的落盘目录 */
async function createDumpDir(tool: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const dir = path.join(os.tmpdir(), "ai-zen", "tool-output", `${tool}-${stamp}-${rand}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}
