/**
 * 三条验收：写进去再读出来是同一份（`run/` 还不存在时由写入自己建出来）；清掉之后读回「没有」，
 * 再清一次也不报错；半截 JSON 与缺字段的 JSON 都读成「没有」，而且不抛 —— pin 只是启动方式的一条
 * 提示，坏了不该拦住启动。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearVersionPin, readVersionPin, writeVersionPin, type VersionPin } from "./versionPin.js";

let dir: string;
let path: string;

const pin: VersionPin = { version: "2.0.0", requestedAt: "2026-11-21T10:00:00.000Z" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-version-pin-"));
  path = join(dir, "run", "next-version.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("升级 pin", () => {
  it("写进去再读出来是同一份", () => {
    writeVersionPin(path, pin);

    expect(readVersionPin(path)).toEqual(pin);
  });

  it("清掉之后读回没有；本来就不在时再清一次也不报错", () => {
    writeVersionPin(path, pin);

    clearVersionPin(path);
    expect(readVersionPin(path)).toBeUndefined();

    clearVersionPin(path);
    expect(readVersionPin(path)).toBeUndefined();
  });

  it("半截 JSON 与缺字段的 JSON 都读成没有，且不抛", () => {
    mkdirSync(dirname(path), { recursive: true });

    writeFileSync(path, "{", "utf8");
    expect(readVersionPin(path)).toBeUndefined();

    writeFileSync(path, JSON.stringify({ version: pin.version }), "utf8");
    expect(readVersionPin(path)).toBeUndefined();
  });
});
