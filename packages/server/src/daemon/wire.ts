/**
 * 传输抽象 —— `Daemon` 认识的唯一一条「双工线」。
 *
 * ## 为什么需要这一层
 *
 * 若 `Daemon` 直接收 `net.Socket`，「服务端讲什么」与「字节从哪里来」就焊死在一起：
 * 想接 WebSocket（浏览器直连 / 远程）就得改 `Daemon` 本体。而 `Daemon` 里绝大部分
 * 代码（首帧 `hello` 校验、帧分发、在飞请求、事件推送、空闲退出）与传输毫无关系。
 * 帧协议（`src/wire/frames.ts`）本来就是传输无关的 JSON-lines（外加帧后的二进制挂法）——
 * 缺的只是「谁递这行文本、谁报断开」这件事的接口。把它定下来之后，加一种传输 = 新写一个
 * `Wire` 实现 + 一个监听器，`Daemon` 与契约层都不用动。
 *
 * ## 为什么只有这六个成员（而不是照着 `net.Socket` 抄一份）
 *
 * 成员是从 `Daemon` 现有代码里**数**出来的，一个不多一个不少（写名字而不写行号 —— 行号会漂，
 * 而且漂了也没人会发现）。接口窄是目的本身：多一个成员，就是每一种传输（WebSocket / stdio /
 * ssh 隧道）都必须实现一遍、都必须测一遍的义务。`pause` / `resume` / `end`（半关）/ `remoteAddress` /
 * `setNoDelay` / `bytesRead` … 现在一个都没用上，所以一个都不进来 —— 等真的要用时再加，
 * 顺手加进来的东西没人能说清它为什么该被每种传输实现。
 *
 * ## 线上流动的是**字节**，不是字符串
 *
 * `Wire.onData` 递的是 `Buffer`：帧协议里除了文本行还有**原始字节**（带 `bytes` 的请求帧
 * 后面紧跟恰好那么多字节，见 `src/wire/frames.ts`）。这里必须说清楚为什么不能解码成
 * 字符串：任意字节都可能出现在 payload 里，过一遍 UTF-8 解码就已经坏了（非法序列会被
 * 换成 U+FFFD，`0x0A` 之类的字节会被当成帧边界）—— 坏在**数据**上，而且没有报错。
 *
 * 所以 `Daemon` 拿到的就是字节，切帧（按 `\n` 切行 / 按声明长度切 payload）也由
 * `FrameDecoder` 在字节上完成：帧边界只在这一个地方定义。
 *
 * ## 本文件里**没有**哪个传输
 *
 * 只有接口 + 一个 `net.Socket` 适配器（唯一在用的传输，也就是 TCP 那一路）。
 * 没有 WebSocket、没有 stdio、也没有内存假传输；用例里的内存双工只活在 `wire.test.ts`，
 * 因为它要证明的正是「不是 `net.Socket` 也能驱动 `Daemon`」。
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
   * 对端还能收吗 —— `Daemon` 写帧之前判一下（等价于直接看 `socket.destroyed`）。
   */
  readonly destroyed: boolean;

  /**
   * 入站：来了一段**原始字节** —— `Daemon` 唯一的入站口（chunk 直接喂 `FrameDecoder.push`）。
   *
   * 为什么是 `Buffer`：见文件头「线上流动的是字节」。解成文本的责任不在传输这一侧 ——
   * payload 里出现什么字节都是合法的，任何一次性解码都会把它弄坏。
   * 为什么没有退订返回值：这条线的寿命就是连接的寿命 —— 断开即整条丢弃，`Daemon` 不会
   * 在连接中途换掉自己的数据回调；返回一个没人用的退订函数只是给每种传输多一项义务。
   */
  onData(listener: (chunk: Buffer) => void): void;

  /**
   * 传输层自己出了错（连接被重置、底层写失败等）—— `Daemon` 只记一行 warn。
   *
   * 为什么它必须在接口里（而不是让适配器自己吞掉）：`net.Socket` 上的 `error` 事件没有
   * 监听者时会**抛出并把整个守护进程带走**；合并进 `onClose` 又会丢掉那条日志。WebSocket 的
   * `error` 事件同一性质。
   */
  onError(listener: (error: Error) => void): void;

  /**
   * 连接彻底断了（对端关闭、被 `destroy()`、传输层报错后收尾）。恰好一次。
   *
   * `Daemon` 在这上面清连接表、跑 `Connection.onClose` 那批订阅（`events.watch` 靠它退订）、
   * 重挂空闲计时器。
   */
  onClose(listener: () => void): void;

  /**
   * 出站：写一段文本（已经是 `encodeFrame()` 之后的一整行）。
   *
   * 事件推送、握手回执、错误回帧、方法响应都走它 —— 出站只有这一个口子。
   * 不做背压（不返回 `write()` 的那个 boolean）：没有调用方会看它。
   */
  write(text: string): void;

  /**
   * 断掉这条连接（不给对端任何"再见"帧）。
   *
   * 主动 `close`、握手失败、收摊时逐个断掉现有连接，都走它。
   */
  destroy(): void;
}

/**
 * 把 `net.Socket` 包成 `Wire` —— 唯一的生产传输（TCP）。
 *
 * 为什么适配器放在这个文件：它是这个接口的**样板**。写另一种传输时，对着它逐条映射即可
 * （`ws.send` / `ws.close` / `readyState` / `message` / `error` / `close`），而"到底要映射到
 * 哪几个成员"这件事只有接口本身能回答。
 *
 * 为什么不做 `setEncoding`：`data` 事件因此吐 `Buffer`，payload 原样到达 `FrameDecoder`
 * （见文件头「线上流动的是字节」）。改回字符串会让图片这类二进制数据在**数据**上悄悄坏掉。
 */
export function socketWire(socket: Socket): Wire {
  return {
    get destroyed(): boolean {
      return socket.destroyed;
    },
    onData: (listener) => {
      socket.on("data", (chunk: Buffer) => listener(chunk));
    },
    onError: (listener) => {
      socket.on("error", (error: Error) => listener(error));
    },
    onClose: (listener) => {
      socket.on("close", () => listener());
    },
    write: (text) => {
      // 不判 destroyed、不做重试：调用方（`Daemon`）在写之前已经判过了。
      socket.write(text);
    },
    destroy: () => {
      socket.destroy();
    },
  };
}
