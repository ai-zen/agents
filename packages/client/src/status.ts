/**
 * `ai --server-status` 背后的数据读取。
 *
 * 只**读**、不拉起：这个命令的用途是诊断「服务端到底在不在、卡在哪一步」，
 * 顺手拉一个起来会让答案失去意义。
 *
 * 输出给脚本消费（JSON），所以这里不产出任何自然语言文案 —— 与「服务端不产文案」
 * 同一条原则的反向应用：诊断输出保持机器可解析，人读 JSON 也一眼能看懂。
 */

import {
  DAEMON_METHODS,
  readDescriptor,
  type DaemonStatusResult,
} from "@ai-zen/agents-server/protocol";
import { SocketServerClient } from "./socket-server-client.js";
import type { ClientInfo, ServerAddress, ServerClient } from "./types.js";

export interface ServerStatusDeps {
  aiZenDir: string;
  clientInfo: ClientInfo;
  connect?: (address: ServerAddress) => Promise<ServerClient>;
}

export type ServerStatus =
  { running: false; pid?: number; reason: string } | ({ running: true } & DaemonStatusResult);

export async function readServerStatus(deps: ServerStatusDeps): Promise<ServerStatus> {
  const descriptor = await readDescriptor(deps.aiZenDir);
  if (!descriptor) return { running: false, reason: "no descriptor" };

  const connect =
    deps.connect ??
    ((address: ServerAddress) => SocketServerClient.connect({ address, client: deps.clientInfo }));

  let client: ServerClient;
  try {
    client = await connect({ host: descriptor.host, port: descriptor.port });
  } catch (error) {
    // 发现文件在、进程却连不上：这正是要诊断的那种状态，把 pid 带上
    return { running: false, pid: descriptor.pid, reason: (error as Error).message };
  }

  try {
    const status = await client.call<DaemonStatusResult>(DAEMON_METHODS.status);
    return { running: true, ...status };
  } finally {
    client.close();
  }
}
