/**
 * 帧协议 —— 一连接上跑的就是这一种帧，传输是谁都无所谓。
 *
 * 形态：**JSON-lines**（一行一个 JSON，`\n` 结尾）。
 *
 * 为什么不是长度前缀二进制：这东西要能用 `nc` / `curl` / `telnet` 手搓调试，也要能原样
 * 塞进 WebSocket 文本帧和 stdio（将来 `ssh` 隧道）。可读性在这个阶段比省几个字节值钱。
 * 大块二进制（图片、超限工具输出）走 `artifact.*` 方法旁路，不进文本帧。
 *
 * 分隔符只认 `\n`：`JSON.stringify` 不会产出裸换行（字符串里的换行会被转义成 `\n`），
 * 所以按 `\n` 切分是安全的。
 */

/** 单帧上限：8 MiB。超了直接判协议错误，不做"尽力截断" */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * 帧编码：对象 → 一行文本（含结尾换行）。
 *
 * 参数叫 `frame` 而不是「一条消息」：它就是「要被编码的那个帧对象」，与对话消息毫无关系
 * —— 后者现在是具名类型（`Message`）。两个概念共用一个词，会让「载荷里不许有匿名的
 * 对话消息」那条 grep 检查误报。
 */
export function encodeFrame(frame: unknown): string {
  return JSON.stringify(frame) + "\n";
}

/**
 * 帧解码器 —— 一个连接一个实例，按到达顺序吐出完整帧。
 *
 * 用 buffer 累积而不是 `readline`：这里要自己管 `MAX_FRAME_BYTES`，而且不能因为一个
 * 畸形帧就把整条连接拖进不确定状态。
 */
export class FrameDecoder {
  private buffer = "";

  /**
   * 喂一段数据，返回本次能切出的完整帧（已 `JSON.parse`）。
   *
   * @throws 单帧超限（`FRAME_TOO_LARGE`）或 JSON 解析失败（`BAD_FRAME`）
   */
  push(chunk: string): unknown[] {
    this.buffer += chunk;

    const frames: unknown[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
      // 空行（心跳保活、粘贴多一个换行）直接忽略
      if (!line) continue;
      frames.push(parseLine(line));
    }

    // 剩下的半帧也要设上限，否则一条不发换行的连接就能把内存吃光
    if (this.buffer.length > MAX_FRAME_BYTES) {
      throw new ProtocolError("frame-too-large", `frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    return frames;
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new ProtocolError("bad-frame", "frame is not valid JSON");
  }
}

/** 协议层错误：带可机器判别的 code，客户端据此决定"重连"还是"报错给人看" */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export type ProtocolErrorCode =
  | "bad-frame"
  | "frame-too-large"
  | "bad-handshake"
  | "version-mismatch"
  | "unknown-method"
  | "bad-params"
  | "internal";
