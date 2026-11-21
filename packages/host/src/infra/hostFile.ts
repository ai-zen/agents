import { rmSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import { ensureDirectory, readTextFile, writeTextFile } from "./files.js";

/**
 * `<数据根>/run/host.json` 的形状：这台机器上谁在服务，进程号、实际监听的地址与端口、版本、
 * 是不是本机实例、启动时刻。
 *
 * `port` 是监听起来的那一个，不是启动参数里的：启动参数允许给 `0`（由系统分配），除了这里
 * 没有第二处知道该连哪个端口。
 */
export interface HostFileInfo {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly local: boolean;
  readonly startedAt: string;
}

/** 与上面的接口逐字段对齐；`pid`、`port` 取值是否合理由写入方保证，这里只判类型 */
const schema = z.object({
  pid: z.number(),
  host: z.string(),
  port: z.number(),
  version: z.string(),
  local: z.boolean(),
  startedAt: z.string(),
});

/**
 * 文件不在返回 `undefined`。不是一个 JSON 对象、字段缺失、类型不对的，删掉文件之后返回
 * `undefined`：坏掉的发现文件拦不住启动，留着它每次启动都会在同一份内容上再撞一次，清掉
 * 再起是唯一有意义的处理，所以这件事在这里做完，调用方不必再判一次。
 */
export function readHostFile(path: string): HostFileInfo | undefined {
  const text = readTextFile(path);
  if (text === undefined) return undefined;

  try {
    const result = schema.safeParse(JSON.parse(text));
    if (result.success) return result.data;
  } catch {
    // 解析失败与形状不对是同一件事：这份文件用不出来，处理在下面同一处
  }
  clearHostFile(path);
  return undefined;
}

/** 目录在首次启动时还不存在，先建；内容一次原子写，读的一方不会看到写了一半的 JSON */
export function writeHostFile(path: string, info: HostFileInfo): void {
  ensureDirectory(dirname(path));
  writeTextFile(path, `${JSON.stringify(info, null, 2)}\n`);
}

/** 文件本来就不在不算失败：收尾动作会被重复执行，删第二次不该报错 */
export function clearHostFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (cause) {
    throw new Error(`Cannot clear host file "${path}"`, { cause });
  }
}

/**
 * 那个进程号还在不在。
 *
 * `process.kill(pid, 0)` 不发信号，只做存在性探测：`ESRCH` 是「没有这个进程」。`EPERM` 是
 * 「进程在，只是不归当前用户」，`process.kill` 在权限不足时连信号都不发就返回它，所以它算
 * 活着 —— 别的用户起的宿主正是这一种，判成不在会让本机再起一个。
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
