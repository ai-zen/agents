import { createHash, randomBytes, randomUUID } from "node:crypto";

import { HostError } from "../../infra/errors.js";
import type { Translator } from "../i18n/index.js";
import type { credentialTable } from "./table.js";
import type { Credential } from "./types.js";

export interface CredentialDeps {
  readonly credentials: ReturnType<typeof credentialTable>;
  readonly t: Translator;
}

export class CredentialService {
  constructor(private readonly deps: CredentialDeps) {}

  /** 明文只在这一次的回值里出现：库里存的是摘要，之后再也没有任何一处能读回它 */
  create(note: string): { credential: Credential; token: string } {
    const token = randomBytes(32).toString("base64url");
    const credential: Credential = {
      id: randomUUID(),
      note,
      hash: sha256(token),
      createdAt: Date.now(),
      revokedAt: null,
    };
    this.deps.credentials.put(credential);
    return { credential, token };
  }

  /** 已吊销的当作不存在：调用点要问的是「这把还能不能用」，答案是不能 */
  verify(token: string): Credential | undefined {
    const credential = this.deps.credentials.getByHash(sha256(token));
    if (credential === undefined || credential.revokedAt !== null) return undefined;
    return credential;
  }

  list(): Omit<Credential, "hash">[] {
    return this.deps.credentials.list().map(withoutHash);
  }

  revoke(id: string): Omit<Credential, "hash"> {
    const current = this.deps.credentials.get(id);
    if (current === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("找不到 id 为 {credentialId} 的凭证", { credentialId: id }),
        { entity: "credential", credentialId: id },
      );
    }

    // 吊销两次不刷新那一格：它说的是「什么时候失效」，第二次点击不是失效的时刻
    const revoked: Credential = { ...current, revokedAt: current.revokedAt ?? Date.now() };
    this.deps.credentials.put(revoked);
    return withoutHash(revoked);
  }
}

/** 创建与校验共用这一处：两边的口径不一致，就等于验证不了自己刚发出去的令牌 */
function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 出域的那一份：`hash` 留在库里 —— 客户端拿摘要做不了任何事，带出去只是把指纹送走 */
function withoutHash(credential: Credential): Omit<Credential, "hash"> {
  const { hash: _hash, ...rest } = credential;
  return rest;
}
