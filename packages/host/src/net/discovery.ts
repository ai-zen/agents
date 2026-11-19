/**
 * 发现文件与本地凭证交付口（PLAN §8）。
 *
 * 两个文件、两种用途：
 *
 * - `<dataRoot>/run/host.json` 是「这台机器上谁在服务」的唯一真相：进程 id、监听的地址与端口、
 *   版本、是不是本地实例、启动时刻。客户端探活与宿主启动时自查都读它，两边不各写一份。
 * - `<dataRoot>/run/token` 是**本地凭证的交付口**：内容只有本地那串凭证，客户端首次连接时
 *   自动取走。凭证自己的真相在库里（可列出、带备注、可单独吊销），这里只是一份「给本机进程读」的副本。
 *
 * 目录由本文件按需创建：`run/` 与 `assets/` 都可能在首次启动时还不存在。
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { HostPaths } from "../config.js";
import { HostError } from "../wire/errors.js";

/**
 * `run/host.json` 的形状。
 *
 * `host` 是**实际监听**的地址（本地实例是 `127.0.0.1`，对外实例是调用方指定的地址），
 * `port` 是实际端口 —— 端口被占时宿主会退回系统分配的临时端口，所以客户端不能按「启动参数里的端口」
 * 去连，只能读这个文件。
 */
export interface HostFileInfo {
  /** 宿主进程 id（客户端据此判断「上次那个进程还在不在」） */
  pid: number;
  host: string;
  port: number;
  /** 宿主版本（升级判定要比对磁盘上的版本，PRD D4） */
  version: string;
  /** 是不是本地实例（`true` 只监听回环，`false` 是创建者起的对外实例） */
  local: boolean;
  /** 启动时刻，ISO 8601 */
  startedAt: string;
}

/**
 * 写发现文件。
 *
 * 先写同目录的临时文件再 `rename`：读的一方要么看到上一份完整内容，要么看到这一份完整内容，
 * 不会读到「写了一半的 JSON」（客户端探活正是高频读它的那一个）。
 */
export async function writeHostFile(paths: HostPaths, info: HostFileInfo): Promise<void> {
  await fs.mkdir(paths.runDir, { recursive: true });
  const content = `${JSON.stringify(info, null, 2)}\n`;
  await writeAtomic(paths.hostFile, content);
}

/**
 * 读发现文件。
 *
 * 三种结果分开给：文件不存在 → `null`（还没起过宿主）；内容坏了 → 抛 `config_invalid`
 * （「文件不存在」与「文件坏了」必须能分开，PRD F-F6 对配置文件说的是同一件事）；
 * 正常 → 解析后的形状。
 *
 * 本函数**不判断**那个 pid 是否还活着：探活是调用方的事（这里只有文件，没有进程表）。
 */
export async function readHostFile(paths: HostPaths): Promise<HostFileInfo | null> {
  let text: string;
  try {
    text = await fs.readFile(paths.hostFile, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw brokenHostFile(paths.hostFile, "it is not valid JSON", error);
  }
  return parseHostFileInfo(value, paths.hostFile);
}

/**
 * 清掉发现文件（进程收尾时用）。
 *
 * 文件本来就不在时不算失败：收尾动作要能被重复执行，不能因为「已经删过一次」而报错。
 */
export async function clearHostFile(paths: HostPaths): Promise<void> {
  try {
    await fs.unlink(paths.hostFile);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

/**
 * 写本地凭证交付文件（权限尽力而为地设成 `0600`）。
 *
 * 关于 `0600`：在 POSIX 上它让「同机其他用户」读不到这串凭证；在 Windows 上 `mode` 与
 * `chmod` 都不改变 ACL（那里是空操作），实际保护来自用户目录本身的访问控制。
 * 所以这里是**尽力而为**：设不上不报错，也不构成任何安全保证。
 */
export async function writeLocalToken(paths: HostPaths, token: string): Promise<void> {
  await fs.mkdir(paths.runDir, { recursive: true });
  await fs.writeFile(paths.tokenFile, `${token}\n`, { mode: 0o600 });
  // 文件已存在时 `mode` 不生效（它只作用于创建），所以显式再设一次；失败按「尽力而为」忽略
  await fs.chmod(paths.tokenFile, 0o600).catch(() => undefined);
}

/**
 * 读本地凭证交付文件。
 *
 * 文件不存在 → `null`（还没生成过）；内容为空 → `null`（等同于没有）。其余读写错误向上抛：
 * 权限问题与「文件不在」是两件事，混成 `null` 会让首次启动悄悄再造一串凭证。
 */
export async function readLocalToken(paths: HostPaths): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(paths.tokenFile, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const token = text.trim();
  return token === "" ? null : token;
}

/** 清掉本地凭证交付文件（凭证被吊销 / 轮换时顺手做的事） */
export async function clearLocalToken(paths: HostPaths): Promise<void> {
  await fs.rm(paths.tokenFile, { force: true });
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

function brokenHostFile(filePath: string, reason: string, cause?: unknown): HostError {
  return new HostError("config_invalid", {
    params: { reason },
    detail: { path: filePath, reason },
    cause,
  });
}

/**
 * 校验发现文件的形状。
 *
 * 逐字段检查而不是整块断言：坏文件要能指出是哪一项不对（客户端/运维排查时唯一有用的信息）。
 */
function parseHostFileInfo(value: unknown, filePath: string): HostFileInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw brokenHostFile(filePath, "it is not a JSON object");
  }
  const record = value as Record<string, unknown>;
  const pid = record.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw brokenHostFile(filePath, "`pid` is not a process id");
  }
  const host = record.host;
  if (typeof host !== "string" || host.trim() === "") {
    throw brokenHostFile(filePath, "`host` is missing");
  }
  const port = record.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw brokenHostFile(filePath, "`port` is not a port number");
  }
  const version = record.version;
  if (typeof version !== "string" || version.trim() === "") {
    throw brokenHostFile(filePath, "`version` is missing");
  }
  const local = record.local;
  if (typeof local !== "boolean") {
    throw brokenHostFile(filePath, "`local` is not a boolean");
  }
  const startedAt = record.startedAt;
  if (typeof startedAt !== "string" || startedAt.trim() === "") {
    throw brokenHostFile(filePath, "`startedAt` is missing");
  }
  return { pid, host, port, version, local, startedAt };
}

/**
 * 原子写：先写同目录临时文件，再改名。
 *
 * 临时文件放在目标同目录，`rename` 才是同一个文件系统内的改名（跨设备的改名会退化成复制）。
 */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  const temp = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, content, { mode: 0o600 });
    await fs.rename(temp, filePath);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
