/**
 * `host.*`：进程事实（PRD F-E5 / D4 / L4）。
 *
 * 三件事在这里：
 *   - `version` / `capabilities`：报事实（能力清单只在配置层维护一份，这里不编造；
 *     清单里没有文案 —— 一份能力怎么跟用户说，归客户端）；
 *   - `upgrade`：比磁盘上的版本与正在跑的版本，确认新版本真的落盘了才安排重启（D4 / F-E3）；
 *   - `shutdown`：受理一次收尾请求。真正退不退由单根的退出判据决定（PRD L4 / 裁定 R53）。
 *
 * `host.hello` / `host.setLanguage` / `asset.*` 由接线层自己接管（语言是连接状态、
 * 上传要按连接分帧），这里不重复注册。
 *
 * `host.reload`（F-E1）在这里只做转发：重载是「让磁盘上的改动生效」，那条路（回收 Scope、
 * 合成一条通知）的持有者是配置服务。
 *
 * 用量不在这一域（裁定 2026-11-13）：F-I5 的「本轮 / 累计（含子 Agent）/ 速率」由
 * `conversation.state` 的 `usage`（`UsageSnapshot`）给，`host.usage` 的「按项目 / 整机」聚合
 * 没有任何客户端消费，已从契约面删除。
 */

import type { HandlerTable } from "../net/index.js";
import type {
  HostReloadResult,
  HostUpgradeParams,
  HostUpgradeResult,
} from "../wire/index.js";
import { PROTOCOL_VERSION } from "../wire/index.js";

/** `host.*` 的实现要的持有者 */
export interface HostHandlerDeps {
  /** 宿主版本（`hello` 报的那一个） */
  version: string;
  /** 进程启动时刻（ISO 8601） */
  startedAt: string;
  /** 能力清单（PRD F-E5）；内容归配置层，本轮由单根注入 */
  /** 请求收尾（`host.shutdown`）：单根排程，先让回包写出去 */
  requestStop: (reason?: string) => void;
  /** 从磁盘重载（`host.reload`）：配置服务那边跑「生效」那条路（回收 Scope + 合成通知） */
  reload: () => Promise<HostReloadResult>;
  /** 升级判定与重启排程（磁盘版本归单根去读，这里只把结论转给客户端） */
  upgrade: HostUpgradeHandler;
}

/** `host.upgrade` 的实现（结论由单根算，本文件只转发入参） */
export type HostUpgradeHandler = (
  params: HostUpgradeParams,
) => Promise<HostUpgradeResult>;

export function createHostHandlers(deps: HostHandlerDeps): HandlerTable {
  return {
    "host.version": () => ({
      version: deps.version,
      protocolVersion: PROTOCOL_VERSION,
      startedAt: deps.startedAt,
      pid: process.pid,
    }),

    "host.shutdown": (context) => {
      deps.requestStop(context.params.reason);
      return { accepted: true };
    },

    // 升级即重启（D4 / F-E3）：结论由单根给，它知道磁盘上的版本与重启排程
    "host.upgrade": async (context) => await deps.upgrade(context.params),

    // 重载不重启（F-E1 / F-E2 / R63）：与改配置走同一条生效路径，回同一份报告
    "host.reload": async () => await deps.reload(),
  };
}
