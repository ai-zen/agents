/**
 * `agents-host stop` 的六条验收：发现文件不在、那个 pid 已经不在、`--yes` 直接动、回答 `n` 不动、
 * 回答 `y` 才动、非终端又没有 `--yes` 连问都不问。
 *
 * 这里不 fork 真进程、也不真发信号：`runStop` 把那几个副作用都从外面拿（读发现文件 → 判在不在 →
 * 问一次 → 发信号 → 等退出），用例就把替身递进去。要钉的正是这一段判事 —— 起真宿主那一半是跨进程
 * 用例的事。
 *
 * 只有发现文件是真的（临时目录里真写一份）：它的读法是这个包自己的代码，替掉它就没什么可测了。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseArgs, runStop, type StopDeps } from "./cli.js";
import { writeHostFile, type HostFileInfo } from "./infra/hostFile.js";
import { hostPaths } from "./infra/paths.js";

const HOST: HostFileInfo = {
  pid: 4321,
  host: "127.0.0.1",
  port: 8790,
  version: "0.1.0-alpha.8",
  local: true,
  startedAt: "2026-11-21T10:00:00.000Z",
};

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "host-stop-"));
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

function hostFilePath(): string {
  return hostPaths(dataRoot).hostFile;
}

interface Sent {
  readonly pid: number;
  readonly signal: NodeJS.Signals;
}

/**
 * 一次 `runStop` 的台架：记下发给谁什么信号、问了几句、两个流上各写了什么。
 *
 * `alive` 是探活答案的次序（用完之后一直是最后那一个）：第一次问是「动手之前它在不在」，之后
 * 每一次问都是「它退了没有」。
 */
function harness(options: {
  readonly yes?: boolean;
  readonly interactive?: boolean;
  readonly answer?: string;
  readonly alive?: readonly boolean[];
}) {
  const killed: Sent[] = [];
  const asked: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const alive = options.alive ?? [true];

  let polls = 0;

  const deps: StopDeps = {
    dataRoot,
    yes: options.yes ?? false,
    interactive: options.interactive ?? true,
    ask: async () => {
      asked.push("asked");
      return options.answer;
    },
    kill: (pid, signal) => killed.push({ pid, signal }),
    isAlive: () => alive[Math.min(polls++, alive.length - 1)] ?? true,
    sleep: async () => undefined,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };

  return { deps, killed, asked, out, err };
}

describe("agents-host stop", () => {
  it("没有发现文件：说清没有宿主在服务，非零退出，不发信号", async () => {
    const stub = harness({ yes: true, alive: [false] });

    const code = await runStop(stub.deps);

    expect(stub.err.join("")).toContain("No host is serving (missing run/host.json)");
    expect(stub.killed).toEqual([]);
    expect(code).not.toBe(0);
  });

  it("发现文件在、那个进程已经不在：报出它的 pid，非零退出，不发信号", async () => {
    writeHostFile(hostFilePath(), HOST);
    const stub = harness({ yes: true, alive: [false] });

    const code = await runStop(stub.deps);

    expect(stub.err.join("")).toContain(
      `The host recorded in run/host.json (pid ${HOST.pid}) is not running`,
    );
    expect(stub.killed).toEqual([]);
    expect(code).not.toBe(0);
  });

  it("`--yes`：不问，直接发 SIGTERM，等到它真的退出，返回 0", async () => {
    writeHostFile(hostFilePath(), HOST);
    const stub = harness({ yes: true, alive: [true, false] });

    const code = await runStop(stub.deps);

    expect(stub.asked).toEqual([]);
    expect(stub.killed).toEqual([{ pid: HOST.pid, signal: "SIGTERM" }]);
    expect(stub.out.join("")).toContain("The host has stopped");
    expect(code).toBe(0);
  });

  it("没有 `--yes`、回答 `n`：提问里带着地址与 pid，但不发信号，返回非零", async () => {
    writeHostFile(hostFilePath(), HOST);
    const stub = harness({ answer: "n", alive: [true, false] });

    const code = await runStop(stub.deps);

    expect(stub.out.join("")).toContain(
      `Stop the host at ws://${HOST.host}:${HOST.port} (pid ${HOST.pid})? [y/N] `,
    );
    expect(stub.asked).toHaveLength(1);
    expect(stub.killed).toEqual([]);
    expect(stub.err.join("")).toContain("Cancelled");
    expect(code).not.toBe(0);
  });

  it("回答 `y`：发信号并等到退出，返回 0", async () => {
    writeHostFile(hostFilePath(), HOST);
    const stub = harness({ answer: "y", alive: [true, false] });

    const code = await runStop(stub.deps);

    expect(stub.asked).toHaveLength(1);
    expect(stub.killed).toEqual([{ pid: HOST.pid, signal: "SIGTERM" }]);
    expect(code).toBe(0);
  });

  it("非终端又没有 `--yes`：不读、直接拒，不发信号，返回非零", async () => {
    writeHostFile(hostFilePath(), HOST);
    const stub = harness({ interactive: false, alive: [true, false] });

    const code = await runStop(stub.deps);

    // 二次确认不能在一个没人能回答的地方问：`ask` 一格不许被调用到
    expect(stub.asked).toEqual([]);
    expect(stub.killed).toEqual([]);
    expect(stub.err.join("")).toContain(
      "Refusing to stop the host without confirmation: pass --yes in a non-interactive shell",
    );
    expect(code).not.toBe(0);
  });
});

describe("命令行解析", () => {
  it("`stop --yes` 解析成那一支，不带 `--yes` 就是不问不动的默认", () => {
    expect(parseArgs(["stop", "--yes"])).toEqual({ kind: "stop", yes: true });
    expect(parseArgs(["stop"])).toEqual({ kind: "stop", yes: false });
  });
});
