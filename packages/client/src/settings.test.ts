/**
 * 连接设置的验收：读得回来、坏文件不炸、`local` 不吐空串、凭证不进文案。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  describeSettings,
  parseSettings,
  readSettings,
  redactToken,
  settingsLabel,
  settingsPath,
  settingsToTarget,
  writeSettings,
} from "./settings.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "ai-zen-client-settings-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("落点", () => {
  it("每个客户端各占一个子目录", () => {
    expect(settingsPath("/data", "cli")).toBe(join("/data", "cli", "connection.json"));
    expect(settingsPath("/data", "desktop")).toBe(join("/data", "desktop", "connection.json"));
  });
});

describe("读写", () => {
  it("写下去能读回来（地址、凭证、语言都留住）", async () => {
    const file = settingsPath(dir, "cli");
    await writeSettings(file, {
      mode: "remote",
      url: "https://example.test/ai-zen",
      token: "secret-token",
      language: "zh",
    });

    expect(await readSettings(file)).toEqual({
      mode: "remote",
      url: "https://example.test/ai-zen",
      token: "secret-token",
      language: "zh",
    });
  });

  it("文件里有凭证，所以权限是 0600", async () => {
    const file = settingsPath(dir, "cli");
    await writeSettings(file, { mode: "local" });
    const stat = await fs.stat(file);
    // Windows 上 mode 不反映 ACL，那里跳过这条判据
    if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
  });

  it("没配过 / 坏 JSON / 字段不对都是 null（不抛）", async () => {
    const file = settingsPath(dir, "cli");
    expect(await readSettings(file)).toBeNull();

    await fs.mkdir(join(dir, "cli"), { recursive: true });
    await fs.writeFile(file, "{ 写到一半", "utf8");
    expect(await readSettings(file)).toBeNull();

    await fs.writeFile(file, JSON.stringify({ mode: "remote" }), "utf8");
    expect(await readSettings(file)).toBeNull();

    await fs.writeFile(file, JSON.stringify({ mode: "remote", url: "没写 scheme 的乱码" }), "utf8");
    expect(await readSettings(file)).toBeNull();
  });

  it("local 模式残留的远端地址照读、但不会被当成地址用", async () => {
    const file = settingsPath(dir, "cli");
    await fs.mkdir(join(dir, "cli"), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ mode: "local", url: "wss://old.example/ai-zen", token: "old" }),
      "utf8",
    );

    const settings = await readSettings(file);
    expect(settings?.mode).toBe("local");
    // 「没有给」的三种写法在这里归一成 undefined，而不是空串
    expect(settingsToTarget(settings!)).toEqual({
      url: undefined,
      token: undefined,
      language: undefined,
    });
  });
});

describe("保存路径的校验", () => {
  it("remote 必须有能解析的地址", () => {
    expect(() => parseSettings({ mode: "remote" })).toThrow(/没填服务端地址/);
    expect(() => parseSettings({ mode: "remote", url: "ftp://example.test" })).toThrow();
    expect(parseSettings({ mode: "remote", url: "10.0.0.5:8790" })).toEqual({
      mode: "remote",
      url: "10.0.0.5:8790",
    });
  });

  it("mode 只能是那两个", () => {
    expect(() => parseSettings({ mode: "cloud" })).toThrow(/local 或 remote/);
    expect(() => parseSettings("不是对象")).toThrow();
  });

  it("空串折成 undefined（不是「显式给了空值」）", () => {
    expect(parseSettings({ mode: "remote", url: "ws://h:1", token: "  ", language: "" })).toEqual({
      mode: "remote",
      url: "ws://h:1",
    });
  });
});

describe("给人看的那几行", () => {
  it("标签不带凭证", () => {
    expect(settingsLabel({ mode: "local" })).toBe("本机服务端");
    expect(settingsLabel({ mode: "remote", url: "wss://token-in-url@example.test/ai-zen" })).toBe(
      "wss://example.test/ai-zen",
    );
  });

  it("日志里也不带凭证", () => {
    expect(describeSettings({ mode: "local" })).toContain("本地");
    expect(
      describeSettings({ mode: "remote", url: "wss://tok@example.test/x", token: "tok" }),
    ).toBe("远程 wss://example.test/x");
  });

  it("报错文本上屏之前把凭证抹掉", () => {
    const settings = { mode: "remote" as const, url: "ws://h:1", token: "abc123" };
    expect(redactToken("握手失败：abc123 无效", settings)).toBe("握手失败：*** 无效");
    expect(redactToken("没有凭证", { mode: "local" })).toBe("没有凭证");
  });
});
