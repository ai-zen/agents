import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigManager } from "./ConfigManager.js";
import { messagesAt, recordingLog } from "../test-support/log.js";
import { FACTORY_REASONING_PRESETS } from "./reasoning-presets.js";
import type { ReasoningPresets } from "../types/index.js";

let dir: string;
let mgr: ConfigManager;
/** 配置管理器的日志口（记账的那一份）：策略表读不出来时从这里报 */
let log: ReturnType<typeof recordingLog>;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "aiz-presets-"));
  log = recordingLog();
  mgr = new ConfigManager(join(dir, "config.json"), undefined, log.logger);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function readDisk(): Promise<ReasoningPresets> {
  return JSON.parse(await fs.readFile(mgr.reasoningPresetsPath, "utf-8")) as ReasoningPresets;
}

async function writeDisk(value: unknown): Promise<void> {
  await fs.writeFile(mgr.reasoningPresetsPath, JSON.stringify(value, null, 2), "utf-8");
}

describe("策略表落盘位置", () => {
  it("与 config.json 同级，文件名固定", () => {
    expect(mgr.reasoningPresetsPath).toBe(join(dir, "reasoning-presets.json"));
  });
});

describe("ensureReasoningPresets：释放出厂策略", () => {
  it("文件不存在 → 写入出厂种子，并返回全部策略名", async () => {
    const written = await mgr.ensureReasoningPresets();
    expect(written.sort()).toEqual(Object.keys(FACTORY_REASONING_PRESETS).sort());
    expect(await readDisk()).toEqual(FACTORY_REASONING_PRESETS);
  });

  it("已是最新 → 不写盘、返回空（不每次启动改文件）", async () => {
    await mgr.ensureReasoningPresets();
    const before = await fs.stat(mgr.reasoningPresetsPath);

    const written = await mgr.ensureReasoningPresets();
    expect(written).toEqual([]);
    const after = await fs.stat(mgr.reasoningPresetsPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("未标 custom 的策略被出厂版覆盖", async () => {
    const tampered = structuredClone(FACTORY_REASONING_PRESETS) as ReasoningPresets;
    tampered.deepseek = { levels: { high: { reasoning_effort: "HIGH" } } }; // 用户改坏了
    await writeDisk(tampered);

    const written = await mgr.ensureReasoningPresets();
    expect(written).toEqual(["deepseek"]);
    expect((await readDisk()).deepseek).toEqual(FACTORY_REASONING_PRESETS.deepseek);
  });

  it("标了 custom: true 的策略原样保留（用户接管）", async () => {
    const custom: ReasoningPresets = {
      ...structuredClone(FACTORY_REASONING_PRESETS),
      deepseek: { custom: true, levels: { only: { reasoning_effort: "high" } } },
    };
    await writeDisk(custom);

    const written = await mgr.ensureReasoningPresets();
    expect(written).toEqual([]);
    expect((await readDisk()).deepseek).toEqual(custom.deepseek);
  });

  it("用户自建的非出厂策略永远保留", async () => {
    const withMine: ReasoningPresets = {
      ...structuredClone(FACTORY_REASONING_PRESETS),
      "my-endpoint": { levels: { fast: { reasoning_effort: "low" } } },
    };
    await writeDisk(withMine);

    await mgr.ensureReasoningPresets();
    expect((await readDisk())["my-endpoint"]).toEqual({
      levels: { fast: { reasoning_effort: "low" } },
    });
  });
  it("文件在但不是 JSON → 不覆盖、返回空（你的表原样留着）", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(mgr.reasoningPresetsPath, "{ 不是 json", "utf-8");

    const written = await mgr.ensureReasoningPresets();

    expect(written).toEqual([]);
    // 关键：磁盘上那份没被出厂值盖掉 —— 读不出来就动它，等于把用户标了 custom 的条目一起抹了
    expect(await fs.readFile(mgr.reasoningPresetsPath, "utf-8")).toBe("{ 不是 json");
    // 没写盘是「按设计不做」，但得有人知道这一次没同步：注入的日志口收到一条 error
    expect(messagesAt(log.records, "error")).toHaveLength(1);
  });
});

describe("readReasoningPresets：读表", () => {
  it("文件损坏 → 报一句 error 再交出出厂表（不是默默换一张表）", async () => {
    await fs.writeFile(mgr.reasoningPresetsPath, "{ 不是 json", "utf-8");

    expect(await mgr.readReasoningPresets()).toEqual(FACTORY_REASONING_PRESETS);
    const errors = messagesAt(log.records, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("思考策略表");
  });

  it("读磁盘内容（用户改动立即生效）", async () => {
    await writeDisk({ mine: { levels: { fast: { a: 1 } } } });
    expect(await mgr.readReasoningPresets()).toEqual({ mine: { levels: { fast: { a: 1 } } } });
  });

  it("文件缺失 → 回落到出厂种子（不写盘）", async () => {
    expect(await mgr.readReasoningPresets()).toEqual(FACTORY_REASONING_PRESETS);
    await expect(fs.access(mgr.reasoningPresetsPath)).rejects.toThrow();
  });

  it("文件损坏 → 回落出厂种子，不抛错", async () => {
    await fs.writeFile(mgr.reasoningPresetsPath, "{ 不是 json", "utf-8");
    expect(await mgr.readReasoningPresets()).toEqual(FACTORY_REASONING_PRESETS);
  });

  it("内容是数组 → 视作损坏，回落出厂种子", async () => {
    await writeDisk([1, 2, 3]);
    expect(await mgr.readReasoningPresets()).toEqual(FACTORY_REASONING_PRESETS);
  });

  it("bootstrap 会顺带释放策略表", async () => {
    await mgr.bootstrap();
    await expect(fs.access(mgr.reasoningPresetsPath)).resolves.toBeUndefined();
    expect(await readDisk()).toEqual(FACTORY_REASONING_PRESETS);
  });
});
