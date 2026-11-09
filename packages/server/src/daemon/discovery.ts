/**
 * 服务发现 —— 「常驻进程在哪个端口」这件事的唯一真相源。
 *
 * 位置：`<aiZenDir>/run/server.json`（`aiZenDir` 由**调用方注入**，本模块不读任何全局路径）。
 *
 * 为什么要这个文件而不是写死端口：端口可能被占（这时服务端会用系统分配的临时端口），
 * 而客户端不能靠猜。文件里同时记 `pid` 与 `version`：
 *   - `pid` 用来判断「上次是不是崩了」——进程不在了就把残留文件收掉；
 *   - `version` 用来判断「在跑的是不是我这个版本」——不一致就别硬连，协议可能已经变了。
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

/** 发现文件内容 */
export interface ServerDescriptor {
  pid: number;
  host: string;
  port: number;
  /** 协议版本（握手时还会再校验一次，这里只是给"要不要尝试连接"提前判断） */
  protocol: number;
  /** 服务端包版本，用于诊断与版本漂移提示 */
  version: string;
  startedAt: string;
  /** 发现的 schema 版本，将来字段变动时用 */
  schema: 1;
}

/** 发现文件路径（每次现拼：aiZenDir 会变，模块顶层算出来就是快照） */
export function descriptorPath(aiZenDir: string): string {
  return join(aiZenDir, "run", "server.json");
}

/** 原子写：先写 `.tmp` 再 rename，避免客户端读到半个 JSON */
export async function writeDescriptor(aiZenDir: string, descriptor: ServerDescriptor): Promise<void> {
  const file = descriptorPath(aiZenDir);
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(descriptor, null, 2), "utf-8");
  await fs.rename(tmp, file);
}

/** 读发现文件；不存在 / 内容坏掉一律返回 null（视为"没有在跑"） */
export async function readDescriptor(aiZenDir: string): Promise<ServerDescriptor | null> {
  try {
    const raw = await fs.readFile(descriptorPath(aiZenDir), "utf-8");
    const parsed = JSON.parse(raw) as ServerDescriptor;
    if (parsed.schema !== 1 || typeof parsed.port !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 删发现文件；不存在不报错 */
export async function removeDescriptor(aiZenDir: string): Promise<void> {
  await fs.rm(descriptorPath(aiZenDir), { force: true });
}

/**
 * 该 pid 是否还活着。
 *
 * `process.kill(pid, 0)` 不发信号、只做存在性检查：
 *   - 成功 → 活着；
 *   - `EPERM` → 进程在，但不是我们这位用户（理论上不会出现在本机同用户场景）；
 *   - `ESRCH` → 确实没了。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}
