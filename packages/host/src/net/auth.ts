/**
 * 凭证的校验与本地凭证的生成/交付（architecture §2 / PRD A5、L11）。
 *
 * 真相在库里：`credentials` 表一列存 sha256 摘要，明文只在两处出现 —— 创建时回给创建者的那一次，
 * 以及本地凭证写进 `<dataRoot>/run/token` 的那一份。于是「多串、带备注、可单独吊销」全部由库承担，
 * 本文件只做两件事：
 *
 *   1. {@link verify}：一串明文 → 库里仍有效的那一行（没命中就是 `null`）。
 *   2. {@link createLocalCredential}：本地实例首次启动时造一串（备注 `local`）并写进交付文件。
 *
 * **所有连接都要凭证**（PRD A5）：本地实例的「无感」来自「凭证已在交付文件里被客户端取走」，
 * 不是来自「回环地址免检」—— 所以这里没有任何「从 127.0.0.1 来就放行」的分支。
 */

import { randomBytes, randomUUID } from "node:crypto";

import type { HostPaths } from "../config.js";
import type { Database } from "../storage/Database.js";
import { CredentialRepository, hashCredential } from "../storage/CredentialRepository.js";
import { readLocalToken, writeLocalToken } from "./discovery.js";

/** 本地凭证的备注：与用户在 `credential.create` 里自己写的备注区分开 */
export const LOCAL_CREDENTIAL_NOTE = "local";

/** 凭证明文（base64url）的随机字节数；32 字节 → 43 个字符 */
const DEFAULT_TOKEN_BYTES = 32;

/** 校验通过的凭证：只给「哪一串」，不含摘要与明文 */
export interface VerifiedCredential {
  id: string;
  note: string;
}

/**
 * 校验一串凭证。
 *
 * 交给接线层的注入形状：`hello` 带上来的是明文，校验方只需要回答「这串还算数吗、是哪一串」。
 * 用法是「每条连接在 `hello` 时校验一次」，所以吊销对已经握过手的连接不回头生效
 * （吊销是「以后连不上」，不是「把别人踢下线」）。
 */
export interface TokenVerifier {
  verify(token: string): Promise<VerifiedCredential | null>;
}

/**
 * 一串明文 → 库里仍有效的那一行。
 *
 * 空串一律不通过：库里不会存在空串的摘要，但把「客户端漏传 token」与「token 不对」分成两种
 * 结果没有意义 —— 两者都是「这串不被接受」。
 */
export async function verify(db: Database, token: string): Promise<VerifiedCredential | null> {
  const plain = typeof token === "string" ? token.trim() : "";
  if (plain === "") return null;
  const credentials = new CredentialRepository(db);
  const row = await credentials.findActiveByHash(hashCredential(plain));
  return row === undefined ? null : { id: row.id, note: row.note };
}

/** 把 {@link verify} 包成注入用的对象（`WsHub` 收的就是这个形状） */
export function createTokenVerifier(db: Database): TokenVerifier {
  return {
    verify: (token: string) => verify(db, token),
  };
}

/** `createLocalCredential` 的可选项 */
export interface LocalCredentialOptions {
  /** 备注，缺省 `local` */
  note?: string;
  /** 时钟，测试注入用；缺省 `Date.now` */
  now?: () => number;
  /** 随机字节数，缺省 32（测试里可以调小） */
  tokenBytes?: number;
  /** 强制轮换：不管交付文件里那串是否还有效，都造一串新的并重写文件 */
  rotate?: boolean;
}

/** 本地凭证的生成结果 */
export interface LocalCredentialResult {
  /** 库里那一行的 id（吊销时用它） */
  credentialId: string;
  /** 明文；此后再也拿不到第二份，除非又读交付文件 */
  token: string;
  /** 这次是不是真的新造了一串（`false` 表示复用了交付文件里那串） */
  created: boolean;
}

/**
 * 取（必要时先生成）本地凭证，并保证 `<dataRoot>/run/token` 里是**当前可用**的那一串。
 *
 * 三种情形：
 *   - 交付文件有内容且库里仍有效 → 直接复用（绝大多数启动走这条，不会每次重启都造新串）；
 *   - 交付文件有内容但已吊销 / 库里查不到 → 造一串新的并重写文件（旧串已经无效，留着文件只会让人连不上）;
 *   - 交付文件不在 → 造一串新的并写进去。
 *
 * 「库里已有别的有效凭证、但交付文件被用户删了」也会造新串：交付文件是明文的唯一副本，
 * 删掉之后那串明文无从复原，再造一串是唯一能让本地客户端连上的做法。
 */
export async function createLocalCredential(
  db: Database,
  paths: HostPaths,
  options: LocalCredentialOptions = {},
): Promise<LocalCredentialResult> {
  const credentials = new CredentialRepository(db);
  const note = options.note ?? LOCAL_CREDENTIAL_NOTE;

  if (options.rotate !== true) {
    const existing = await readLocalToken(paths);
    if (existing !== null) {
      const verified = await verify(db, existing);
      if (verified !== null) {
        return { credentialId: verified.id, token: existing, created: false };
      }
    }
  }

  const token = randomBytes(options.tokenBytes ?? DEFAULT_TOKEN_BYTES).toString("base64url");
  const id = randomUUID();
  await credentials.create({
    id,
    note,
    hash: hashCredential(token),
    createdAt: (options.now ?? Date.now)(),
  });
  await writeLocalToken(paths, token);
  return { credentialId: id, token, created: true };
}
