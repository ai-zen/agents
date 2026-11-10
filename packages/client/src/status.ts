/**
 * `ai --server-status` 背后的数据读取。
 *
 * 只**读**、不拉起：这个命令的用途是诊断「服务端到底在不在、卡在哪一步」，
 * 顺手拉一个起来会让答案失去意义。
 *
 * 输出给脚本消费（JSON），所以这里不产出任何自然语言文案 —— 与「服务端不产文案」
 * 同一条原则的反向应用：诊断输出保持机器可解析，人读 JSON 也一眼能看懂。
 *
 * ## 为什么用 `callOnce` 而不是建一条长连接
 *
 * 读状态是**一次问话**：问完就没有下文了。以前这里走 `SocketServerClient`（一条完整的
 * 长连接 + 在飞调用表 + 事件通道），于是这个只问一句的函数得自己 `close()`、还得记住
 * 「连接失败」与「调用失败」是两个 catch 分支。`callOnce` 把这三件事（连、问、挂断）收成
 * 一句，失败只剩一条路径 —— 诊断代码越短，越不容易在诊断时自己出错。
 */

import {
  DAEMON_METHODS,
  callOnce,
  readDescriptor,
  type DaemonStatusResult,
} from "@ai-zen/agents-protocol";
import type { ClientInfo } from "./types.js";

export interface ServerStatusDeps {
  aiZenDir: string;
  /** 握手时自称的身份（只进服务端日志） */
  clientInfo: ClientInfo;
}

export type ServerStatus =
  { running: false; pid?: number; reason: string } | ({ running: true } & DaemonStatusResult);

/** 读状态的时限：本机问一句不该慢；慢就是有问题（诊断本身不该卡住终端） */
const STATUS_TIMEOUT_MS = 2000;

export async function readServerStatus(deps: ServerStatusDeps): Promise<ServerStatus> {
  const descriptor = await readDescriptor(deps.aiZenDir);
  if (!descriptor) return { running: false, reason: "no descriptor" };

  const address = { host: descriptor.host, port: descriptor.port };
  try {
    const status = (await callOnce(address, DAEMON_METHODS.status, undefined, {
      client: deps.clientInfo,
      timeoutMs: STATUS_TIMEOUT_MS,
    })) as DaemonStatusResult;
    return { running: true, ...status };
  } catch (error) {
    // 发现文件在、进程却连不上 / 问了不回：这正是要诊断的那种状态，把 pid 带上
    return { running: false, pid: descriptor.pid, reason: (error as Error).message };
  }
}
