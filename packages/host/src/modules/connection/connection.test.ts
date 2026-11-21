/**
 * 两条验收：开两条拿到的是两个 id，`list()` 两条，摘掉一条之后只剩另一条；摘一个不存在的 id
 * 不抛、`get` 它回 `undefined` —— socket 断开与进程收尾会各走一遍同一个 id。
 */

import { describe, expect, it } from "vitest";

import { Connections } from "./registry.js";

describe("客户端连接", () => {
  it("开两条是不同的 id，list() 两条，close 之后剩一条", () => {
    const connections = new Connections();

    const first = connections.open();
    const second = connections.open();

    expect(second.id).not.toBe(first.id);
    expect(connections.list()).toEqual([first, second]);

    connections.close(first.id);

    expect(connections.list()).toEqual([second]);
    expect(connections.get(first.id)).toBeUndefined();
    expect(connections.get(second.id)).toBe(second);
  });

  it("close 不存在的 id 不抛，get 它回 undefined", () => {
    const connections = new Connections();
    const live = connections.open();

    expect(() => connections.close("not-a-connection")).not.toThrow();
    expect(connections.get("not-a-connection")).toBeUndefined();
    expect(connections.list()).toEqual([live]);
  });
});
