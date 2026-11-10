/**
 * 传输抽象 —— `Daemon` 认识的唯一一条「双工线」。
 *
 * ## 为什么需要这一层
 *
 * `Daemon` 原来是直接收 `net.Socket` 的，于是「服务端讲什么」与「字节从哪里来」焊死在
 * 一起：想接 WebSocket（浏览器直连 / 远程）就得改 `Daemon` 本体。而 `Daemon` 里绝大部分
 * 代码（首帧 `hello` 校验、帧分发、在飞请求、事件推送、空闲退出）与传输毫无关系。
 * 帧协议（`@ai-zen/agents-protocol` 的 `frames.ts`）本来就是传输无关的 JSON-lines ——
 * 缺的只是「谁递这行文本、谁报断开」这件事的接口。把它定下来之后，加一种传输 = 新写一个
 * `Wire` 实现 + 一个监听器，`Daemon` 与协议包都不用动。
 *
 * ## 为什么只有这六个成员（而不是照着 `net.Socket` 抄一份）
 *
 * 成员是从 `Daemon` 现有代码里**数**出来的，每个成员的注释都写明它在 `Daemon.ts` 的哪几处
 * 被用到（写方法名而不写行号 —— 行号会漂，而且漂了也没人会发现）。接口窄是目的本身：多一个成员，就是将来每一种传输（WebSocket / stdio / ssh 隧道）
 * 都必须实现一遍、都必须测一遍的义务。`pause` / `resume` / `end`（半关）/ `remoteAddress` /
 * `setNoDelay` / `bytesRead` … 现在一个都没用上，所以一个都不进来 —— 等真的要用时再加，
 * 顺手加进来的东西没人能说清它为什么该被每种传输实现。
 *
 * ## 线上流动的是**字符串**，不是 `Buffer`
 *
 * 抽取前后这条语义必须一致，所以写清楚：`Daemon` 原来靠 `socket.setEncoding("utf-8")`
 * 让 `data` 事件吐字符串，而 `FrameDecoder.push(chunk: string)` 是按**文本行**切帧的
 * （`indexOf("\n")`，并且按字符数比 `MAX_FRAME_BYTES`）。因此：
 *
 * - **解码成字符串的责任在传输这一侧**（net 那一路就是 `setEncoding("utf-8")`，见下面的
 *   `socketWire()`），`Wire` 上只跑 `string`。
 * - 反向选择（`Wire` 上跑 `Buffer`）会把「UTF-8 多字节字符被 chunk 边界切开」这件事推回
 *   协议层或 `Daemon`：那等于在两处定义帧边界，而 `FrameDecoder` 已经按「一行文本」定义过
 *   一次了。浏览器 WebSocket 的 `event.data` 本来就是字符串，跑 `string` 对它零成本。
 *
 * ## 本文件里**没有**哪个传输
 *
 * 只有接口 + 一个 `net.Socket` 适配器（现在唯一在用的传输，也就是 TCP 那一路）。
 * **没有** WebSocket、**没有** stdio、也**没有**内存假传输 —— 「已经支持 WebSocket」是
 * 没发生的事。用例里的内存双工只活在 `wire.test.ts`，因为它要证明的正是「不是
 * `net.Socket` 也能驱动 `Daemon`」。
 */

import type { Socket } from "node:net";

/**
 * 一条双工连接 —— 最小到「能把 JSON-lines 递进来、能把帧递出去、能报断开」。
 *
 * 生命周期：`onData` / `onError` / `onClose` 由 `Daemon` 在拿到 `Wire` 后立刻注册；
 * `destroy()` 之后 `destroyed` 必须为 `true`，且不再触发 `onData` / `onClose` 之外的任何
 * 回调（`onClose` 恰好触发一次）。
 */
export interface Wire {
  /**
   * 对端还能收吗。
   *
   * 用在哪：`Daemon.ts` 的 `Connection.send`、`fail()`、协议错误分支、`writeIfOpen()`
   * —— 都是在写帧之前判一下，等价于原来的 `socket.destroyed`。
   */
  readonly destroyed: boolean;

  /**
   * 入站：来了一段**已解码的文本**。
   *
   * 用在哪：`Daemon.ts` 的 `handleConnection()` 里唯一的入站口（吐出来的 chunk 直接喂
   * `FrameDecoder.push`）。
   *
   * 为什么是字符串：见文件头「线上流动的是字符串」。
   * 为什么没有退订返回值：这条线的寿命就是连接的寿命 —— 断开即整条丢弃，`Daemon` 不会
   * 在连接中途换掉自己的数据回调；返回一个没人用的退订函数只是给每种传输多一项义务。
   */
  onData(listener: (chunk: string) => void): void;

  /**
   * 传输层自己出了错（连接被重置、底层写失败等）。`Daemon` 只记一行 warn。
   *
   * 用在哪：`Daemon.ts` 的 `handleConnection()` 末尾那行 `conn#N socket error`。
   *
   * 为什么它必须在接口里（而不是让适配器自己吞掉）：`net.Socket` 上的 `error` 事件没有
   * 监听者时会**抛出并把整个守护进程带走**；合并进 `onClose` 又会丢掉那条日志。将来
   * WebSocket 的 `error` 事件同一性质。
   */
  onError(listener: (error: Error) => void): void;

  /**
   * 连接彻底断了（对端关闭、被 `destroy()`、传输层报错后收尾）。恰好一次。
   *
   * 用在哪：`Daemon.ts` 里清连接表 + 跑 `Connection.onClose` 那批订阅（`events.watch`
   * 靠它退订）+ 重挂空闲计时器。
   */
  onClose(listener: () => void): void;

  /**
   * 出站：写一段文本（已经是 `encodeFrame()` 之后的一整行）。
   *
   * 用在哪：`Daemon.ts` 的 `Connection.send`（事件推送）、`fail()`、协议错误回帧、
   * 首帧回执、非请求帧回帧、`dispatch()` 的响应（含 `unknown-method`）。
   * 不做背压（不返回 `write()` 的那个 boolean）：原来也没用，与原来一致。
   */
  write(text: string): void;

  /**
   * 断掉这条连接（不给对端任何"再见"帧）。
   *
   * 用在哪：`Daemon.ts` 的 `Connection.close`、`fail()`、协议错误、以及 `doStop()` 的
   * 收摊回路（逐个断掉现有连接）。
   */
  destroy(): void;
}

/**
 * 把 `net.Socket` 包成 `Wire` —— 目前唯一的生产传输（TCP）。
 *
 * 为什么适配器放在这个文件：它是这个接口的**样板**。将来写 WebSocket 那一版时，对着它
 * 逐条映射即可（`ws.send` / `ws.close` / `readyState` / `message` / `error` / `close`），
 * 而"到底要映射到哪几个成员"这件事只有接口本身能回答。
 *
 * 为什么 `setEncoding` 在这里：把字节解成文本是传输的实现细节，不是协议概念 ——
 * 让 `Daemon` 去关心"这条线是文本还是字节"就等于把传输知识漏回协议层。
 */
export function socketWire(socket: Socket): Wire {
  // 与抽取之前那行 `socket.setEncoding("utf-8")` 逐字等价：'data' 从此吐字符串，
  // 多字节字符被切开时由 Node 的 StringDecoder 兜住（这就是不能挪到 Daemon 的原因）。
  socket.setEncoding("utf-8");

  return {
    get destroyed(): boolean {
      return socket.destroyed;
    },
    onData: (listener) => {
      socket.on("data", (chunk: string) => listener(chunk));
    },
    onError: (listener) => {
      socket.on("error", (error: Error) => listener(error));
    },
    onClose: (listener) => {
      socket.on("close", () => listener());
    },
    write: (text) => {
      // 不判 destroyed、不做重试：调用方（`Daemon`）本来就在写之前判，语义保持原样。
      socket.write(text);
    },
    destroy: () => {
      socket.destroy();
    },
  };
}
