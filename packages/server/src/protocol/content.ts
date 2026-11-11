/**
 * 消息内容契约 —— `content.upload`：把一段字节换成「能直接放进消息的内容块」。
 *
 * ## 为什么这个决定在服务端
 *
 * 同一批字节该怎么发，取决于**这一段会话此刻用的端点与模型**：端点声明
 * `capabilities.filesApi` 就上传成 `file_id`，否则 base64 内联成 data URL；模型
 * `vision !== true` 时图片退化成一文本提示；内联体积还会被上限挡住。这一整套判据的唯一
 * 实现是 SDK 的 `fileToContentSection`，它要读配置（端点表 / 模型表）与真实字节。
 *
 * 这些东西都在服务端：配置是**服务端那份**，上传（`POST {baseUrl}/files`）带着端点的密钥，
 * `file_id` 也是端点维度的资源、只对上传它的那个端点有效。客户端递字节，服务端算一次 ——
 * 两边各算一遍就是两份会漂的判据，而它们迟早会对同一张图给出不同答案。
 *
 * ## 为什么单开一个命名空间（而不是 `session.upload`）
 *
 * 方法的作用对象是**消息内容**，会话 id 只是「用哪套端点 / 模型」的输入。挂进 `session.*`
 * 会让人以为它和 `session.send` 是同类动作（发一轮），而它其实不发任何东西、只回一块内容。
 * 反过来它也不是 `asset.*`（那是「本机有什么能力」的只读清单）。
 *
 * ## 线上的字节不在这份文件里
 *
 * `bytes` 只是**长度声明**：请求帧后面紧跟恰好这么多个原始字节（帧形状见
 * `src/wire/frames.ts`）。这里不重复描述帧的挂法，只声明「有这么个数」。
 */

import type { MessageContentBlock } from "./sessions.js";

/** 内容方法名（服务端注册与客户端调用共用同一份字面量） */
export type ContentMethod = "content.upload";

export interface ContentUploadParams {
  /**
   * 这批内容要发给哪一段会话 —— 端点与视觉能力由这段会话**实际使用**的模型决定。
   *
   * 不给「端点 id / 模型名」而给会话：客户端只知道自己切到了哪一段会话，而这个问题的答案
   * （实发模型名 → 端点）是服务端的解析结果，客户端再推一遍就是第二份会漂的实现。
   */
  sessionId: string;
  /**
   * 帧后紧跟的原始字节数。
   *
   * 它是**帧形状的一部分**，不是普通参数：解码方据它切出 payload，收满之前不按 `\n`
   * 找帧边界。非正整数、超过 payload 上限、或出现在不带字节的方法上都是协议错误。
   */
  bytes: number;
  /** 字节的 MIME（`image/png` / `application/pdf` …）—— 决定走图片通道还是文件通道 */
  mime: string;
  /**
   * 文件名。Files API 上传需要它，`file` 块的 `filename` 也用它。
   *
   * 必填：调用方总得给这批字节起个名字（粘贴的图片叫 `pasted-1.png` 这类），
   * 让服务端另造一个默认名只是多一份命名规则。
   */
  filename: string;
}

export interface ContentUploadResult {
  /** 直接放进 `MessageContent` 的那一块（`text` / `image_url` / `file`） */
  section: MessageContentBlock;
  /**
   * 这一块是**降级**来的时的说明：上传失败转内联、模型不支持视觉转文本提示。
   *
   * 为什么随结果回来：降级的判据在服务端（只有它知道上传成没成、模型看不看得见图），
   * 而「要不要告诉用户」是客户端的事（通知栏）。不带这个字段，那两条说明就只能烂在
   * 服务端日志里。
   */
  warning?: string;
}

/** `ContentMethod` 的**成员名**（不是线上值）—— 给「门面必须覆盖每一条」这类类型级用例用 */
export type ContentMethodKey = "upload";
