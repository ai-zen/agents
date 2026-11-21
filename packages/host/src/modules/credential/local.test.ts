/**
 * 一条验收：交付文件不存在时造一串、写进文件、库里留一行 `note` 为 `local` 的记录；文件在且库里
 * 还认这一串时，库和文件都不动；那一串吊销之后，同一条规则让文件换成新的一串，旧串再也验不过。
 * 第三条不需要单独实现的依据就在这里 —— 它和「文件不在」走的是同一支。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../infra/db.js";

import { createTranslator } from "../i18n/index.js";
import { ensureLocalToken } from "./local.js";
import { CredentialService } from "./service.js";
import { credentialTable } from "./table.js";

describe("本地凭证交付文件", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("首次造一串写进文件；还认这一串就原样不动；吊销之后文件换成新的一串", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-zen-local-token-"));
    roots.push(root);
    const file = join(root, "run", "token");
    const credentials = new CredentialService({
      credentials: credentialTable(openDatabase(":memory:")),
      t: createTranslator(() => "zh"),
    });

    // 目录 `run/` 还不存在，交付文件的写入要自己把它建出来
    ensureLocalToken(credentials, file);

    const first = readFileSync(file, "utf8");
    expect(first.endsWith("\n")).toBe(true);
    expect(credentials.verify(first.trim())).toBeDefined();
    expect(credentials.list()).toHaveLength(1);
    expect(credentials.list()[0].note).toBe("local");

    ensureLocalToken(credentials, file);

    expect(credentials.list()).toHaveLength(1);
    expect(readFileSync(file)).toEqual(Buffer.from(first));

    const [held] = credentials.list();
    credentials.revoke(held.id);

    ensureLocalToken(credentials, file);

    const replaced = readFileSync(file, "utf8");
    expect(replaced).not.toBe(first);
    expect(credentials.verify(replaced.trim())).toBeDefined();
    expect(credentials.verify(first.trim())).toBeUndefined();
  });
});
