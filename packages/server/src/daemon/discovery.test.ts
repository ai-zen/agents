import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  descriptorPath,
  isProcessAlive,
  readDescriptor,
  removeDescriptor,
  writeDescriptor,
  type ServerDescriptor,
} from "./discovery.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-server-discovery-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sample: ServerDescriptor = {
  pid: process.pid,
  host: "127.0.0.1",
  port: 8790,
  protocol: 1,
  version: "0.1.0",
  startedAt: new Date().toISOString(),
  schema: 1,
};

describe("发现文件", () => {
  it("写读往返：目录不存在时自动建（run/ 是新建的）", async () => {
    await writeDescriptor(dir, sample);
    expect(await readDescriptor(dir)).toEqual(sample);
    expect(descriptorPath(dir)).toBe(join(dir, "run", "server.json"));
  });

  it("写完不留 .tmp（原子写的中间产物）", async () => {
    await writeDescriptor(dir, sample);
    // 换名之后中间产物必须消失，且落盘内容就是写进去的那份
    expect(() => readFileSync(descriptorPath(dir) + ".tmp")).toThrow();
    expect(JSON.parse(readFileSync(descriptorPath(dir), "utf-8"))).toEqual(sample);
  });

  it("不存在时返回 null，不抛错", async () => {
    expect(await readDescriptor(dir)).toBeNull();
  });

  it("内容坏掉（半个 JSON / schema 不符）当作没有在跑", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, "run"), { recursive: true });
    writeFileSync(descriptorPath(dir), '{"pid":1', "utf-8");
    expect(await readDescriptor(dir)).toBeNull();

    writeFileSync(descriptorPath(dir), JSON.stringify({ ...sample, schema: 2 }), "utf-8");
    expect(await readDescriptor(dir)).toBeNull();
  });

  it("删除不报错（幂等）", async () => {
    await writeDescriptor(dir, sample);
    await removeDescriptor(dir);
    expect(await readDescriptor(dir)).toBeNull();
    await removeDescriptor(dir); // 再删一次也不抛
  });

  it("isProcessAlive 认得自己、也认得已退出的 pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    // 刚 spawn 就退出的子进程：pid 已经不在了
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });
});
