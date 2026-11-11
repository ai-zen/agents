/**
 * 传输抽象 —— `Daemon` 认识的唯一一条「双工线」。
 *
 * ## 为什么需要这一层
 *
 * 若 `Daemon` 直接收一个 `ws.WebSocket`，「服务端讲什么」与「消息从哪里来」就焊死在一起：
 * 想接别的承载（stdio、`ssh` 隧道、内存双工做用例）就得改 `Daemon` 本体。而 `Daemon` 里
 * 绝大部分代码（握手门、消息分类、在飞请求、二进制配对、事件推送、空闲退出）与传输毫无
 * 关系。把这个接缝定下来之后，加一种传输 = 新写一个 `Wire` 实现 + 一个监听器。
 *
 * ## 为什么文本与二进制是**两个**入口
 *
 * 上一版的 `onData(chunk: Buffer)` 是字节流时代的形状：那时「这条消息到哪儿结束」得由解码器
 * 在字节上找，二进制载荷混在同一条流里，所以只能递字节。现在这两件事都由 WebSocket 回答了
 * —— 它**逐条**把消息交上来，并且告诉我们这一条是文本还是二进制。
 *
 * 于是接口照实写：`onText` 递一条文本（已经是字符串），`onBinary` 递一条二进制的原始字节
 * （`Buffer`，一个字节都不动 —— 中间任何一次 UTF-8 解码都会把图片弄坏）。`Daemon` 因此
 * 不需要知道「一条消息在哪里结束」，也不需要自己区分「这段字节是不是载荷」。
 *
 * 只有 `write` 仍然只有文本出口：**服务端不发二进制**（它的结果全部是 JSON）。将来真的
 * 要发（比如把某个资产以原始字节推回去）再加 `writeBinary`，而不是现在留一个没人调的口子。
 *
 * ## 为什么只有这几个成员（而不是照着 `ws.WebSocket` 抄一份）
 *
 * 成员是从 `Daemon` 现有代码里**数**出来的，一个不多一个不少。接口窄是目的本身：多一个
 * 成员，就是每一种传输都必须实现一遍、都必须测一遍的义务。`pause` / `ping` / `protocol` /
 * `bufferedAmount` … 现在一个都没用上，所以一个都不进来。
 *
 * ## 本文件里**只有**一个 WebSocket 适配器
 *
 * 唯一的生产传输是 WebSocket（浏览器开不了裸 TCP，远程客户端也只认它）。内存假传输只活在
 * `wire.test.ts` 里，因为它要证明的正是「不是 `ws.WebSocket` 也能驱动 `Daemon`」。
 */

import { WebSocket, type RawData } from "ws";

/**
 * 一条双工连接 —— 最小到「能把一条文本 / 一条二进制递进来、能把文本递出去、能报断开」。
 *
 * 生命周期：`onText` / `onBinary` / `onError` / `onClose` 由 `Daemon` 在拿到 `Wire` 后立刻
 * 注册；`destroy()` 之后 `destroyed` 必须为 `true`，并且 `onClose` 恰好触发一次。
 *
 * 没有退订返回值：这条线的寿命就是连接的寿命 —— 断开即整条丢弃，`Daemon` 不会在连接中途
 * 换掉自己的回调；返回一个没人用的退订函数只是给每种传输多一项义务。
 */
export interface Wire {
  /** 对端还能收吗 —— `Daemon` 写之前判一下（写一条已经关掉的连接是安静的空操作） */
  readonly destroyed: boolean;

  /**
   * 入站：来了**一条文本消息**。
   *
   * 消息边界由传输层保证 —— 不会出现「半条」，也不会把两条拼在一起。解出来的字符串可能
   * 根本不是 JSON：那是 `Daemon` 的事（回 `bad-frame`），不是传输的事。
   */
  onText(listener: (text: string) => void): void;

  /**
   * 入站：来了**一条二进制消息**（前 4 字节是请求 `id`，其余是载荷，见 `wire/messages.ts`）。
   *
   * 递的是原始字节：载荷里出现什么字节都合法，过一遍 UTF-8 解码就已经坏了，而且不报错。
   */
  onBinary(listener: (bytes: Buffer) => void): void;

  /**
   * 传输层自己出了错（连接被重置、底层写失败等）—— `Daemon` 只记一行 warn。
   *
   * 为什么它必须在接口里（而不是让适配器自己吞掉）：`ws` 的 `error` 事件没有监听者时会
   * **抛出并把整个守护进程带走**；合并进 `onClose` 又会丢掉那条日志。
   */
  onError(listener: (error: Error) => void): void;

  /**
   * 连接彻底断了（对端关闭、被 `destroy()`、传输层报错后收尾）。恰好一次。
   *
   * `Daemon` 在这上面清连接表、跑 `Connection.onClose` 那批订阅（`events.watch` 靠它退订）、
   * 重挂空闲计时器。
   */
  onClose(listener: () => void): void;

  /** 出站：写一条文本（已经是 `encodeFrame()` 之后的一整串）。出站只有这一个口子 */
  write(text: string): void;

  /**
   * 断掉这条连接。
   *
   * 实现上是**优雅关闭**（`ws.close()`）：先把已经排队的帧发出去，再发关闭帧。顺序很重要
   * —— 握手失败时那一条错误响应正好靠它送到对端，紧接着连接才消失（`terminate()` 会把还没
   * 进内核缓冲的帧一起丢掉）。对端不回应关闭帧时由 `ws` 的关闭计时器兜底。
   */
  destroy(): void;
}

/**
 * 把 `ws.WebSocket` 包成 `Wire` —— 唯一的生产传输。
 *
 * 适配器放在这个文件：它是这个接口的**样板**。写另一种传输时对着它逐条映射即可
 * （`send` / `close` / `readyState` / `message` / `error` / `close`）。
 */
export function webSocketWire(socket: WebSocket): Wire {
  return {
    get destroyed(): boolean {
      return socket.readyState !== WebSocket.OPEN;
    },
    onText: (listener) => {
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) return;
        listener(toBuffer(data).toString("utf8"));
      });
    },
    onBinary: (listener) => {
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (!isBinary) return;
        listener(toBuffer(data));
      });
    },
    onError: (listener) => {
      socket.on("error", (error: Error) => listener(error));
    },
    onClose: (listener) => {
      socket.on("close", () => listener());
    },
    write: (text) => {
      // 不判 readyState、不做重试：调用方（`Daemon`）写之前已经判过 `destroyed` 了
      socket.send(text);
    },
    destroy: () => {
      socket.close();
    },
  };
}

/** `ws` 的 `RawData` 三种形态收成一块 `Buffer`（不分片时它本来就是 `Buffer`） */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
