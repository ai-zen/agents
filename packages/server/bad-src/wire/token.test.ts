/**
 * `wire/token.ts` 的用例 —— 凭证文件的**位置、权限、复用**。
 *
 * 三件事必须真在盘上验（假件证明不了）：
 *
 *   1. 路径是 `<aiZenDir>/run/token`（客户端会按同一个拼法去读它）；
 *   2. 权限是 `0600`（同一个用户之外的谁都不该读到这串东西）；
 *   3. 第二次 `ensureToken` **复用**同一个值 —— 每启动一次就换一串的话，一个已经连着的
 *      长连接客户端会在下一次重连时突然被拒，而用户什么都没改。
 */

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureToken, readToken, tokenPath } from "./token.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-server-token-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 同步读文件内容（只给「盘上到底是那一串吗」这类断言用：文件刚写完，没有竞态） */
function contentsOf(file: string): string {
  return readFileSync(file, "utf-8").trim();
}

describe("tokenPath", () => {
  it("落在 <aiZenDir>/run/token（与发现文件同一个目录）", () => {
    expect(tokenPath("/home/someone/.ai-zen")).toBe("/home/someone/.ai-zen/run/token");
  });
});

describe("readToken", () => {
  it("文件不存在 → null（「还没有凭证」是正常状态，不是异常）", async () => {
    expect(await readToken(dir)).toBeNull();
  });

  it("文件是空白的 → null（空串永远不该被当成一把钥匙）", async () => {
    mkdirSync(dirname(tokenPath(dir)), { recursive: true });
    writeFileSync(tokenPath(dir), "\n", "utf-8");
    expect(await readToken(dir)).toBeNull();
  });
});

describe("ensureToken", () => {
  it("首次生成：文件存在、权限 0600、内容非空且能 base64url 解回 32 字节", async () => {
    const token = await ensureToken(dir);

    const file = tokenPath(dir);
    expect(contentsOf(file)).toBe(token);
    // 0600：只有主可读写。凭证落在 `run/` 下，同一个用户之外的谁都不该读到
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // 32 字节随机 → base64url（43 字符）：长度与可解码性一起断言，别只数一个巧合的长度
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("第二次复用同一个值（不重新生成：凭证的生命周期比进程长）", async () => {
    const first = await ensureToken(dir);
    const second = await ensureToken(dir);

    expect(second).toBe(first);
    expect(contentsOf(tokenPath(dir))).toBe(first);
  });

  it("文件末尾多了一个换行也照旧可用（有人 echo 追加过一行）", async () => {
    const token = await ensureToken(dir);
    appendFileSync(tokenPath(dir), "\n", "utf-8");

    expect(await readToken(dir)).toBe(token);
  });

  it("两个不同的 aiZenDir 各一份，互不相干", async () => {
    const other = mkdtempSync(join(tmpdir(), "aiz-server-token-other-"));
    try {
      const first = await ensureToken(dir);
      const second = await ensureToken(other);
      expect(second).not.toBe(first);
      expect(await readToken(other)).toBe(second);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
