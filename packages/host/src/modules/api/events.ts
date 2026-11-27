import { z } from "zod";

import type { HostEvent } from "../events.js";
import type { HostApiDeps } from "./deps.js";
import type { Trpc } from "./trpc.js";

/**
 * 一条流。`.output()` 在 subscription 上声明的是流本身，不是每一片载荷 —— 写成载荷类型，
 * tRPC 会要求 resolver 直接返回那个值。所以这里给的是 `AsyncIterable<HostEvent>`：事件的形状
 * 仍然只有 `modules/events.ts` 那一份，逐片校验 tRPC 在流上没有这个口。
 */
const hostEventStream = z.custom<AsyncIterable<HostEvent>>();

export function eventsProcedure(deps: HostApiDeps, api: Trpc) {
  return api.procedure.output(hostEventStream).subscription(async function* ({ signal }) {
    const pending: HostEvent[] = [];
    let wake: (() => void) | undefined;

    // 先订阅再等第一片：客户端收到 `started` 之后才会去发下一次调用，这中间不能漏事件
    const unsubscribe = deps.events.subscribe((event) => {
      pending.push(event);
      wake?.();
    });

    // 客户端离开时要能唤醒挂着的等待。不这么做的话生成器停在那一句 `await` 上，`finally`
    // 永远等不到，总线上留下一个直到进程退出都在的订阅者。
    const stopped = new Promise<void>((resolve) => {
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });

    try {
      while (signal?.aborted !== true) {
        if (pending.length === 0) {
          await Promise.race([new Promise<void>((resolve) => (wake = resolve)), stopped]);
        }
        wake = undefined;
        yield* pending.splice(0);
      }
    } finally {
      unsubscribe();
    }
  });
}
