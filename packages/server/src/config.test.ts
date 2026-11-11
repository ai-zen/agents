import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AI_ZEN_DIR_ENV,
  DEFAULT_PORT,
  LOOPBACK_HOST,
  PUBLIC_HOST,
  isValidPort,
  resolveDataRoot,
  resolveListenTarget,
  resolvePaths,
} from "./config.js";

const ORIGINAL_ENV = process.env[AI_ZEN_DIR_ENV];

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env[AI_ZEN_DIR_ENV];
  } else {
    process.env[AI_ZEN_DIR_ENV] = ORIGINAL_ENV;
  }
});

describe("resolvePaths", () => {
  it("给定目录时产出五条路径，都在这一个数据根下", () => {
    const paths = resolvePaths("/srv/ai-zen-data");
    expect(paths).toEqual({
      dataRoot: "/srv/ai-zen-data",
      dbFile: "/srv/ai-zen-data/ai-zen.db",
      assetsDir: "/srv/ai-zen-data/assets",
      runDir: "/srv/ai-zen-data/run",
      serverFile: "/srv/ai-zen-data/run/server.json",
      tokenFile: "/srv/ai-zen-data/run/token",
    });
  });

  it("缺参时读 AI_ZEN_DIR", () => {
    process.env[AI_ZEN_DIR_ENV] = "/tmp/aizen-test-root";
    const paths = resolvePaths();
    expect(paths.dataRoot).toBe("/tmp/aizen-test-root");
    expect(paths.dbFile).toBe(join("/tmp/aizen-test-root", "ai-zen.db"));
  });

  it("显式参数优先于环境变量", () => {
    process.env[AI_ZEN_DIR_ENV] = "/tmp/from-env";
    expect(resolvePaths("/tmp/from-arg").dataRoot).toBe("/tmp/from-arg");
  });

  it("环境变量为空串按没给处理，回落到用户目录", () => {
    process.env[AI_ZEN_DIR_ENV] = "   ";
    expect(resolveDataRoot()).toBe(join(homedir(), ".ai-zen"));
    expect(resolvePaths("  ").dataRoot).toBe(join(homedir(), ".ai-zen"));
  });

  it("两者都没有时落在 ~/.ai-zen", () => {
    delete process.env[AI_ZEN_DIR_ENV];
    expect(resolvePaths().dataRoot).toBe(join(homedir(), ".ai-zen"));
  });

  it("不从工作目录推导：数据根落在用户目录或显式参数下", () => {
    delete process.env[AI_ZEN_DIR_ENV];
    const paths = resolvePaths();
    expect(paths.dataRoot).toBe(join(homedir(), ".ai-zen"));
    expect(paths.dbFile.startsWith(paths.dataRoot)).toBe(true);
    expect(paths.assetsDir.startsWith(paths.dataRoot)).toBe(true);
  });
});

describe("resolveListenTarget", () => {
  it("本地实例只监听回环（PRD A6）", () => {
    expect(resolveListenTarget({ local: true })).toEqual({ host: LOOPBACK_HOST, port: DEFAULT_PORT });
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
  });

  it("对外实例监听 0.0.0.0", () => {
    expect(resolveListenTarget({ local: false })).toEqual({ host: PUBLIC_HOST, port: DEFAULT_PORT });
    expect(PUBLIC_HOST).toBe("0.0.0.0");
  });

  it("端口优先级：参数 > 配置文件 > 默认（PRD D25）", () => {
    expect(resolveListenTarget({ local: true, port: 9100, configPort: 9200 }).port).toBe(9100);
    expect(resolveListenTarget({ local: true, configPort: 9200 }).port).toBe(9200);
    expect(resolveListenTarget({ local: true }).port).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(8790);
  });

  it("非法端口当作没给，落到下一级", () => {
    expect(resolveListenTarget({ local: true, port: 0, configPort: 9200 }).port).toBe(9200);
    expect(resolveListenTarget({ local: true, port: 70000, configPort: 9200 }).port).toBe(9200);
    expect(resolveListenTarget({ local: true, port: 1.5 }).port).toBe(DEFAULT_PORT);
    expect(resolveListenTarget({ local: false, port: 0, configPort: -1 }).port).toBe(DEFAULT_PORT);
  });

  it("isValidPort 只认 1..65535 的整数", () => {
    expect(isValidPort(8790)).toBe(true);
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(8080.5)).toBe(false);
    expect(isValidPort("8080")).toBe(false);
  });
});
