/**
 * 日志落盘（PRD F-J2）：写 `<数据根>/logs/host.log`、按大小轮转、warn / error 同时上通知、
 * 收尾时 flush 并关流。
 *
 * 用例只碰临时目录，不等真时间：轮转靠把 `maxBytes` 调小，通知靠注入的记账函数。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  Logger,
  formatLine,
} from "./Logger.js";

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

describe("日志落盘（PRD F-J2）", () => {
  it("写进 <dir>/host.log，行里带时间 / 级别 / 来源", async () => {
    const dir = await makeDir();
    const logger = new Logger({ dir, now: () => Date.UTC(2026, 0, 2, 3, 4, 5) });

    logger.info("宿主开始监听", { port: 8790 });
    logger.warn("上传收尾失败", { uploadId: "u-1" });
    await logger.close();

    const text = (await readIfExists(join(dir, "host.log"))) ?? "";
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "2026-01-02T03:04:05.000Z INFO  host 宿主开始监听 {\"port\":8790}",
    );
    expect(lines[1]).toContain("WARN ");
    expect(lines[1]).toContain("上传收尾失败");
  });

  it("收尾时 flush：写一行后立刻 close，读回来就在（没写出去等于没写）", async () => {
    const dir = await makeDir();
    const logger = new Logger({ dir });
    logger.error("这一行必须在关流之前落盘");
    expect(logger.isClosed).toBe(false);
    await logger.close();
    expect(logger.isClosed).toBe(true);
    expect(await readIfExists(join(dir, "host.log"))).toContain("这一行必须在关流之前落盘");
  });

  it("收尾之后不再落盘（关流就是关流）", async () => {
    const dir = await makeDir();
    const logger = new Logger({ dir });
    logger.info("第一行");
    await logger.close();
    logger.info("第二行");
    await logger.close();
    const text = (await readIfExists(join(dir, "host.log"))) ?? "";
    expect(text).toContain("第一行");
    expect(text).not.toContain("第二行");
  });

  it("攒满一份就轮转：新行进 host.log，旧内容进 host.log.1", async () => {
    const dir = await makeDir();
    const at = Date.UTC(2026, 0, 2, 0, 0, 0);
    // 先量一下一行有多少字节，再把上限设成「正好装三行」——这样只会轮转一次，结论可断言
    const lineBytes = Buffer.byteLength(formatLine(at, "info", "host", "第1行"));
    const logger = new Logger({ dir, now: () => at, maxBytes: lineBytes * 3 + 1 });

    for (let index = 1; index <= 6; index += 1) logger.info(`第${index}行`);
    await logger.close();

    const current = (await readIfExists(join(dir, "host.log"))) ?? "";
    const previous = (await readIfExists(join(dir, "host.log.1"))) ?? "";
    // 前三行被轮转到 .1，后三行还在正在写的那份里
    expect(previous.trimEnd().split("\n")).toHaveLength(3);
    expect(previous).toContain("第1行");
    expect(previous).not.toContain("第4行");
    expect(current).toContain("第4行");
    expect(current).toContain("第6行");
    expect(current).not.toContain("第1行");
  });

  it("保留份数有上限：最老的一份在轮转时被删掉", async () => {
    const dir = await makeDir();
    const logger = new Logger({ dir, maxBytes: 120, maxFiles: 2 });
    for (let index = 1; index <= 12; index += 1) logger.info(`行 ${index} ${"y".repeat(30)}`);
    await logger.close();

    expect(await readIfExists(join(dir, "host.log"))).not.toBeNull();
    expect(await readIfExists(join(dir, "host.log.1"))).not.toBeNull();
    // maxFiles: 2 = 正在写的那份 + 一份旧的，没有 .2
    expect(await readIfExists(join(dir, "host.log.2"))).toBeNull();
  });

  it("缺省是 5MB × 5 份", () => {
    expect(DEFAULT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(DEFAULT_MAX_FILES).toBe(5);
  });

  it("行格式是纯函数：级别定宽、detail 压成一行 JSON", () => {
    const line = formatLine(Date.UTC(2026, 0, 2, 0, 0, 0), "warn", "ws", "连接出错", {
      connectionId: "c-1",
    });
    expect(line).toBe(
      "2026-01-02T00:00:00.000Z WARN  ws 连接出错 {\"connectionId\":\"c-1\"}\n",
    );
    // 循环引用也留一行（内容换成占位符），不让整条记录丢掉
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatLine(0, "error", "host", "怪东西", cyclic)).toContain("[unserializable]");
  });
});

describe("warn / error 上通知（PRD F-J2）", () => {
  it("warn / error 调通知出口，info 不调", async () => {
    const dir = await makeDir();
    const raised: Array<{ level: string; summary: string }> = [];
    const logger = new Logger({
      dir,
      notifier: (level, summary) => {
        raised.push({ level, summary });
      },
    });

    logger.info("只是信息");
    logger.warn("有点问题");
    // 通知是异步发的：让它先跑完，再看下一条
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(raised).toEqual([{ level: "warning", summary: "有点问题" }]);
    logger.error("出事了");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await logger.close();
    expect(raised).toEqual([
      { level: "warning", summary: "有点问题" },
      { level: "error", summary: "出事了" },
    ]);
  });

  it("通知里再产生日志也不会再上通知（防回环），但照样落文件", async () => {
    const dir = await makeDir();
    let raised = 0;
    let logger: Logger | null = null;
    logger = new Logger({
      dir,
      notifier: (level, summary) => {
        raised += 1;
        // 模拟「发通知这条路上又冒出日志」：不加防护就会一路循环下去
        logger?.error(`${summary} → 通知时又出错`);
      },
    });

    logger.error("第一次出事");
    // 等通知那一跳跑完（它是异步的）再收尾，否则后一行会因为「已关流」而丢
    await new Promise((resolve) => setTimeout(resolve, 0));
    await logger.close();

    expect(raised).toBe(1);
    const text = (await readIfExists(join(dir, "host.log"))) ?? "";
    expect(text).toContain("第一次出事");
    expect(text).toContain("通知时又出错");
  });

  it("通知本身失败不抛给调用方（日志不该反过来把业务弄挂）", async () => {
    const dir = await makeDir();
    const logger = new Logger({
      dir,
      notifier: () => {
        throw new Error("库挂了");
      },
    });
    expect(() => logger.error("出事了")).not.toThrow();
    await logger.close();
    expect(await readIfExists(join(dir, "host.log"))).toContain("出事了");
  });

  it("后接的通知出口也能生效（日志口子比通知服务先造出来）", async () => {
    const dir = await makeDir();
    const raised: string[] = [];
    const logger = new Logger({ dir });
    logger.setNotifier((level, summary) => {
      raised.push(`${level}:${summary}`);
    });
    logger.warn("晚接也能收到");
    await logger.close();
    expect(raised).toEqual(["warning:晚接也能收到"]);
  });
});

describe("来源标签", () => {
  it("withSource 换来源，同一个文件里能分清是谁写的", async () => {
    const dir = await makeDir();
    const logger = new Logger({ dir, source: "host" });
    logger.info("单根的事");
    logger.withSource("ws").warn("接线层的事");
    await logger.close();

    const text = (await readIfExists(join(dir, "host.log"))) ?? "";
    expect(text).toContain("INFO  host 单根的事");
    expect(text).toContain("WARN  ws 接线层的事");
  });
});
