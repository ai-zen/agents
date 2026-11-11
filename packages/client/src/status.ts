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
 * 读状态是**一次问话**：问完就没有下文了。用一条完整的长连接（在飞调用表 + 事件通道）
 * 做这件事，函数就得自己 `close()`、还得把「连接失败」与「调用失败」分成两个 catch 分支。
 * `callOnce` 把这三件事（连、问、挂断）收成一句，失败只剩一条路径 —— 诊断代码越短，
 * 越不容易在诊断时自己出错。
 *
 * ## 显式地址时**不读**发现文件（D13）
 *
 * 从前这里只认 `<aiZenDir>/run/server.json`，于是远程场景（`--server https://…`、nginx 子路径、
 * SSH 转发）永远回 `running: false, reason: "no descriptor"` —— 一句既不是「没在跑」也不是
 * 「连不上」的话，而它恰好是最需要答案的那个场景。现在与 `ensureServer` 走**同一个解析点**
 * （`resolve-target.ts`）：给了显式地址就直接问那个地址，凭证也走同一条优先级。
 */

import type { DaemonStatusResult } from "@ai-zen/agents-server/protocol";
import { readDescriptor } from "./wire/discovery.js";
import { callOnce } from "./wire/call-once.js";
import type { ClientInfo } from "./types.js";
import { explainUnauthorized, readExplicitTarget, resolveToken } from "./resolve-target.js";

export interface ServerStatusDeps {
  aiZenDir: string;
  /** 握手时自称的身份（只进服务端日志） */
  clientInfo: ClientInfo;
  /** 显式地址（`--server` / `AI_ZEN_SERVER_URL`）：给了就**不读**发现文件 */
  serverUrl?: string;
  /** 显式凭证（`AI_ZEN_SERVER_TOKEN`）；没给就退回 `<aiZenDir>/run/token` */
  serverToken?: string;
}

export type ServerStatus =
  { running: false; pid?: number; reason: string } | ({ running: true } & DaemonStatusResult);

/** 读状态的时限：本机问一句不该慢；慢就是有问题（诊断本身不该卡住终端） */
const STATUS_TIMEOUT_MS = 2000;

export async function readServerStatus(deps: ServerStatusDeps): Promise<ServerStatus> {
  const source = {
    aiZenDir: deps.aiZenDir,
    serverUrl: deps.serverUrl,
    serverToken: deps.serverToken,
  };
  const { token, source: tokenSource } = await resolveToken(source);

  const explicit = readExplicitTarget(source);
  if (explicit) {
    try {
      const status = (await callOnce(explicit.address, "status", undefined, {
        client: deps.clientInfo,
        timeoutMs: STATUS_TIMEOUT_MS,
        token: token ?? undefined,
      })) as DaemonStatusResult;
      return { running: true, ...status };
    } catch (error) {
      // 没有 pid 可报（那个进程不在这台机器上）：只把失败原因说清楚 ——
      // `unauthorized` 在这里最容易被误诊成「服务端没在跑」，所以翻成对症的那句话；
      // `aiZenDir` 一并递进去，提示里的凭证路径才能印**真路径**而不是占位符
      const explained = explainUnauthorized(error, {
        explicit: true,
        // 凭证来源三态（显式 / 本地文件 / 没有）：三者对应的那句话完全不同 ——
        // 「本机没有凭证」的修法只有一条（设 `AI_ZEN_SERVER_TOKEN`），不是重启服务端
        source: tokenSource,
        serverUrl: deps.serverUrl,
        aiZenDir: deps.aiZenDir,
      });
      return { running: false, reason: explained.message };
    }
  }

  const descriptor = await readDescriptor(deps.aiZenDir);
  if (!descriptor) return { running: false, reason: "no descriptor" };

  const address = { host: descriptor.host, port: descriptor.port };
  try {
    const status = (await callOnce(address, "status", undefined, {
      client: deps.clientInfo,
      timeoutMs: STATUS_TIMEOUT_MS,
      token: token ?? undefined,
    })) as DaemonStatusResult;
    return { running: true, ...status };
  } catch (error) {
    // 发现文件在、进程却连不上 / 问了不回：这正是要诊断的那种状态，把 pid 带上
    return { running: false, pid: descriptor.pid, reason: (error as Error).message };
  }
}
