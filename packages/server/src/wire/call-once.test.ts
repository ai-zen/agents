/**
 * `callOnce` 的用例 —— 真 socket、真帧，一个只认「握手 + 一帧」的假服务端。
 *
 * 为什么不用 `vi.mock`：这段代码的全部价值就在**真的收发与真的超时**上。把它换成假件，
 * 测到的只是「我按我想要的方式调了它」，而不是它真能在一条线上把一句话问完。
 *
 * 为什么假服务端是手搓的 30 行而不是真 `Daemon`：这里需要的只是「一个会说 JSON-lines 的
 * 对端」，与 `wire.test.ts` 用一个内存双工证明「不是 `net.Socket` 也能驱动 `Daemon`」是
 * 同一个思路的反向：证明「不是 `Daemon` 也能被 `callOnce` 问」。
 */

import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { callOnce } from "./call-once.js";
import { encodeFrame, FrameDecoder } from "./frames.js";
import { PROTOCOL_VERSION } from "./messages.js";

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server = null;
  });
});

interface FakePeerOptions {
  /** 服务端对某个请求的回应；默认回 `{ ok: true, result }` */
  reply?: (
    method: string,
  ) => { ok: true; result: unknown } | { ok: false; code: string; msg: string };
  /** 握手是否放行 */
  acceptHandshake?: boolean;
  /** `true` = 收下请求但永不回（测超时） */
  silent?: boolean;
  /** 看一眼收到的原始请求帧（断言帧形状用 —— 比如「没给 params 时帧里就不该有它」） */
  onRequest?: (frame: Record<string, unknown>) => void;
}

/** 起一个只会说「握手 + 一帧」的对端，返回它监听的端口 */
async function startFakePeer(options: FakePeerOptions = {}): Promise<number> {
  const peer: Server = createServer((socket: Socket) => {
    const decoder = new FrameDecoder();
    let greeted = false;
    socket.on("data", (chunk: Buffer) => {
      decoder.push(chunk);
      for (let item = decoder.next(); item; item = decoder.next()) {
        if (item.type !== "frame") continue;
        const value = item.frame as Record<string, any>;
        if (value?.kind === "hello") {
          if (options.acceptHandshake === false) {
            socket.write(
              encodeFrame({
                kind: "hello",
                ok: false,
                error: { code: "version-mismatch", message: "nope" },
              }),
            );
            continue;
          }
          greeted = true;
          socket.write(
            encodeFrame({
              kind: "hello",
              ok: true,
              server: {
                name: "fake",
                version: "0",
                protocol: PROTOCOL_VERSION,
                pid: 1,
                startedAt: "",
              },
            }),
          );
          continue;
        }
        // 没握手就来请求：按服务端的真实行为（`Daemon` 也是）直接无视
        if (!greeted || options.silent) continue;
        options.onRequest?.(value);
        const answer = options.reply?.(String(value?.method)) ?? {
          ok: true,
          result: { method: value?.method, params: value?.params ?? null },
        };
        if (answer.ok) socket.write(encodeFrame({ id: value.id, ok: true, result: answer.result }));
        else
          socket.write(
            encodeFrame({
              id: value.id,
              ok: false,
              error: { code: answer.code, message: answer.msg },
            }),
          );
      }
    });
    // 对端读帧时的解析错误不该让用例挂住：直接掐掉这条连接
    socket.on("error", () => socket.destroy());
  });
  server = peer;
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", () => resolve()));
  return (peer.address() as { port: number }).port;
}

describe("callOnce", () => {
  it("一问一答：返回服务端的结果（params 原样送到）", async () => {
    const port = await startFakePeer();

    // 用一条**带参数**的方法：`ping` 在方法表里是 `void`，带 params 在类型上就不成立
    const result = await callOnce({ host: "127.0.0.1", port }, "workspace.resolve", {
      path: "/tmp",
    });

    expect(result).toEqual({ method: "workspace.resolve", params: { path: "/tmp" } });
  });

  it("不带 params：帧里不出现 params 字段（`JSON.stringify` 把 undefined 整键丢掉）", async () => {
    const frames: Record<string, unknown>[] = [];
    const port = await startFakePeer({
      reply: () => ({ ok: true, result: null }),
      onRequest: (frame) => frames.push(frame),
    });

    await callOnce({ host: "127.0.0.1", port }, "status");

    // 帧里只有 id 与 method：多一个 `params: undefined` 在 JSON 里会变成 null，
    // 而服务端的 `optionalString` 之类会把 null 当「没给」—— 那只是运气，不是契约
    expect(frames).toHaveLength(1);
    expect(Object.keys(frames[0]).sort()).toEqual(["id", "method"]);
  });

  it("服务端回失败帧：抛错，且 code 挂在 error.code 上（与长连接同一形态）", async () => {
    const port = await startFakePeer({
      reply: () => ({ ok: false, code: "session-missing", msg: "no such session: chat_1" }),
    });

    await expect(callOnce({ host: "127.0.0.1", port }, "session.snapshot")).rejects.toMatchObject({
      code: "session-missing",
      message: "session-missing: no such session: chat_1",
    });
  });

  it("握手被拒：抛错，不把请求发出去", async () => {
    const port = await startFakePeer({ acceptHandshake: false });

    await expect(callOnce({ host: "127.0.0.1", port }, "ping")).rejects.toThrow(
      /handshake rejected/,
    );
  });

  it("对端收下请求却不回：超时报错，不无限等", async () => {
    const port = await startFakePeer({ silent: true });

    await expect(
      callOnce({ host: "127.0.0.1", port }, "shutdown", undefined, { timeoutMs: 50 }),
    ).rejects.toThrow(/timeout after 50ms calling shutdown/);
  });

  it("连不上：错误直接冒出来（探活的假就是这个形态）", async () => {
    // 先占一个端口再放掉：这个端口此刻确定没人监听
    const port = await startFakePeer();
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
      server = null;
    });

    await expect(callOnce({ host: "127.0.0.1", port }, "ping")).rejects.toThrow(
      /ECONNREFUSED|connect/i,
    );
  });
});
