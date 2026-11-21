/**
 * 三条验收：写进去再读出来是同一份（`local` 在磁盘上是布尔，不是字符串）；坏 JSON 与缺字段
 * 的 JSON 都读成「没有」，并且文件已经被删掉；进程存活探测分得清本进程与一个不存在的进程号。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearHostFile,
  isProcessAlive,
  readHostFile,
  writeHostFile,
  type HostFileInfo,
} from "./hostFile.js";

let dir: string;
let path: string;

const info: HostFileInfo = {
  pid: process.pid,
  host: "127.0.0.1",
  port: 8791,
  version: "0.1.0-alpha.8",
  local: false,
  startedAt: "2026-11-21T10:00:00.000Z",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-host-file-"));
  path = join(dir, "run", "host.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("宿主发现文件", () => {
  it("写进去再读出来是同一份，清掉之后就没有了", () => {
    writeHostFile(path, info);

    expect(readHostFile(path)).toEqual(info);
    expect(JSON.parse(readFileSync(path, "utf8")).local).toBe(false);

    clearHostFile(path);
    expect(readHostFile(path)).toBeUndefined();
  });

  it("坏 JSON 与缺字段的 JSON 都读成没有，文件已经被删掉", () => {
    mkdirSync(dirname(path), { recursive: true });

    writeFileSync(path, "{", "utf8");
    expect(readHostFile(path)).toBeUndefined();
    expect(existsSync(path)).toBe(false);

    const withoutLocal = {
      pid: info.pid,
      host: info.host,
      port: info.port,
      version: info.version,
      startedAt: info.startedAt,
    };
    writeFileSync(path, JSON.stringify(withoutLocal), "utf8");
    expect(readHostFile(path)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it("进程存活探测：本进程活着，一个轮不到的进程号不在", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    // 4194303 是 Linux 默认 `pid_max` 的上限，正常机器上不会有这个进程
    expect(isProcessAlive(4_194_303)).toBe(false);
  });
});
