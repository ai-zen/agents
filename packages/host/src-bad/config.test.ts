import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  AI_ZEN_DIR_ENV,
  DEFAULT_PORT,
  LOOPBACK_HOST,
  PUBLIC_HOST,
  isPortOrAuto,
  isValidPort,
  readHostSettings,
  resolveDataRoot,
  resolveListenTarget,
  resolvePaths,
  resolvePort,
} from "./config.js";
import { HostError } from "./wire/index.js";

const ORIGINAL_ENV = process.env[AI_ZEN_DIR_ENV];

/** 临时数据根（每个用例一份，互不影响） */
const dirs: string[] = [];

async function makeDataRoot(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "ai-zen-config-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env[AI_ZEN_DIR_ENV];
  } else {
    process.env[AI_ZEN_DIR_ENV] = ORIGINAL_ENV;
  }
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("resolvePaths", () => {
  it("给定目录时产出全部路径，都在这一个数据根下", () => {
    const paths = resolvePaths("/srv/ai-zen-data");
    expect(paths).toEqual({
      dataRoot: "/srv/ai-zen-data",
      dbFile: "/srv/ai-zen-data/ai-zen.db",
      assetsDir: "/srv/ai-zen-data/assets",
      runDir: "/srv/ai-zen-data/run",
      hostFile: "/srv/ai-zen-data/run/host.json",
      tokenFile: "/srv/ai-zen-data/run/token",
      configFile: "/srv/ai-zen-data/config.json",
      hostConfigFile: "/srv/ai-zen-data/host.json",
      logsDir: "/srv/ai-zen-data/logs",
      hostLogsDir: "/srv/ai-zen-data/logs/host",
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

  it("两份配置文件不同：SDK 的 config.json 与宿主自己的 host.json（R13 / R67）", () => {
    const paths = resolvePaths("/srv/data");
    expect(paths.configFile).toBe("/srv/data/config.json");
    expect(paths.hostConfigFile).toBe("/srv/data/host.json");
    // 发现文件是第三份，位置在 run/ 下
    expect(paths.hostFile).toBe("/srv/data/run/host.json");
  });

  it("日志父目录在数据根下的 logs/，宿主那一格是 logs/host/（PRD F-J2 / 一格一个进程）", () => {
    const paths = resolvePaths("/srv/data");
    expect(paths.logsDir).toBe("/srv/data/logs");
    expect(paths.hostLogsDir).toBe("/srv/data/logs/host");
  });
});

describe("resolveListenTarget", () => {
  it("本地实例只监听回环（PLAN A6）", () => {
    expect(resolveListenTarget({ local: true })).toEqual({
      host: LOOPBACK_HOST,
      port: DEFAULT_PORT,
    });
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
  });

  it("对外实例监听 0.0.0.0", () => {
    expect(resolveListenTarget({ local: false })).toEqual({
      host: PUBLIC_HOST,
      port: DEFAULT_PORT,
    });
    expect(PUBLIC_HOST).toBe("0.0.0.0");
  });

  it("端口优先级：参数 > 配置文件 > 默认（PRD D25）", () => {
    expect(resolveListenTarget({ local: true, port: 9100, configPort: 9200 }).port).toBe(9100);
    expect(resolveListenTarget({ local: true, configPort: 9200 }).port).toBe(9200);
    expect(resolveListenTarget({ local: true }).port).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(8790);
  });

  it("参数里的 0 是合法的「让系统分配」（用例与冒烟都用它）", () => {
    expect(resolveListenTarget({ local: true, port: 0, configPort: 9200 }).port).toBe(0);
    expect(isPortOrAuto(0)).toBe(true);
    expect(isValidPort(0)).toBe(false);
  });

  it("显式给出但非法的端口报 config_invalid，不静默回落（裁定 R67）", () => {
    const bad = (input: Parameters<typeof resolveListenTarget>[0]): unknown => {
      try {
        resolveListenTarget(input);
      } catch (error) {
        return error;
      }
      throw new Error("本该抛错");
    };

    for (const port of [70000, 1.5, -1]) {
      const error = bad({ local: true, port, configPort: 9200 });
      expect(HostError.is(error) && error.code).toBe("config_invalid");
    }
    // 配置文件那一档没有「让系统分配」这回事：写 0 也是非法
    for (const configPort of [0, 70000, -3]) {
      const error = bad({ local: true, configPort });
      expect(HostError.is(error) && error.code).toBe("config_invalid");
    }
  });

  it("只有完全没给才回落默认端口", () => {
    expect(resolvePort(undefined, undefined)).toBe(DEFAULT_PORT);
    expect(resolvePort(9100, undefined)).toBe(9100);
    expect(resolvePort(undefined, 9200)).toBe(9200);
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

describe("<dataRoot>/host.json（D25 的「配置文件」那一档，裁定 R67）", () => {
  it("文件不在时这一档没说话（空设置，也不通知）", async () => {
    const dir = await makeDataRoot();
    const recovered: string[] = [];
    await expect(
      readHostSettings(resolvePaths(dir), (path) => void recovered.push(path)),
    ).resolves.toEqual({});
    expect(recovered).toEqual([]);
  });

  it("给了 port 就用它", async () => {
    const dir = await makeDataRoot();
    await fs.writeFile(join(dir, "host.json"), JSON.stringify({ port: 9123 }), "utf8");
    await expect(readHostSettings(resolvePaths(dir))).resolves.toEqual({ port: 9123 });
  });

  it("port 为 null / 没这个键都算「没说」", async () => {
    const dir = await makeDataRoot();
    await fs.writeFile(join(dir, "host.json"), JSON.stringify({ port: null }), "utf8");
    await expect(readHostSettings(resolvePaths(dir))).resolves.toEqual({});
    await fs.writeFile(join(dir, "host.json"), JSON.stringify({ other: 1 }), "utf8");
    await expect(readHostSettings(resolvePaths(dir))).resolves.toEqual({});
  });

  it("端口不合法报 config_invalid（含结构化 detail）", async () => {
    const dir = await makeDataRoot();
    await fs.writeFile(join(dir, "host.json"), JSON.stringify({ port: 70000 }), "utf8");
    await expect(readHostSettings(resolvePaths(dir))).rejects.toSatisfy(
      (error: unknown) =>
        HostError.is(error) &&
        error.code === "config_invalid" &&
        (error.detail as { field?: string }).field === "port",
    );

    await fs.writeFile(join(dir, "host.json"), JSON.stringify({ port: 0 }), "utf8");
    await expect(readHostSettings(resolvePaths(dir))).rejects.toSatisfy(
      (error: unknown) => HostError.is(error) && error.code === "config_invalid",
    );
  });

  it("文件坏了就恢复出厂：回 {}、坏的那份留档、磁盘写成合法的 {}、通知一次（D32）", async () => {
    const dir = await makeDataRoot();
    const paths = resolvePaths(dir);
    const recovered: string[] = [];
    const onRecovered = (path: string): void => {
      recovered.push(path);
    };

    // 解析不了的 JSON
    const firstBroken = "{ port: 9123";
    await fs.writeFile(paths.hostConfigFile, firstBroken, "utf8");
    await expect(readHostSettings(paths, onRecovered)).resolves.toEqual({});
    await expect(fs.readFile(paths.hostConfigFile, "utf8")).resolves.toBe("{}\n");
    // 残骸留档：用户手写的端口设置得能查回来
    await expect(fs.readFile(`${paths.hostConfigFile}.broken`, "utf8")).resolves.toBe(firstBroken);

    // 合法 JSON 但不是对象：同一档
    const secondBroken = JSON.stringify([9123]);
    await fs.writeFile(paths.hostConfigFile, secondBroken, "utf8");
    await expect(readHostSettings(paths, onRecovered)).resolves.toEqual({});
    await expect(fs.readFile(paths.hostConfigFile, "utf8")).resolves.toBe("{}\n");
    // 同名残骸已经在：上一份原封不动，这一份带时间戳另放
    await expect(fs.readFile(`${paths.hostConfigFile}.broken`, "utf8")).resolves.toBe(firstBroken);
    let stamped = (await fs.readdir(dir)).filter((f) => f.startsWith("host.json.broken."));
    expect(stamped).toHaveLength(1);
    await expect(fs.readFile(join(dir, stamped[0]!), "utf8")).resolves.toBe(secondBroken);

    const thirdBroken = "null";
    await fs.writeFile(paths.hostConfigFile, thirdBroken, "utf8");
    await expect(readHostSettings(paths, onRecovered)).resolves.toEqual({});
    await expect(fs.readFile(paths.hostConfigFile, "utf8")).resolves.toBe("{}\n");
    stamped = (await fs.readdir(dir)).filter((f) => f.startsWith("host.json.broken."));
    expect(stamped).toHaveLength(2);

    // 三次都是同一份文件，每坏一次通知一次
    expect(recovered).toEqual([paths.hostConfigFile, paths.hostConfigFile, paths.hostConfigFile]);
  });
});
