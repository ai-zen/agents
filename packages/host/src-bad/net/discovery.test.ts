/**
 * 发现文件与凭证交付文件的验收。
 *
 * 要验的是「三种结果分开给」：文件不在 → `null`；内容坏了 → 报错；正常 → 解析后的形状。
 * 另外验原子写（不留临时文件）与交付文件的 `0600`（尽力而为的那一份）。
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePaths, type HostPaths } from "../config.js";
import { HostError } from "../wire/errors.js";
import {
  clearLocalToken,
  clearHostFile,
  readLocalToken,
  readHostFile,
  writeLocalToken,
  writeHostFile,
  type HostFileInfo,
} from "./discovery.js";
import { listDir, makeTempDir, type TempDir } from "./TestSupport.js";

let dir: TempDir;
let paths: HostPaths;

const INFO: HostFileInfo = {
  pid: 4321,
  host: "127.0.0.1",
  port: 8790,
  version: "0.1.0-alpha.0",
  local: true,
  startedAt: "2026-11-12T00:00:00.000Z",
};

beforeEach(async () => {
  dir = await makeTempDir("discovery");
  paths = resolvePaths(dir.path);
});

afterEach(async () => {
  await dir.remove();
});

describe("host.json", () => {
  it("目录不存在时会自己建出来，写完能原样读回", async () => {
    expect(await readHostFile(paths)).toBeNull();

    await writeHostFile(paths, INFO);

    expect(await readHostFile(paths)).toEqual(INFO);
    // 目录是这次写出来的
    expect(await listDir(paths.runDir)).toEqual(["host.json"]);
  });

  it("不留临时文件（原子写的中间产物要清干净）", async () => {
    await writeHostFile(paths, INFO);
    await writeHostFile(paths, { ...INFO, port: 8791 });

    expect(await listDir(paths.runDir)).toEqual(["host.json"]);
    expect((await readHostFile(paths))?.port).toBe(8791);
  });

  it("内容坏了报 config_invalid，且能分清「不在」与「坏了」", async () => {
    await fs.mkdir(paths.runDir, { recursive: true });
    await fs.writeFile(paths.hostFile, "{ 不是 JSON", "utf8");

    const error = await readHostFile(paths).catch((caught: unknown) => caught);
    expect(HostError.is(error)).toBe(true);
    expect((error as HostError).code).toBe("config_invalid");
    expect((error as HostError).detail).toMatchObject({ path: paths.hostFile });
  });

  it("字段缺了也报 config_invalid（指出是哪一项）", async () => {
    await fs.mkdir(paths.runDir, { recursive: true });
    await fs.writeFile(paths.hostFile, JSON.stringify({ ...INFO, port: "8790" }), "utf8");

    const error = await readHostFile(paths).catch((caught: unknown) => caught);
    expect(HostError.is(error)).toBe(true);
    expect((error as HostError).code).toBe("config_invalid");
    expect(JSON.stringify((error as HostError).detail)).toContain("port");
  });

  it("清掉之后读回 null，重复清不算错", async () => {
    await writeHostFile(paths, INFO);
    await clearHostFile(paths);
    expect(await readHostFile(paths)).toBeNull();
    await expect(clearHostFile(paths)).resolves.toBeUndefined();
  });
});

describe("run/token", () => {
  it("写进去能读回来（去掉行尾换行）", async () => {
    await writeLocalToken(paths, "some-token");
    expect(await readLocalToken(paths)).toBe("some-token");
  });

  it("权限设成 0600（POSIX 上可断言；Windows 上这一步是空操作）", async () => {
    await writeLocalToken(paths, "some-token");
    if (process.platform === "win32") return;
    const stat = await fs.stat(paths.tokenFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("文件不在时读回 null；空文件也当没有", async () => {
    expect(await readLocalToken(paths)).toBeNull();
    await fs.mkdir(paths.runDir, { recursive: true });
    await fs.writeFile(paths.tokenFile, "   \n", "utf8");
    expect(await readLocalToken(paths)).toBeNull();
  });

  it("清掉之后读回 null", async () => {
    await writeLocalToken(paths, "some-token");
    await clearLocalToken(paths);
    expect(await readLocalToken(paths)).toBeNull();
  });

  it("与发现文件同在 run/ 下，互不覆盖", async () => {
    await writeHostFile(paths, INFO);
    await writeLocalToken(paths, "some-token");

    expect(await listDir(paths.runDir)).toEqual(["host.json", "token"]);
    expect((await readHostFile(paths))?.pid).toBe(INFO.pid);
    expect(await readLocalToken(paths)).toBe("some-token");
  });

  it("数据根别处不受影响（只在 run/ 里动手）", async () => {
    await writeLocalToken(paths, "some-token");
    expect(await listDir(dir.path)).toEqual(["run"]);
    expect(join(dir.path, "run", "token")).toBe(paths.tokenFile);
  });
});
