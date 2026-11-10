/**
 * `ServerConnection` 的用例：**一个进程一条连接**这件事的七条边界，一个不多。
 *
 * ## 为什么用一个内存假连接，而不是真 socket
 *
 * 这里要钉的全是「连接**怎么长回来**」的判定：缓存还算不算数、并发取用建几条、重建之后
 * `events.watch` 补不补、断线通知报几次、`close()` 之后还理不理人。这些判定与线上跑的是
 * TCP 还是别的传输无关，而真 socket 只能按它自己的节奏断开（要凑时序就得摆一台 daemon，
 * 而 `channel.test.ts` 已经用真 daemon 验了另一层）。假连接把「什么时候断」变成一行代码。
 *
 * 假连接（{@link FakeClient}）只实现 `ServerClient` 这个端口：`call` 记账、`onClose` 留
 * 存根、`die()` 模拟「服务端那侧断开」。**不用 `vi.mock`**：`vi.mock` 换的是模块并且会
 * 骗过类型，而这里要的只是「一条可被我决定何时断开的连接」。
 *
 * ## 六条用例对应文件头的哪几条不变式
 *
 * 1. 复用活连接（不变量 1 的正面）；
 * 2. `closed` 之后重建（不变量 1 的负面：桌面端那个「建成之后永不复查」的 bug）；
 * 3. 并发取用只建一条（单飞：一条进程里躺着两条，第二条谁也不记得关）；
 * 4. 重建之后 `events.watch` 恰好补发一帧（不变量 2：不多不少 —— 多发一帧，服务端每帧多
 *    注册一个订阅者，屏幕上答案会被切成两遍）；
 * 5. `onClose` 只上报一次，且一个订阅方抛错不连累别人（不变量 3）；
 * 6. `close()` 之后不再重建（文件头那条二选一）。
 */

import { describe, expect, it } from "vitest";
import { EVENT_METHODS } from "@ai-zen/agents-protocol";
import { ServerConnection } from "./connection.js";
import type { ServerAddress, ServerClient } from "../types.js";

/**
 * 一条可以被我决定何时断开的连接。
 *
 * `call` 记账（`watchFrames` 直接从账上数），`onClose` 只留存根，`die()` 才真的往上说 ——
 * 与真实现里「socket 的 close 事件 → socket-server-client 的上报」是同一条链的末端。
 */
class FakeClient implements ServerClient {
  readonly address: ServerAddress = { host: "127.0.0.1", port: 0 };
  closed = false;
  readonly calls: string[] = [];
  private readonly closeListeners = new Set<() => void>();

  constructor(readonly name: string) {}

  async call<T>(method: string): Promise<T> {
    if (this.closed) throw new Error(`${this.name} 已经关了`);
    this.calls.push(method);
    return undefined as T;
  }

  on(): () => void {
    return () => {};
  }

  close(): void {
    this.closed = true;
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** 服务端那侧断开（真实现里是 socket 的 close 事件） */
  die(): void {
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener();
  }

  /** 这条连接上收到过几帧 `events.watch`（服务端按帧登记订阅者，所以「恰好一帧」才是对的） */
  get watchFrames(): number {
    return this.calls.filter((method) => method === EVENT_METHODS.watch).length;
  }
}

/** 造一个「每次建连都记一笔」的连接器，返回它和建出来的那些假连接 */
function connectionWithLog(): { connection: ServerConnection; made: FakeClient[] } {
  const made: FakeClient[] = [];
  const connection = new ServerConnection({
    connect: async () => {
      const client = new FakeClient(`conn-${made.length + 1}`);
      made.push(client);
      return client;
    },
  });
  return { connection, made };
}

describe("ServerConnection：一个进程一条连接", () => {
  it("复用活连接：同一条还活着就一直用它", async () => {
    const { connection, made } = connectionWithLog();

    const first = await connection.client();
    const second = await connection.client();

    expect(second).toBe(first);
    expect(made).toHaveLength(1);
    expect(connection.closed).toBe(false);
  });

  it("缓存的连接关了：下一次取用重建一条（绝不把死连接交出去）", async () => {
    // 桌面端那个 bug 的正面写法：「缓存」与「它还能用」是两件事 —— 建成之后不复查 `closed`，
    // daemon 重启一次那个进程就永久失能，而界面看起来只是「没反应」
    const { connection, made } = connectionWithLog();

    const first = await connection.client();
    first.close();
    expect(connection.closed).toBe(true);

    const second = await connection.client();

    expect(second).not.toBe(first);
    expect(made).toHaveLength(2);
    expect(connection.closed).toBe(false);
    // 交出去的这条真的能用（不是「换了个对象但其实也是死的」）
    await expect(second.call("ping")).resolves.toBeUndefined();
  });

  it("并发取用只建一条（单飞）：两个会话同时发现断线也只长出一条连接", async () => {
    const made: FakeClient[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const connection = new ServerConnection({
      connect: async () => {
        const client = new FakeClient(`conn-${made.length + 1}`);
        made.push(client);
        // 建连本来就是异步的：两次取用在这期间重叠，才是「并发」而不是「先后」
        await gate;
        return client;
      },
    });

    const first = connection.client();
    const second = connection.client();
    openGate();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(b);
    expect(made).toHaveLength(1);
  });

  it("重建之后 events.watch 在新连接上恰好补发一帧（旧连接上也只有一帧）", async () => {
    // 少一帧 = 新连接什么都不推（症状很安静：不报错，只是什么都不来）；
    // 多一帧 = 服务端每帧多注册一个订阅者，每个事件到达两遍（屏幕上答案被切成两遍）
    const { connection, made } = connectionWithLog();

    await connection.watch();
    await connection.watch(); // 幂等：同一条连接上不重复发帧
    expect(made[0]!.watchFrames).toBe(1);

    made[0]!.close();
    await connection.watch(); // 连接换了：调用方只表达意图，补帧是连接层的事

    expect(made).toHaveLength(2);
    expect(made[0]!.watchFrames).toBe(1);
    expect(made[1]!.watchFrames).toBe(1);
  });

  it("「连接断了」只上报一次，且一个订阅方抛错不连累别人；旧连接迟到的通知不再报", async () => {
    const { connection, made } = connectionWithLog();
    await connection.client();
    const seen: string[] = [];
    connection.onClose(() => {
      seen.push("抛错的订阅方");
      throw new Error("订阅方自己炸了");
    });
    connection.onClose(() => seen.push("另一个订阅方"));

    made[0]!.die();

    // 一个订阅方抛错不该让别的订阅方收不到（与 EventHub / socket 客户端同一口径）
    expect(seen).toEqual(["抛错的订阅方", "另一个订阅方"]);

    // 换了一条新连接之后，旧连接迟到的通知不该把新连接报成「断了」
    const second = await connection.client();
    expect(second).toBe(made[1]);
    made[0]!.die();
    expect(seen).toHaveLength(2);

    // 新连接自己的断开照样上报一次
    made[1]!.die();
    expect(seen).toHaveLength(4);
  });

  it("close() 之后不再重建：直接失败，而不是交出一条「新但聋」的连接", async () => {
    // 不守门的形状：`close()` 把 current 置空 → 下一次 `client()` 重建一条 →
    // 而 `handleClose()` 因 `disposed` 直接 return ⇒ 新连接永远收不到断线通知
    const { connection, made } = connectionWithLog();
    await connection.client();

    connection.close();

    await expect(connection.client()).rejects.toThrow(/已经 close\(\)/);
    // 没有再建一条（建了也没人听它的断线）
    expect(made).toHaveLength(1);
    expect(made[0]!.closed).toBe(true);
  });
});
