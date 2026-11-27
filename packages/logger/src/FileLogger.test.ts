/**
 * 一份日志文件的行为：行格式、按大小轮转、排队的写盘、收尾、来源标签，
 * 以及两个订阅口（`onRecord` / `onWriteError`）。
 *
 * 用例只碰临时目录，不等真时间：轮转靠把 `maxBytes` 调小，时间靠注入的时钟。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, FileLogger, formatLine } from "./FileLogger.js";
import type { LogRecord } from "./FileLogger.js";

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "ai-zen-logger-"));
  dirs.push(dir);
  return dir;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("写盘", () => {
  it("写进给定的文件，行里带时间 / 级别 / 来源", async () => {
    const dir = await makeDir();
    const file = join(dir, "host.log");
    const logger = new FileLogger({ file, now: () => Date.UTC(2026, 0, 2, 3, 4, 5) });

    logger.info("宿主开始监听", { port: 8790 });
    logger.warn("上传收尾失败", { uploadId: "u-1" });
    await logger.close();

    expect(logger.filePath).toBe(file);
    const text = (await readIfExists(file)) ?? "";
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('2026-01-02T03:04:05.000Z INFO  app 宿主开始监听 {"port":8790}');
    expect(lines[1]).toContain("WARN ");
    expect(lines[1]).toContain("上传收尾失败");
  });

  it("目录不存在就建（包括多层）", async () => {
    const dir = await makeDir();
    const file = join(dir, "logs", "host", "host.log");
    const logger = new FileLogger({ file });
    logger.info("第一行");
    await logger.close();
    expect(await readIfExists(file)).toContain("第一行");
  });

  it("缺省是 5MB × 5 份", () => {
    expect(DEFAULT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(DEFAULT_MAX_FILES).toBe(5);
  });

  it("行格式是纯函数：级别定宽、detail 压成一行 JSON、序列化不了给占位符", () => {
    const line = formatLine("2026-01-02T00:00:00.000Z", "warn", "ws", "连接出错", {
      connectionId: "c-1",
    });
    expect(line).toBe('2026-01-02T00:00:00.000Z WARN  ws 连接出错 {"connectionId":"c-1"}\n');
    // 循环引用也留一行（内容换成占位符），不让整条记录丢掉
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatLine("1970-01-01T00:00:00.000Z", "error", "app", "怪东西", cyclic)).toContain(
      "[unserializable]",
    );
  });
});

describe("轮转", () => {
  it("攒满一份就轮转：新行进正在写的那份，旧内容进 .1", async () => {
    const dir = await makeDir();
    const file = join(dir, "host.log");
    const at = Date.UTC(2026, 0, 2, 0, 0, 0);
    // 先量一下一行有多少字节，再把上限设成「正好装三行」——这样只会轮转一次，结论可断言
    const lineBytes = Buffer.byteLength(
      formatLine(new Date(at).toISOString(), "info", "app", "第1行"),
    );
    const logger = new FileLogger({ file, now: () => at, maxBytes: lineBytes * 3 + 1 });

    for (let index = 1; index <= 6; index += 1) logger.info(`第${index}行`);
    await logger.close();

    const current = (await readIfExists(file)) ?? "";
    const previous = (await readIfExists(`${file}.1`)) ?? "";
    expect(previous.trimEnd().split("\n")).toHaveLength(3);
    expect(previous).toContain("第1行");
    expect(previous).not.toContain("第4行");
    expect(current).toContain("第4行");
    expect(current).toContain("第6行");
    expect(current).not.toContain("第1行");
  });

  it("保留份数有上限：最老的一份在轮转时被删掉", async () => {
    const dir = await makeDir();
    const file = join(dir, "host.log");
    const logger = new FileLogger({ file, maxBytes: 120, maxFiles: 2 });
    for (let index = 1; index <= 12; index += 1) logger.info(`行 ${index} ${"y".repeat(30)}`);
    await logger.close();

    expect(await readIfExists(file)).not.toBeNull();
    expect(await readIfExists(`${file}.1`)).not.toBeNull();
    // maxFiles: 2 = 正在写的那份 + 一份旧的，没有 .2
    expect(await readIfExists(`${file}.2`)).toBeNull();
  });
});

describe("收尾", () => {
  it("close 先拍平队列：写一行后立刻 close，读回来就在", async () => {
    const dir = await makeDir();
    const file = join(dir, "host.log");
    const logger = new FileLogger({ file });
    for (let index = 1; index <= 20; index += 1) logger.info(`第${index}行`);
    await logger.close();

    const text = (await readIfExists(file)) ?? "";
    expect(text.trimEnd().split("\n")).toHaveLength(20);
    expect(text).toContain("第20行");
  });

  it("close 幂等（叫两次不报错、也不重复关流）", async () => {
    const dir = await makeDir();
    const file = join(dir, "host.log");
    const logger = new FileLogger({ file });
    logger.info("第一行");
    await logger.close();
    await expect(logger.close()).resolves.toBeUndefined();
    expect((await readIfExists(file)) ?? "").toContain("第一行");
  });

  it("收尾之后不再落盘（关流就是关流）", async () => {
    const dir = await makeDir();
    const file = join(dir, "host.log");
    const logger = new FileLogger({ file });
    logger.info("第一行");
    await logger.close();
    logger.info("第二行");
    await logger.close();

    const text = (await readIfExists(file)) ?? "";
    expect(text).toContain("第一行");
    expect(text).not.toContain("第二行");
  });

  it("一行都没写过时 close 是 no-op：不留空文件", async () => {
    const dir = await makeDir();
    const file = join(dir, "nested", "host.log");
    const logger = new FileLogger({ file });
    await logger.close();

    expect(await readIfExists(file)).toBeNull();
    // 连目录都不该建：目录是「真要写」的那一刻才建的
    expect(await readIfExists(join(dir, "nested"))).toBeNull();
  });
});

describe("来源标签", () => {
  it("withSource 换的是行里的那一格，落在同一个文件里", async () => {
    const dir = await makeDir();
    const file = join(dir, "host.log");
    const logger = new FileLogger({ file, source: "host" });
    logger.info("单根的事");
    logger.withSource("ws").warn("接线层的事");
    await logger.close();

    const text = (await readIfExists(file)) ?? "";
    expect(text).toContain("INFO  host 单根的事");
    expect(text).toContain("WARN  ws 接线层的事");
    expect(await fs.readdir(dir)).toEqual(["host.log"]);
  });

  it("withSource 出来的视图与主实例共用同一个流（两边的行攒在同一份里）", async () => {
    const dir = await makeDir();
    const file = join(dir, "host.log");
    const at = Date.UTC(2026, 0, 2, 0, 0, 0);
    const iso = new Date(at).toISOString();
    // 上限正好装两行：主实例一行 + 视图一行。第三行才该轮转 ——
    // 两边若各开一份流 / 各记一份字节数，第三行不会轮转，这条就红。
    const maxBytes =
      Buffer.byteLength(formatLine(iso, "info", "host", "主实例第一行")) +
      Buffer.byteLength(formatLine(iso, "info", "ws", "视图第二行"));
    const logger = new FileLogger({ file, now: () => at, maxBytes });
    const view = logger.withSource("ws");

    logger.info("主实例第一行");
    view.info("视图第二行");
    logger.info("第三行");
    await logger.close();

    const previous = (await readIfExists(`${file}.1`)) ?? "";
    expect(previous.trimEnd().split("\n")).toHaveLength(2);
    expect(previous).toContain("主实例第一行");
    expect(previous).toContain("视图第二行");
    expect((await readIfExists(file)) ?? "").toContain("第三行");
  });
});

describe("两个订阅口", () => {
  it("onRecord 的载荷：级别 / 来源 / 消息 / detail / ISO 时间", async () => {
    const dir = await makeDir();
    const records: LogRecord[] = [];
    const logger = new FileLogger({
      file: join(dir, "host.log"),
      source: "host",
      now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
      onRecord: (record) => records.push(record),
    });

    logger.info("单根的事");
    logger.withSource("ws").error("连接断了", { connectionId: "c-1" });
    await logger.close();

    expect(records).toEqual([
      {
        level: "info",
        source: "host",
        message: "单根的事",
        detail: undefined,
        at: "2026-01-02T03:04:05.000Z",
      },
      {
        level: "error",
        source: "ws",
        message: "连接断了",
        detail: { connectionId: "c-1" },
        at: "2026-01-02T03:04:05.000Z",
      },
    ]);
  });

  it("onRecord 抛错不影响写盘，也不抛回调用方（交给 onWriteError 报一次）", async () => {
    const dir = await makeDir();
    const file = join(dir, "host.log");
    const errors: unknown[] = [];
    const logger = new FileLogger({
      file,
      onRecord: () => {
        throw new Error("订阅者坏了");
      },
      onWriteError: (error) => errors.push(error),
    });

    expect(() => logger.error("出事了")).not.toThrow();
    await logger.close();

    expect((await readIfExists(file)) ?? "").toContain("出事了");
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("订阅者坏了");
  });

  it("打开失败走 onWriteError（不许静默吞）", async () => {
    const dir = await makeDir();
    // 让「日志目录」指向一个普通文件：建目录这一步必然失败
    const blocker = join(dir, "blocker");
    await fs.writeFile(blocker, "not a directory");
    const errors: unknown[] = [];
    const logger = new FileLogger({
      file: join(blocker, "host.log"),
      onWriteError: (error) => errors.push(error),
    });

    logger.error("写不进去的那一行");
    await logger.close();

    expect(errors).toHaveLength(1);
    // 具体是 EEXIST 还是 ENOTDIR 看平台：要钉的是「开不了流这件事被报出来了」
    expect((errors[0] as NodeJS.ErrnoException).code).toMatch(/^E(EXIST|NOTDIR)$/);
  });

  it("onWriteError 自己抛错也不影响主流程", async () => {
    const dir = await makeDir();
    const file = join(dir, "host.log");
    const logger = new FileLogger({
      file,
      onRecord: () => {
        throw new Error("订阅者坏了");
      },
      onWriteError: () => {
        throw new Error("报错的出口也坏了");
      },
    });

    expect(() => logger.warn("照样写")).not.toThrow();
    await logger.close();
    expect((await readIfExists(file)) ?? "").toContain("照样写");
  });
});
