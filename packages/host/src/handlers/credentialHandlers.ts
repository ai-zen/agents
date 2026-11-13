/**
 * `credential.*`：凭证多串（PRD L11 / F-E4）。
 *
 * 库里的那份是真相（可列出、带备注、可单独吊销），明文只在 `create` 的回包里出现一次；
 * 本地实例的交付文件（`run/token`）由启动流程负责，本域不碰它。
 */

import type { HandlerTable } from "../net/index.js";
import type { CredentialService } from "../services/CredentialService.js";

export interface CredentialHandlerDeps {
  credentials: CredentialService;
}

export function createCredentialHandlers(deps: CredentialHandlerDeps): HandlerTable {
  return {
    "credential.list": async () => await deps.credentials.list(),
    "credential.create": async (context) => await deps.credentials.create(context.params),
    "credential.revoke": async (context) => await deps.credentials.revoke(context.params),
  };
}
