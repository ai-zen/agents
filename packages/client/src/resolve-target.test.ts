/**
 * 地址与凭证的同源解析 —— 三件要钉住的事：**显式地址只在给的时才成立**、**凭证的优先级与来源
 * 三态**、**`unauthorized` 被翻成哪一句话**。
 *
 * 第三件是本文件存在的主要理由：同一个 `unauthorized` 有**四**条完全不同的成因（本机重启能修 /
 * 要去那台服务端核对凭证 / 对面可能不是本机 daemon / 本机压根没有凭证），修法互不相干。措辞写错
 * 不会让任何东西变红 —— 只会让用户在一条 `token does not match this server` 前面猜半小时。
 *
 * 第二件是「对症」的前提：判据必须是 `source` 这个**三态**，不能是 `fromLocalFile` 那种布尔 ——
 * 布尔只有两格，而「显式凭证」与「根本没有凭证」是两句完全不同的话（两者都是 `false`）。本批的
 * bug（显式地址 + 本机无凭证 → 被建议「重启服务端」）就是那一压。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainUnauthorized, readExplicitTarget, resolveToken } from "./resolve-target.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-client-resolve-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 写一份凭证文件（服务端 `start()` 写的那个形状：纯文本、`run/` 下、叫 `token`） */
function writeLocalToken(token: string): void {
  mkdirSync(join(dir, "run"), { recursive: true });
  writeFileSync(join(dir, "run", "token"), token, "utf-8");
}

/** 造一个服务端回的 `unauthorized`（`SocketServerClient` 把 `error.data.code` 挂在 `.code` 上） */
function unauthorized(): Error & { code: string } {
  return Object.assign(new Error("unauthorized: token does not match this server"), {
    code: "unauthorized",
  });
}

describe("readExplicitTarget", () => {
  it("没有显式地址 → null（走发现文件那条路）", () => {
    expect(readExplicitTarget({ aiZenDir: dir })).toBeNull();
  });

  it("只有空白的显式地址 → 也是 null（`AI_ZEN_SERVER_URL=` 是「别用它」，不是一条非法地址）", () => {
    expect(readExplicitTarget({ aiZenDir: dir, serverUrl: "" })).toBeNull();
    expect(readExplicitTarget({ aiZenDir: dir, serverUrl: "   " })).toBeNull();
    expect(readExplicitTarget({ aiZenDir: dir, serverUrl: "\n\t" })).toBeNull();
  });

  it("合法地址 → { address, token }（token 是**显式**凭证，不读文件）", () => {
    writeLocalToken("from-file");
    expect(readExplicitTarget({ aiZenDir: dir, serverUrl: "https://example.com/ai-zen" })).toEqual({
      address: { host: "example.com", port: 443, path: "/ai-zen", secure: true },
      token: null,
    });
    expect(
      readExplicitTarget({
        aiZenDir: dir,
        serverUrl: "wss://example.com",
        serverToken: "from-env",
      }),
    ).toEqual({ address: { host: "example.com", port: 443, secure: true }, token: "from-env" });
  });

  it("显式凭证只有空白 → token 为 null（一格空格不是一串凭证）", () => {
    expect(
      readExplicitTarget({
        aiZenDir: dir,
        serverUrl: "ws://127.0.0.1:8790",
        serverToken: "  ",
      })?.token,
    ).toBeNull();
  });

  it("非法显式地址 → 抛错，信息里带原值（用户要认出自己填了什么）", () => {
    expect(() => readExplicitTarget({ aiZenDir: dir, serverUrl: "ftp://x" })).toThrow("ftp://x");
  });
});

describe("resolveToken", () => {
  it('显式凭证优先于文件 → source: "explicit"（环境变量就是用来盖掉本机那一份的）', async () => {
    writeLocalToken("from-file");
    expect(await resolveToken({ aiZenDir: dir, serverToken: "from-env" })).toEqual({
      token: "from-env",
      source: "explicit",
      fromLocalFile: false,
    });
  });

  it('没有显式凭证 → 读 <aiZenDir>/run/token，来源是 "local-file"', async () => {
    writeLocalToken("from-file\n");
    expect(await resolveToken({ aiZenDir: dir })).toEqual({
      token: "from-file",
      source: "local-file",
      fromLocalFile: true,
    });
  });

  it('文件不存在 → token 为 null，来源是 "none"（**不是** "explicit"：本机压根没有凭证）', async () => {
    expect(await resolveToken({ aiZenDir: dir })).toEqual({
      token: null,
      source: "none",
      fromLocalFile: false,
    });
  });

  it('文件在但内容是空的 → 同样 null，来源 "none"', async () => {
    writeLocalToken("   \n");
    expect(await resolveToken({ aiZenDir: dir })).toEqual({
      token: null,
      source: "none",
      fromLocalFile: false,
    });
  });

  it("三态互相不冒充：显式凭证 / 文件 / 都没有 —— 各自的 source 与 token 都对得上", async () => {
    // 这是本批的回归锁：用布尔表达时「显式凭证」与「没有凭证」都是 `false`，用户于是得到
    // 「重启服务端」那句指向错误方向的话
    const explicit = await resolveToken({ aiZenDir: dir, serverToken: "from-env" });
    const none = await resolveToken({ aiZenDir: dir });
    expect(explicit.source).toBe("explicit");
    expect(none.source).toBe("none");
    expect(explicit.fromLocalFile).toBe(none.fromLocalFile); // 布尔分不开这两个 —— 所以别用它

    writeLocalToken("from-file");
    const local = await resolveToken({ aiZenDir: dir });
    expect(local.source).toBe("local-file");
    expect(local.token).toBe("from-file");

    expect(new Set([explicit.source, local.source, none.source]).size).toBe(3);
    expect(none.token).toBeNull();
  });
});

describe("explainUnauthorized", () => {
  it("显式地址 + AI_ZEN_SERVER_TOKEN：让人**去那台服务端核对凭证**，而不是重启", () => {
    const explained = explainUnauthorized(unauthorized(), {
      explicit: true,
      source: "explicit",
      serverUrl: "wss://example.com",
    });

    expect(explained.message).toContain("核对");
    // 地址是第一信息：远程排障时「我在连谁」决定了下一条命令在哪台机器上敲
    expect(explained.message).toContain("wss://example.com");
    // 「重启服务端」在这条里是**错的方向**：那台机器根本没读过这串凭证
    expect(explained.message).not.toContain("重启服务端");
    expect(explained.message).not.toContain("SSH");
    // 码留着（上层还要靠它认出这是鉴权失败）
    expect((explained as Error & { code?: string }).code).toBe("unauthorized");
  });

  it("显式地址 + **没有**凭证：唯一该说的是「去设 AI_ZEN_SERVER_TOKEN」，绝不出现「重启服务端」", () => {
    const explained = explainUnauthorized(unauthorized(), {
      explicit: true,
      source: "none",
      serverUrl: "ws://127.0.0.1:9999",
    });

    expect(explained.message).toContain("AI_ZEN_SERVER_TOKEN");
    // 隧道那一半：两头不是同一台机器时，本机的任何东西都救不了这次握手
    expect(explained.message).toContain("SSH");
    expect(explained.message).not.toContain("重启服务端");
    // 这一支没有凭证可核对，只有「设一个」这一件事
    expect(explained.message).not.toContain("核对");
  });

  it("显式地址 + 本地文件那串（D9）：点明可能是隧道，让用户设 AI_ZEN_SERVER_TOKEN，同样不提重启", () => {
    const explained = explainUnauthorized(unauthorized(), {
      explicit: true,
      source: "local-file",
      serverUrl: "ws://127.0.0.1:9999",
    });

    expect(explained.message).toContain("AI_ZEN_SERVER_TOKEN");
    expect(explained.message).toContain("隧道");
    expect(explained.message).toContain("ws://127.0.0.1:9999");
    expect(explained.message).not.toContain("重启服务端");
  });

  it("非显式地址（本机发现文件那条路）：点明「重启服务端即可重新对齐」", () => {
    const explained = explainUnauthorized(unauthorized(), {
      explicit: false,
      source: "local-file",
    });

    expect(explained.message).toContain("重启服务端");
    // 本机这条路不提环境变量：凭证与服务端都在这一台机器上，重启就会重新对齐
    expect(explained.message).not.toContain("AI_ZEN_SERVER_TOKEN");
    expect(explained.message).not.toContain("核对");
    expect(explained.message).not.toContain("SSH");
  });

  it("不是 unauthorized 的错误：**原对象**原样返回（`toBe`，连引用都不换）", () => {
    const refused = new Error("connect ECONNREFUSED 127.0.0.1:8790");
    expect(explainUnauthorized(refused, { explicit: true, source: "local-file" })).toBe(refused);
    expect(explainUnauthorized(refused, { explicit: true, source: "none" })).toBe(refused);

    const coded = Object.assign(new Error("a turn is already running"), { code: "turn-busy" });
    expect(explainUnauthorized(coded, { explicit: false, source: "local-file" })).toBe(coded);
  });

  it("给了 aiZenDir → 三句提示都印**真路径**，且不出现 `<aiZenDir>` 占位符", () => {
    // 路径由 `wire/token.ts` 的 `tokenPath` 算出来（`<aiZenDir>/run/token` 的形状）；这里用
    // 一个一眼能认出来的目录，好让「印的是不是那一份」在断言里写得直白
    const aiZenDir = "/tmp/aiz-real";
    const tokenAt = "/tmp/aiz-real/run/token";

    // 显式凭证那一支：真路径也在（用来点明「本机这份与这次无关」）
    const explicit = explainUnauthorized(unauthorized(), {
      explicit: true,
      source: "explicit",
      serverUrl: "wss://example.com",
      aiZenDir,
    });
    expect(explicit.message).toContain(tokenAt);
    expect(explicit.message).not.toContain("<aiZenDir>");

    // 显式地址 + 没有凭证：**地址与真路径都要在**（用户得知道去哪台机器上抄哪一份文件）
    const missing = explainUnauthorized(unauthorized(), {
      explicit: true,
      source: "none",
      serverUrl: "ws://127.0.0.1:9999",
      aiZenDir,
    });
    expect(missing.message).toContain(tokenAt);
    expect(missing.message).toContain("ws://127.0.0.1:9999");
    // 占位符出现在这里等于把最后一步推回给用户：他还得自己猜 AI_ZEN_DIR 解析成了什么
    expect(missing.message).not.toContain("<aiZenDir>");

    // 本机那条路（「重启服务端即可重新对齐」）—— 真路径同样要在
    const realign = explainUnauthorized(unauthorized(), {
      explicit: false,
      source: "local-file",
      aiZenDir,
    });
    expect(realign.message).toContain(tokenAt);
    expect(realign.message).not.toContain("<aiZenDir>");
  });

  it("没给 aiZenDir → 退回 `<aiZenDir>/run/token` 占位符（拿不到上下文时至少形状是对的）", () => {
    const tunnel = explainUnauthorized(unauthorized(), {
      explicit: true,
      source: "local-file",
      serverUrl: "ws://127.0.0.1:9999",
    });
    expect(tunnel.message).toContain("<aiZenDir>/run/token");

    const missing = explainUnauthorized(unauthorized(), {
      explicit: true,
      source: "none",
      serverUrl: "ws://127.0.0.1:9999",
    });
    expect(missing.message).toContain("<aiZenDir>/run/token");

    const realign = explainUnauthorized(unauthorized(), { explicit: false, source: "local-file" });
    expect(realign.message).toContain("<aiZenDir>/run/token");
  });

  it("不是 unauthorized 的错误：给了 aiZenDir 也照样原对象返回（印路径不影响这条路）", () => {
    const refused = new Error("connect ECONNREFUSED 127.0.0.1:8790");
    expect(
      explainUnauthorized(refused, {
        explicit: true,
        source: "local-file",
        aiZenDir: "/tmp/aiz-real",
      }),
    ).toBe(refused);
  });
});
