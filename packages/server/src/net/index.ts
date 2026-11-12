/**
 * 接线层出口：发现文件、凭证、上传接收、WebSocket 总线。
 *
 * 这一层只做「进程与外界的边界」：握手、分发、推送、二进制分帧。
 * 业务逻辑在 `services/` 与 `runtime/`，由单根（`app.ts`）注入进来。
 */

export {
  clearLocalToken,
  clearServerFile,
  readLocalToken,
  readServerFile,
  writeLocalToken,
  writeServerFile,
} from "./discovery.js";
export type { ServerFileInfo } from "./discovery.js";

export { createLocalCredential, createTokenVerifier, LOCAL_CREDENTIAL_NOTE, verify } from "./auth.js";
export type { LocalCredentialOptions, LocalCredentialResult, TokenVerifier, VerifiedCredential } from "./auth.js";

export { decodeChunkFrame, encodeChunkFrame, formatBytes, UploadReceiver } from "./UploadReceiver.js";
export type {
  UploadFinalizeRequest,
  UploadFinalizer,
  UploadReceiverOptions,
} from "./UploadReceiver.js";

export { WsHub } from "./WsHub.js";
export type {
  ConnectionInfo,
  EventLocalizer,
  HandlerTable,
  HubLogger,
  MethodCallContext,
  MethodHandler,
  WsHubOptions,
} from "./WsHub.js";
