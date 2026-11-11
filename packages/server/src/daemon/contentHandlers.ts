/**
 * 内容转块的服务端入口 —— `content.upload` 的接线。
 *
 * 这一层薄到只剩三件事：**参数形状校验**、**把这段会话的端点与模型查出来**、**调 SDK 的
 * 唯一实现**（`fileToContentSection`）。上传 / 内联 / 缓存 / `file_id` 归属一律不做第二遍 ——
 * 那些判据的输入（端点能力、模型 `vision`、内联上限）在这条路的尽头，复制到客户端就会漂。
 *
 * ## 为什么端点要按**这段会话**查
 *
 * `file_id` 是端点维度的资源：同一批字节传到两个端点会得到两个不同的 id，混用会让另一头
 * 返回 not found。所以这里查的是「这段会话此刻在用的模型」→ `apiModel` → 端点，而不是
 * 客户端递上来的某个 id（客户端手里的配置可能是旧的，切过模型之后更是）。
 *
 * 实发模型名（`apiModel`）从会话快照里取：它是 SDK 解析三级模型之后真正写进请求的那个名字，
 * 与 `modelId`（配置里的身份）在有别名时不同 —— 按后者反查会落空，然后静默退化成内联。
 */

import type { Connection, MethodHandlers } from "./Daemon.js";
import { badParams, requireString } from "./params.js";
import type { ContentUploadResult } from "../protocol/index.js";
import type { SessionManager } from "../domain/session/SessionManager.js";
import type { ConfigService } from "../domain/config/ConfigService.js";
import { fileToContentSection, resolveModelAndEndpoint } from "@ai-zen/agents-sdk";
import type { AppConfig, UploadFn } from "@ai-zen/agents-sdk";

export interface ContentHandlerOptions {
  /** 只要「读这份会话的快照」一件事（实发模型名从里面来） */
  manager: Pick<SessionManager, "snapshot">;
  /** 当前配置：端点表与模型表，`fileToContentSection` 按它判上传 / 内联 */
  config: Pick<ConfigService, "get">;
  /**
   * Files API 上传实现。不注入 = SDK 的缺省实现（`POST {baseUrl}/files`）。
   *
   * 留成可注入是为了让用例不必联网 —— 上传本身是 HTTP，不是这条协议的一部分。
   */
  upload?: UploadFn;
}

export function createContentHandlers(options: ContentHandlerOptions): MethodHandlers {
  return {
    /**
     * 一段字节 → 一块能放进消息的内容（`text` / `image_url` / `file`）。
     *
     * 字节由帧后紧跟的 payload 提供（见 `src/wire/frames.ts`）：走到这里时长度已经由解码器
     * 保证过，不再复核一个字节都不差的长度 —— 那是帧层的事实，这一层只认形状。
     */
    ["content.upload"]: async (
      params,
      _connection: Connection,
      payload,
    ): Promise<ContentUploadResult> => {
      const sessionId = requireString(params, "sessionId");
      const mime = requireString(params, "mime");
      const filename = requireString(params, "filename");
      if (!payload) throw badParams(`missing binary payload for "content.upload"`);

      // 会话不在（`unknown-session`）/ 配置读不出来都是带码的错误，原样递给客户端：
      // 两者都不是「参数形状错」，客户端的处置也不同（换会话 / 等一会儿重试）
      const { apiModel } = await options.manager.snapshot(sessionId);
      const { config } = await options.config.get();

      // 协议层把配置当**不透明载荷**（客户端不该解释它），而这里手里这份就是 SDK 的
      // `AppConfig` —— 需要它是因为端点解析（`resolveModelAndEndpoint`）的判据在 SDK 里
      const { model, endpoint } = resolveModelAndEndpoint(config as AppConfig, apiModel);

      const result = await fileToContentSection({
        source: { data: payload, mime, filename },
        endpoint,
        model,
        ...(options.upload ? { deps: { upload: options.upload } } : {}),
      });
      return result.warning === undefined
        ? { section: result.section }
        : { section: result.section, warning: result.warning };
    },
  };
}
