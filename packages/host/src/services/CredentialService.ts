/**
 * 凭证服务：多串访问凭证的列出、新建、吊销。
 *
 * 对应能力编号：L11（凭证靠复制 + 手动输入、可以有多串、创建时带备注、权限相同、可单独吊销）、
 * F-E4（直达入口里的一项）。不做账号与按人分权限（L12）—— 凭证代表的是「一台设备」。
 *
 * 明文的去处只有一处：`create` 的返回值。库里存的是 `hashCredential` 算出的摘要，服务层
 * 拿不到明文也就无法再吐出来第二次（吊销用 id，不用明文）。
 */

import { randomBytes, randomUUID } from "node:crypto";

import type { CredentialRepository } from "../storage/CredentialRepository.js";
import { hashCredential } from "../storage/CredentialRepository.js";
import type { CredentialInfo } from "../storage/types.js";
import { HostError } from "../wire/errors.js";
import type {
  CredentialCreateParams,
  CredentialCreateResult,
  CredentialListResult,
  CredentialRevokeParams,
  CredentialRevokeResult,
  CredentialView,
} from "../wire/index.js";

/** 凭证服务依赖 */
export interface CredentialServiceDeps {
  credentials: CredentialRepository;
  /** 时钟，测试注入用；缺省 `Date.now` */
  now?: () => number;
}

/** 明文凭证的字节数（base64url 编码后 43 个字符） */
const TOKEN_BYTES = 32;

/** 时间戳转 wire 上的 ISO 8601 */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 库里的一行 → 对外视图（不含摘要） */
function toView(row: CredentialInfo): CredentialView {
  return {
    id: row.id,
    note: row.note,
    createdAt: iso(row.createdAt),
    revokedAt: row.revokedAt === null ? null : iso(row.revokedAt),
  };
}

export class CredentialService {
  private readonly credentials: CredentialRepository;
  private readonly now: () => number;

  constructor(deps: CredentialServiceDeps) {
    this.credentials = deps.credentials;
    this.now = deps.now ?? Date.now;
  }

  /** 列出全部凭证（含已吊销的，吊销状态在 `revokedAt` 上） */
  async list(): Promise<CredentialListResult> {
    const rows = await this.credentials.list();
    return { credentials: rows.map((row) => toView(row)) };
  }

  /** 新建一串：备注自己写，明文只在这个返回值里出现一次 */
  async create(params: CredentialCreateParams): Promise<CredentialCreateResult> {
    const note = typeof params.note === "string" ? params.note.trim() : "";
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const id = randomUUID();
    const createdAt = this.now();

    await this.credentials.create({
      id,
      note,
      hash: hashCredential(token),
      createdAt,
    });

    const row = await this.credentials.get(id);
    if (!row) {
      throw new HostError("internal", {
        detail: { reason: "credential vanished after insert", id },
      });
    }
    return {
      credential: {
        id: row.id,
        note: row.note,
        createdAt: iso(row.createdAt),
        revokedAt: row.revokedAt === null ? null : iso(row.revokedAt),
      },
      token,
    };
  }

  /**
   * 吊销一串（置 `revokedAt`，不删行：留着能看出这串曾经存在过）。
   *
   * `revoked` 表示这次调用是否真的改动了库：对一串已经吊销过的凭证再吊销一次，返回 false
   * 而不是报错（端状态一样是「已吊销」）。
   */
  async revoke(params: CredentialRevokeParams): Promise<CredentialRevokeResult> {
    const id = typeof params.credentialId === "string" ? params.credentialId.trim() : "";
    const row = id.length === 0 ? undefined : await this.credentials.get(id);
    if (!row) {
      throw new HostError("not_found", {
        params: { entity: "credential" },
        detail: { credentialId: params.credentialId },
      });
    }
    if (row.revokedAt !== null) return { revoked: false };
    const changes = await this.credentials.revoke(row.id, this.now());
    return { revoked: changes > 0 };
  }
}
