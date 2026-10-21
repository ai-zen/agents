import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigManager } from "./ConfigManager.js";
import { FACTORY_REASONING_PRESETS } from "./reasoning-presets.js";
import type { ReasoningPresets } from "../types/index.js";

let dir: string;
let mgr: ConfigManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "aiz-presets-"));
  mgr = new ConfigManager(join(dir, "config.json"));
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
});

describe("readReasoningPresets：读表", () => {
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
