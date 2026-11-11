/**
 * 帧协议 —— 一连接上跑的就是这一种帧，传输是谁都无所谓。
 *
 * 形态：**JSON-lines**（一行一个 JSON，`\n` 结尾），加一种**二进制挂法**：
 *
 * ```
 * {"id":7,"method":"content.upload","params":{…,"bytes":1048576}}
 * <1048576 个原始字节，无分隔符、无编码>
 * {"id":8,"method":"…"}      ← 紧接着就是下一帧，长度已经声明过了
 * ```
 *
 * 为什么主形态是 JSON-lines 而不是长度前缀：这东西要能用 `nc` / `curl` / `telnet` 手搓
 * 调试，也要能原样塞进 WebSocket 文本帧和 stdio —— 可读性比省几个字节值钱。
 *
 * 为什么字节不 base64 塞回 JSON：那让体积涨三分之一，还得先整块变成字符串再解析一次。
 * 图片 / 附件这种 MB 级的东西要的是「声明长度 → 原样收」：帧里的 `bytes` 就是长度，
 * 之后紧跟恰好这么多个字节，收满之后回到按行切帧。
 *
 * 二进制阶段只由**显式入口**开始（{@link FrameDecoder.expectBytes}）：解码器不认识方法
 * 名、也不猜「哪个字段像是长度」—— 谁知道这条方法带 payload，就由谁说「接下来 N 个字节」。
 * 二进制阶段**不按 `\n` 切**（任意字节都可能是 0x0A），要切的是字节数。
 *
 * ## 为什么解码是「一项一项取」（{@link FrameDecoder.next}）
 *
 * 因为**一个帧之后是不是二进制，只有调用方知道**。解码器若在一次 `push` 里把整段缓冲
 * 解析到底，它就会越过那个判断：payload 里随便一个 `0x0A` 都会被当成帧边界，后面的字节
 * 从此全部错位（而那几乎总是会发生 —— 帧和 payload 通常在同一个 TCP 段里）。
 *
 * 所以吐出契约是：**每次最多一项**。调用方拿到帧、判断它带不带 payload、该调
 * `expectBytes()` 就调，然后才继续 `next()`。跨 chunk 的累积照样成立：`next()` 返回
 * `null` 就是「还凑不出一项，等更多字节」。
 *
 * 分隔符只认 `\n`：`JSON.stringify` 不会产出裸换行（字符串里的换行会被转义成 `\n`），
 * 所以按 `\n` 切分是安全的。
 */

/** 单帧上限：8 MiB。超了直接判协议错误，不做"尽力截断" */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * 单块二进制 payload 的上限：64 MiB。
 *
 * 与 `MAX_FRAME_BYTES` 是两个约束：文本帧的上限管「一帧能不能被完整解析」，这个管
 * 「一次传输能把内存吃多深」。声明超过它的长度在收**第一个**字节之前就拒 —— 收满再拒
 * 等于用内存换一句错误提示。
 */
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

/**
 * 帧编码：对象 → 一行文本（含结尾换行）。
 *
 * 参数叫 `frame` 而不是「一条消息」：它是「要被编码的那个帧对象」，与对话消息无关 ——
 * 后者是具名类型（`Message`）。两个概念共用一个词，读代码的人会以为这里能递一条对话消息。
 *
 * 只管文本帧：带 payload 的请求由调用方在 `encodeFrame()` 之后自己写那 N 个字节
 * （线上顺序就是「帧先、字节后」，编码侧不必再提供一个合体函数）。
 */
export function encodeFrame(frame: unknown): string {
  return JSON.stringify(frame) + "\n";
}

/**
 * 解码器吐出的一项：一个完整的 JSON 帧，或一块收满的二进制 payload。
 *
 * 两类共用一个出口（而不是两个方法）：它们的**先后**是协议的一部分（帧 → 它的 payload →
 * 下一帧），分成两个出口就没法表达这件事。
 */
export type DecodedItem =
  | { readonly type: "frame"; readonly frame: unknown }
  | { readonly type: "bytes"; readonly bytes: Buffer };

/**
 * 帧解码器 —— 一个连接一个实例：`push()` 喂字节，`next()` 一项一项取出。
 *
 * 用 buffer 累积而不是 `readline`：这里要自己管两个上限，而且不能因为一个畸形帧就把
 * 整条连接拖进不确定状态。
 */
export class FrameDecoder {
  /** 已收到、还没切出去的字节（跨 chunk 累积） */
  private buffer: Buffer = Buffer.alloc(0);
  /** 二进制阶段还差多少字节；`null` = 按行切帧的常规阶段 */
  private remaining: number | null = null;
  /** 二进制阶段收到的片（收满那一刻拼成一块，之前一直是不拷贝的视图） */
  private slices: Buffer[] = [];
  /** 进入二进制阶段时声明的长度（拼块时要用它；收满后清零） */
  private declared = 0;

  /** 追加一段字节（不解析 —— 解析是 `next()` 的事，顺序由调用方决定） */
  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /**
   * 进入二进制阶段：接下来 `length` 个字节是 payload，收满后由 `next()` 原样交出。
   *
   * 只该在**刚取出一个帧之后**调（常规阶段）；要不要调由调用方按方法名 + 帧里的 `bytes`
   * 判断 —— 这个判断必须与取帧在同一个同步过程里做，否则顺序会乱。
   *
   * @throws 不是正整数（`bad-frame`）或超过 `MAX_PAYLOAD_BYTES`（`frame-too-large`）
   */
  expectBytes(length: number): void {
    if (!Number.isInteger(length) || length <= 0) {
      throw new ProtocolError(
        "bad-frame",
        `payload length must be a positive integer, got ${length}`,
      );
    }
    if (length > MAX_PAYLOAD_BYTES) {
      throw new ProtocolError(
        "frame-too-large",
        `payload of ${length} bytes exceeds the ${MAX_PAYLOAD_BYTES} byte limit`,
      );
    }
    this.remaining = length;
    this.declared = length;
    this.slices = [];
  }

  /**
   * 取出下一项；`null` = 缓冲里还凑不出一项（等下一个 chunk）。
   *
   * payload 从**自己的缓冲**里切：同一个 chunk 里跟在帧后面的字节不会被当成帧边界，
   * 一个 chunk 装不下的部分留在缓冲里，等下一次 `push()` 接着收。
   *
   * @throws 单帧超限（`frame-too-large`）或 JSON 解析失败（`bad-frame`）
   */
  next(): DecodedItem | null {
    for (;;) {
      if (this.remaining !== null) {
        const take = Math.min(this.remaining, this.buffer.length);
        if (take > 0) {
          this.slices.push(this.buffer.subarray(0, take));
          this.buffer = this.buffer.subarray(take);
          this.remaining -= take;
        }
        // 还没收满：等更多字节。剩下的字节一个都不能动（何况按 `\n` 切）
        if (this.remaining > 0) return null;
        const bytes = Buffer.concat(this.slices, this.declared);
        this.remaining = null;
        this.declared = 0;
        this.slices = [];
        return { type: "bytes", bytes };
      }

      const index = this.buffer.indexOf(0x0a);
      if (index < 0) {
        // 缓冲里一个换行都没有 = 全部是一个半帧。半帧也要设上限，否则一条不发换行的
        // 连接就能把内存吃光
        if (this.buffer.length > MAX_FRAME_BYTES) {
          throw new ProtocolError("frame-too-large", `frame exceeds ${MAX_FRAME_BYTES} bytes`);
        }
        return null;
      }
      // payload 之外的行一定按整行解：多字节字符不会跨行，所以这一处 UTF-8 解码是完整的
      const line = this.buffer.subarray(0, index).toString("utf8").trim();
      this.buffer = this.buffer.subarray(index + 1);
      // 空行（心跳保活、粘贴多一个换行）直接忽略
      if (!line) continue;
      return { type: "frame", frame: parseLine(line) };
    }
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
