/**
 * 守护进程**自带**方法的线上契约 —— `ping` / `status` / `shutdown`。
 *
 * ## 为什么单独一个文件
 *
 * `sessions.ts` / `config.ts` 都是按**命名空间**分的（`session.*` / `workspace.*` /
 * `config.*` / `agent.*`）。这三条不属于任何命名空间：它们回答的是「活着吗 / 你是谁、
 * 现在几个连接 / 可以关了吗」，与业务无关，由 `Daemon` 自己实现、不经过任何 service。
 * 所以它们是平级的第三面。
 *
 * ## 为什么方法名与结果形状写在这里
 *
 * 服务端注册与客户端调用共用同一份字面量与类型，两端就不可能出现「同一个方法、两种
 * 结果形状」（`{ ...descriptor, alive }` 与 `{ running, ... }` 那种）。帧层仍然不解释它们：
 * `Daemon` 只是把方法名登记进 handlers 表，参数与结果就是这里的类型。
 */

/** 自带方法名（服务端注册与客户端调用共用同一份字面量） */
export type DaemonMethod = "ping" | "status" | "shutdown";

/** `ping` 的结果：能回这个就说明握手成功、方法分发正常 */
export interface PingResult {
  pong: true;
}

/**
 * `status` 的结果 —— 「这个进程是谁、活了多久、现在有几个客户端」。
 *
 * 字段与会话无关，所以不进 `session.*`；`descriptorPath` 是给诊断命令用的：报错时
 * 「我读的是哪个发现文件」往往就是答案。
 */
export interface DaemonStatusResult {
  version: string;
  protocol: number;
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  uptimeMs: number;
  /** 当前连着的客户端数（空闲判定与「有没有人在看」都从它来） */
  connections: number;
  descriptorPath: string;
}

/** `shutdown` 的结果：回执先发出去，收摊排在下一个 tick */
export interface ShutdownResult {
  stopping: true;
}

/** `DaemonMethod` 的**成员名**（不是线上值）—— 给「门面必须覆盖每一条」这类类型级用例用 */
export type DaemonMethodKey = "ping" | "status" | "shutdown";
