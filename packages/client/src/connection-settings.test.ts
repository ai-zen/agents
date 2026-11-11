/**
 * 连接配置用例：位置、权限、roundtrip、「读不炸」、以及「`local` 不把残留的 serverUrl 传给连接」。
 *
 * ## 为什么这几件事必须真在盘上验
 *
 *   · **位置**（`<aiZenDir>/<client>/connection.json`）与**权限**（`0600`）都是约定：人要在排障
 *     时按同一个拼法去 `cat` 它，而「同一个用户之外的谁都不该读到」这件事只有 `stat` 能证；
 *   · **读不炸**是契约的一半：坏 JSON / 非法 `mode` / 远程却没地址，一律 `null`。一个手滑的
 *     文件不该让应用起不来；
 *   · **`null` 不等于「本地」**：这条是本模块存在的理由之一。用 `{ mode: "local" }` 兜底会把
 *     「没配过」压成「用户选过本地」，于是首启会被当成「直接拉起本机服务端」——引导屏那条
 *     路就永远走不到；
 *   · **`local` 传 `undefined` 而不是空串**：在客户端那边这是两种行为（空串 = 显式给了一个空
 *     值，于是不走发现文件、也不退回本机 `run/token`），所以只能在映射函数上看 —— 文件里残留
 *     着 `serverUrl` 时尤其如此；
 *   · **本地保存 = 从盘上清掉远端地址与凭证**：落盘是整份替换、不是合并，而界面在 `local`
 *     下只发 `{ mode: "local" }` —— 于是那两个字段连带键一起消失。这是有意定的策略（不用的
 *     时候不把钥匙留在盘上），下面那组用例就是为了防止将来被「顺手改回成保留」的。
 */

import {
  existsSync,
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
import {
  connectionLabel,
  connectionSettingsPath,
  connectionSettingsToTarget,
  describeConnection,
  parseConnectionSettings,
  readConnectionSettings,
  redactCredential,
  writeConnectionSettings,
  type ConnectionSettings,
} from "./connection-settings.js";

/** 用户会填的那种地址（带子路径的 `wss://`：`parseServerUrl` 认得的四种之一） */
const REMOTE_URL = "wss://ai-zen.example.com/ai-zen";
/** 一眼能认出来的凭证：用它断言「落盘之后读回来还是它」 */
const TOKEN = "dGhpcy1pcy1hLXRva2VuLWluLWNvbm5lY3Rpb24tanNvbg";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-connection-settings-"));
  file = connectionSettingsPath(dir, "desktop");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 直接往盘上写一份「用户手改过的」配置（绕过写函数，用来造坏数据） */
function seed(raw: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, raw, "utf-8");
}

describe("配置文件的位置", () => {
  it("两个客户端各存各的：<aiZenDir>/desktop 与 <aiZenDir>/cli", () => {
    // 手拼一份期望值（而不是拿被测函数算）：拼法一变，这条就该红
    expect(connectionSettingsPath("/home/someone/.ai-zen", "desktop")).toBe(
      "/home/someone/.ai-zen/desktop/connection.json",
    );
    expect(connectionSettingsPath("/home/someone/.ai-zen", "cli")).toBe(
      "/home/someone/.ai-zen/cli/connection.json",
    );
  });
});

describe("读配置：没有可用配置就是 null（不是「默认本地」）", () => {
  it("文件不存在 → null，且不抛错", async () => {
    // 第一次启动之前就是这个状态：读不到配置不该让应用起不来，但**也不能假装用户选了本地**
    expect(await readConnectionSettings(file)).toBeNull();
  });

  it("坏 JSON → null（手改坏了 / 写到一半被 kill）", async () => {
    seed('{"mode": "remote", "serverUrl": ');
    expect(await readConnectionSettings(file)).toBeNull();
  });

  it("mode 是非法值 → null（不给「猜一个最像的」的机会）", async () => {
    seed(JSON.stringify({ mode: "cloud", serverUrl: REMOTE_URL }));
    expect(await readConnectionSettings(file)).toBeNull();
  });

  it("remote 但地址是垃圾 → null（与坏 JSON 同一类事实：这份配置不可用）", async () => {
    seed(JSON.stringify({ mode: "remote", serverUrl: "这不是地址" }));
    expect(await readConnectionSettings(file)).toBeNull();
  });

  it("remote 但没地址 → null（远程模式没有地址就没有含义）", async () => {
    seed(JSON.stringify({ mode: "remote", serverToken: TOKEN }));
    expect(await readConnectionSettings(file)).toBeNull();
  });

  it("读到的是那一份（含远程地址与凭证）", async () => {
    seed(JSON.stringify({ mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN }));
    expect(await readConnectionSettings(file)).toEqual({
      mode: "remote",
      serverUrl: REMOTE_URL,
      serverToken: TOKEN,
    });
  });
});

describe("写配置", () => {
  it("roundtrip：写下去的那一份能原样读回来（含远程地址与凭证）", async () => {
    const settings: ConnectionSettings = {
      mode: "remote",
      serverUrl: REMOTE_URL,
      serverToken: TOKEN,
    };

    await writeConnectionSettings(file, settings);

    expect(await readConnectionSettings(file)).toEqual(settings);
    // 盘上真的是它（不是只活在内存里的幻觉）
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual(settings);
  });

  it("权限 0600（文件里有凭证）", async () => {
    await writeConnectionSettings(file, {
      mode: "remote",
      serverUrl: REMOTE_URL,
      serverToken: TOKEN,
    });

    // 只有主可读写：顺手 `cat` 一下的代价是零，把它贴出去的代价不该由「记得别贴」来兜
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("原子写：`.tmp` 不留残骸（先写 .tmp 再 rename）", async () => {
    await writeConnectionSettings(file, {
      mode: "remote",
      serverUrl: REMOTE_URL,
      serverToken: TOKEN,
    });

    // 残留的 .tmp 说明「写完没 rename」或「崩在 rename 之前」，而它和真文件只差一个后缀
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("父目录不存在时自己建（首次保存）", async () => {
    const deep = join(dir, "a", "b", "connection.json");
    await writeConnectionSettings(deep, { mode: "local" });
    expect(await readConnectionSettings(deep)).toEqual({ mode: "local" });
  });
});

describe("本地保存 = 从盘上清掉远端地址与凭证（策略：不许顺手改回「保留」）", () => {
  it("接着 local 保存（入参只有 { mode: 'local' }）→ 盘上只剩 mode，两个键都不在了", async () => {
    // 界面切到本地并点「保存」时发的就是这一份
    await writeConnectionSettings(file, {
      mode: "remote",
      serverUrl: REMOTE_URL,
      serverToken: TOKEN,
    });
    await writeConnectionSettings(file, parseConnectionSettings({ mode: "local" }));

    const settings = await readConnectionSettings(file);
    expect(settings).toEqual({ mode: "local" });
    expect(settings?.serverUrl).toBeUndefined();
    expect(settings?.serverToken).toBeUndefined();

    // 关键断言：盘上**连键都没有**（用 `in` 判，不看值 —— JSON 里出现 null / "" 也算没清干净）
    const stored = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    expect("serverUrl" in stored).toBe(false);
    expect("serverToken" in stored).toBe(false);
  });

  it("本模块自己**不主动抹**：入参里带了就照存（清掉是因为界面不传）", () => {
    // 这条画的是「谁负责清」的边界：本文件只照存，界面不传才是清掉的原因。
    // 别把它读成「保留是承诺」。
    expect(
      parseConnectionSettings({ mode: "local", serverUrl: REMOTE_URL, serverToken: TOKEN }),
    ).toEqual({ mode: "local", serverUrl: REMOTE_URL, serverToken: TOKEN });
  });
});

describe("local 模式：那两个值必须是 undefined（不是空串）", () => {
  it("映射出来就是 undefined（local 不看自己残留的那两个字段）", async () => {
    // 盘上一份「local 却残留着远端地址与凭证」的配置（手改出来的，或早先版本留下的）：
    // 读路径不因为它拒掉整份配置，但那两个值不会被传给连接
    seed(JSON.stringify({ mode: "local", serverUrl: REMOTE_URL, serverToken: TOKEN }));

    expect(connectionSettingsToTarget((await readConnectionSettings(file))!)).toEqual({
      serverUrl: undefined,
      serverToken: undefined,
    });
  });

  it("remote 时原样传（空凭证折成 undefined，好让连接层退回 run/token）", () => {
    expect(
      connectionSettingsToTarget({ mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN }),
    ).toEqual({ serverUrl: REMOTE_URL, serverToken: TOKEN });
    expect(connectionSettingsToTarget({ mode: "remote", serverUrl: REMOTE_URL })).toEqual({
      serverUrl: REMOTE_URL,
      serverToken: undefined,
    });
  });
});

describe("保存路径的校验（parseConnectionSettings）", () => {
  it("mode 非法 → 抛人话", () => {
    expect(() => parseConnectionSettings({ mode: "cloud" })).toThrow(/mode 只能是 local 或 remote/);
  });

  it("remote 但没地址 → 抛人话", () => {
    expect(() => parseConnectionSettings({ mode: "remote" })).toThrow(/没填服务端地址/);
  });

  it("地址非法 → 抛包里那一句（带原串，不自己另写一份校验）", () => {
    expect(() => parseConnectionSettings({ mode: "remote", serverUrl: "这不是地址" })).toThrow(
      /不是合法的服务端地址/,
    );
  });

  it("serverToken 留空是**合法**的（= 用本机 run/token）", () => {
    expect(
      parseConnectionSettings({ mode: "remote", serverUrl: REMOTE_URL, serverToken: "  " }),
    ).toEqual({ mode: "remote", serverUrl: REMOTE_URL });
  });

  it("首尾空白被去掉（用户从别处粘过来，末尾带一个换行是常事）", () => {
    expect(
      parseConnectionSettings({
        mode: "remote",
        serverUrl: ` ${REMOTE_URL}\n`,
        serverToken: ` ${TOKEN} `,
      }),
    ).toEqual({ mode: "remote", serverUrl: REMOTE_URL, serverToken: TOKEN });
  });
});

describe("界面上那一行字 / 日志里那一句（不许带凭证）", () => {
  it("label：本地是固定词，远程是地址", () => {
    expect(connectionLabel({ mode: "local" })).toBe("本机服务端");
    expect(connectionLabel({ mode: "remote", serverUrl: REMOTE_URL })).toBe(REMOTE_URL);
  });

  it("label 抹掉地址里的 userinfo（有人真会把钥匙写进 URL）", () => {
    expect(
      connectionLabel({ mode: "remote", serverUrl: "wss://sekrit@host.example.com/ai-zen" }),
    ).toBe("wss://host.example.com/ai-zen");
  });

  it("describe：只说模式与地址，凭证一个字都不许有", () => {
    expect(describeConnection({ mode: "local" })).toBe("本地（发现文件 + 本机凭证）");
    const line = describeConnection({
      mode: "remote",
      serverUrl: REMOTE_URL,
      serverToken: TOKEN,
    });
    expect(line).toContain(REMOTE_URL);
    expect(line).not.toContain(TOKEN);
  });

  it("redactCredential：万一错误信息里带上了凭证，上屏之前先抹掉", () => {
    const settings: ConnectionSettings = {
      mode: "remote",
      serverUrl: REMOTE_URL,
      serverToken: TOKEN,
    };
    expect(redactCredential(`握手失败（token=${TOKEN}）`, settings)).toBe("握手失败（token=***）");
    // 没有凭证（本地模式 / 没填）时原样返回
    expect(redactCredential("连不上", { mode: "local" })).toBe("连不上");
  });
});
