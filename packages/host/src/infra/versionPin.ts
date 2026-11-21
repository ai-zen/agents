import { rmSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import { ensureDirectory, readTextFile, writeTextFile } from "./files.js";

/**
 * `<数据根>/run/next-version.json`：下次该跑哪一版。
 *
 * 与同目录的 `host.json` 是两件事：那个说「此刻谁在服务」，这个说「下一拍该跑哪一版」。宿主不
 * 自己拉起自己，所以这件事只能记在磁盘上，由启动方式去读。
 */
export interface VersionPin {
  readonly version: string;
  readonly requestedAt: string;
}

/** 与上面的接口逐字段对齐；两个值都只是字符串，内容对不对不归这里管 */
const schema = z.object({ version: z.string(), requestedAt: z.string() });

/**
 * 读 pin。文件不在、读不出来、形状不对都当「没有 pin」—— 它只是启动方式的一条提示，坏了不该
 * 拦住启动。
 *
 * 坏文件不在这里删（发现文件那一处会删）：这份文件由 {@link writeVersionPin} 原子替换，半截的
 * 只可能是有人手改到一半，替人删掉一个正在编辑的文件比留着它更糟。
 */
export function readVersionPin(path: string): VersionPin | undefined {
  const text = readTextFile(path);
  if (text === undefined) return undefined;

  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : undefined;
  } catch {
    // 解析失败与形状不对是同一件事：这一份用不出来，等于没有 pin
    return undefined;
  }
}

/**
 * 写 pin：先写同目录临时文件再 `rename`（`writeTextFile` 做的那件事）。
 *
 * 理由与素材落盘那处相同：启动方式随时可能在读，读到半截文件只会被当成「没有 pin」，
 * 那一次升级就白等了。
 */
export function writeVersionPin(path: string, pin: VersionPin): void {
  ensureDirectory(dirname(path));
  writeTextFile(path, `${JSON.stringify(pin, null, 2)}\n`);
}

/** 清 pin；不在就什么都不做。清完再清一次也不该报错：正常关闭与升级收尾都会走到这里 */
export function clearVersionPin(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (cause) {
    throw new Error(`Cannot clear version pin "${path}"`, { cause });
  }
}
