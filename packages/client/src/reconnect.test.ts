/**
 * 重连策略的验收：退避算得对、该放弃的当场放弃、要不要一直试由调用方决定。
 */

import { describe, expect, it } from "vitest";

import { fromHostError, localError } from "./errors.js";
import {
  DEFAULT_RECONNECT_POLICY,
  isRetryableByDefault,
  reconnectUntilConnected,
  retryDelay,
  type ReconnectPolicy,
} from "./reconnect.js";

const POLICY: ReconnectPolicy = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 250,
  factor: 2,
};

describe("retryDelay", () => {
  it("按倍数涨、封顶", () => {
    expect(retryDelay(POLICY, 1)).toBe(100);
    expect(retryDelay(POLICY, 2)).toBe(200);
    expect(retryDelay(POLICY, 3)).toBe(250);
    expect(retryDelay(POLICY, 9)).toBe(250);
  });
});

describe("哪些失败值得重试", () => {
  it("被宿主拒 / 地址错 / 已经关掉的不重试", () => {
    expect(
      isRetryableByDefault(
        fromHostError({
          code: -32001,
          message: "x",
          data: { code: "unauthorized", message: "x", params: {} },
        }),
      ),
    ).toBe(false);
    expect(isRetryableByDefault(localError("bad_address", { params: {} }))).toBe(false);
    expect(isRetryableByDefault(localError("closed"))).toBe(false);
  });

  it("连不上 / 断了 / 超时要重试", () => {
    expect(isRetryableByDefault(localError("host_unavailable", { params: {} }))).toBe(true);
    expect(isRetryableByDefault(localError("connection_lost", { params: {} }))).toBe(true);
    expect(isRetryableByDefault(new Error("别的什么"))).toBe(true);
  });
});

describe("reconnectUntilConnected", () => {
  it("失败几次之后连上就返回", async () => {
    let attempts = 0;
    const waited: number[] = [];
    const failures: number[] = [];

    await reconnectUntilConnected(
      {
        reconnect: async () => {
          attempts += 1;
          if (attempts < 3) throw localError("connection_lost", { params: {} });
        },
      },
      {
        policy: POLICY,
        sleep: async (ms) => {
          waited.push(ms);
        },
        onAttemptFailed: (attempt) => failures.push(attempt.attempt),
      },
    );

    expect(attempts).toBe(3);
    expect(waited).toEqual([100, 200]);
    expect(failures).toEqual([1, 2]);
  });

  it("试满次数就把最后一次失败抛出去", async () => {
    let attempts = 0;
    const error = await reconnectUntilConnected(
      {
        reconnect: async () => {
          attempts += 1;
          throw localError("host_unavailable", { params: { endpoint: "h:1" } });
        },
      },
      { policy: POLICY, sleep: async () => undefined },
    ).catch((caught: unknown) => caught);

    expect(attempts).toBe(3);
    expect((error as { code?: string }).code).toBe("host_unavailable");
  });

  it("不值得重试的失败当场抛，不空转", async () => {
    let attempts = 0;
    const error = await reconnectUntilConnected(
      {
        reconnect: async () => {
          attempts += 1;
          throw fromHostError({
            code: -32001,
            message: "凭证没被接受",
            data: { code: "unauthorized", message: "凭证没被接受", params: {} },
          });
        },
      },
      { policy: POLICY, sleep: async () => undefined },
    ).catch((caught: unknown) => caught);

    expect(attempts).toBe(1);
    expect((error as { message?: string }).message).toBe("凭证没被接受");
  });

  it("缺省策略是一直试（要不要放弃由调用方决定）", async () => {
    expect(DEFAULT_RECONNECT_POLICY.maxAttempts).toBe(Number.POSITIVE_INFINITY);

    let attempts = 0;
    await reconnectUntilConnected(
      {
        reconnect: async () => {
          attempts += 1;
          if (attempts < 20) throw localError("connection_lost", { params: {} });
        },
      },
      { sleep: async () => undefined },
    );
    expect(attempts).toBe(20);
  });
});
