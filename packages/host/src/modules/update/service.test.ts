/**
 * 升级的第 ② 段（宿主那一半）的五条验收，全部对着替身跑：`installedVersion` / `registryHas` /
 * `requestRestart` 是这一条路上仅有的三个外部世界，pin 落在临时目录里。
 *
 * 1. 磁盘上已经是目标版本就不问 registry —— 那一次出网既慢又可能不通，而答案已经在磁盘上；
 * 2. 磁盘上不是、registry 上有，同样写 pin 并请重装（`npx` 拉起的宿主只有这一条路走得通）；
 * 3. 两条都不成立 = `not_available`，**不写 pin、不请重装**：把「这一版不存在」挡在弄死服务之前；
 * 4. 范围、tag、`latest` 一律 `invalid_params`：挑版本是客户端的事，宿主只认一个号；
 * 5. pin 里落的是目标版本与一个 ISO 时刻（启动方式读它、按它重拉）。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../../infra/errors.js";
import { readVersionPin } from "../../infra/versionPin.js";
import { createTranslator } from "../i18n/index.js";
import { UpdateService, type UpdateDeps } from "./service.js";

let dir: string;
let pinFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-update-"));
  pinFile = join(dir, "run", "next-version.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 一个服务实例与它那两个副作用口的记账本 */
interface Harness {
  readonly service: UpdateService;
  /** 问过 registry 哪几个号，按问的次序 */
  readonly asked: string[];
  /** 请重装过哪几个版本，按请的次序 */
  readonly restarted: string[];
}

function harness(options: {
  /** 磁盘上那一份报告的版本 */
  readonly installed: string;
  /** registry 的替身：拿到号回 true。不给就是不认识任何号 */
  readonly has?: (version: string) => boolean;
}): Harness {
  const asked: string[] = [];
  const restarted: string[] = [];

  const deps: UpdateDeps = {
    pinFile,
    installedVersion: () => options.installed,
    registryHas: async (version) => {
      asked.push(version);
      return options.has?.(version) ?? false;
    },
    requestRestart: (version) => restarted.push(version),
    t: createTranslator(() => "zh"),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };

  return { service: new UpdateService(deps), asked, restarted };
}

/** 把 `upgrade` 的拒绝收成值：这几条验的是「报了哪个码」，不是「抛没抛」 */
async function rejection(service: UpdateService, version: string): Promise<HostError> {
  const error = await service.upgrade(version).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(HostError);
  return error as HostError;
}

describe("升级：验这一版拿得到", () => {
  it("磁盘上已经是目标版本：不问 registry，直接写 pin、请重装", async () => {
    const { service, asked, restarted } = harness({ installed: "2.0.0" });

    await expect(service.upgrade("2.0.0")).resolves.toEqual({
      version: "2.0.0",
      restarting: true,
    });

    expect(asked).toEqual([]);
    expect(restarted).toEqual(["2.0.0"]);
    expect(readVersionPin(pinFile)?.version).toBe("2.0.0");
  });

  it("磁盘上不是、registry 上有：写 pin、请重装", async () => {
    const { service, asked, restarted } = harness({
      installed: "1.0.0",
      has: (version) => version === "2.0.0",
    });

    await expect(service.upgrade("2.0.0")).resolves.toEqual({
      version: "2.0.0",
      restarting: true,
    });

    expect(asked).toEqual(["2.0.0"]);
    expect(restarted).toEqual(["2.0.0"]);
    expect(readVersionPin(pinFile)?.version).toBe("2.0.0");
  });

  it("两条都不成立：not_available，不写 pin、不请重装", async () => {
    const { service, restarted } = harness({ installed: "1.0.0", has: () => false });

    const error = await rejection(service, "2.0.0");

    expect(error.code).toBe("not_available");
    expect(error.details).toEqual({ version: "2.0.0" });
    expect(restarted).toEqual([]);
    // 没写 pin：落盘目录里连 `run/` 都不该被建出来
    expect(existsSync(pinFile)).toBe(false);
  });

  it("范围、tag、latest 一律 invalid_params，且什么都没写", async () => {
    const { service, asked, restarted } = harness({ installed: "1.0.0", has: () => true });

    for (const version of ["^2.0.0", "latest", "next"]) {
      const error = await rejection(service, version);
      expect(error.code).toBe("invalid_params");
      expect(error.details).toEqual({ version });
    }

    expect(asked).toEqual([]);
    expect(restarted).toEqual([]);
    expect(existsSync(pinFile)).toBe(false);
  });

  it("pin 里是目标版本与一个 ISO 时刻", async () => {
    const { service } = harness({ installed: "1.0.0", has: (version) => version === "2.1.3" });
    const askedAt = Date.now();

    await service.upgrade("2.1.3");

    const pin = readVersionPin(pinFile);
    expect(pin?.version).toBe("2.1.3");
    // ISO 8601 的 UTC 那一形：启动方式会把它原样读回来，不另做解析
    expect(pin?.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(pin?.requestedAt ?? "")).toBeGreaterThanOrEqual(askedAt);
    expect(Date.parse(pin?.requestedAt ?? "")).toBeLessThanOrEqual(Date.now());
  });
});
