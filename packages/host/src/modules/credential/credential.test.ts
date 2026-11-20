/**
 * 一条验收：同一串令牌永远落到同一把凭证、吊销之后再也验不到、`list` 出去的形状里没有 `hash`。
 * 前两条一起证明库里存的是摘要而不是明文；第三条是一条不会报错的泄漏 —— 它只会安静地把
 * 令牌的指纹交给客户端。
 */

import { describe, expect, it } from "vitest";

import { openDatabase } from "../../infra/db.js";

import { createTranslator } from "../i18n/index.js";
import { CredentialService } from "./service.js";
import { credentialTable } from "./table.js";

function newService(): CredentialService {
  return new CredentialService({
    credentials: credentialTable(openDatabase(":memory:")),
    t: createTranslator(() => "zh"),
  });
}

describe("凭证", () => {
  it("同一个 token 验到同一条；吊销之后验不到；list 不带 hash", () => {
    const service = newService();
    const { credential, token } = service.create("命令行");

    expect(service.verify(token)).toEqual(credential);
    expect(service.verify(`${token}-不是同一把`)).toBeUndefined();

    const revoked = service.revoke(credential.id);
    expect(revoked.revokedAt).toEqual(expect.any(Number));
    expect(service.verify(token)).toBeUndefined();

    const [row] = service.list();
    expect(row).toEqual({
      id: credential.id,
      note: "命令行",
      createdAt: credential.createdAt,
      revokedAt: revoked.revokedAt,
    });
    expect(row).not.toHaveProperty("hash");
  });
});
