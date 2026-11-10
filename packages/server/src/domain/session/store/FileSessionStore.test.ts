import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "./FileSessionStore.js";

let root: string;
let store: FileSessionStore<string>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aiz-store-"));
  store = new FileSessionStore<string>({ rootDir: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sample = { id: "chat_1", agentId: "default", messages: ["hi"] };

describe("FileSessionStore", () => {
  it("写读往返：目录不存在时自动建", async () => {
    await store.write(sample);
    expect(await store.read("chat_1")).toEqual(sample);
    expect(readFileSync(join(root, "sessions", "chat_1.json"), "utf-8")).toContain("chat_1");
  });

  it("写完不留 .tmp，且 .meta.json 不会被当成第二段会话", async () => {
    await store.write(sample);
    expect(() => readFileSync(join(root, "sessions", "chat_1.json.tmp"))).toThrow();
    // 清单自己的文件名也以 `.json` 结尾：list 必须先认它，否则一段会话会出两条
    expect((await store.list()).map((c) => c.id)).toEqual(["chat_1"]);
  });

  it("老存档没有清单：list 读一次、补一份，updatedAt 取正文 mtime", async () => {
    mkdirSync(join(root, "sessions"), { recursive: true });
    const base = Date.now() / 1000 - 1000;
    for (const [id, offset] of [
      ["chat_old", 1],
      ["chat_mid", 2],
      ["chat_new", 3],
    ] as const) {
      // 直接写文件（绕过 write）：模拟没有清单的存档（清单被删或从未写过）
      writeFileSync(
        join(root, "sessions", `${id}.json`),
        JSON.stringify({ ...sample, id }),
        "utf-8",
      );
      utimesSync(join(root, "sessions", `${id}.json`), base + offset, base + offset);
    }

    // 倒序：最近写的在前（排序读的是清单，不是每次现算）
    expect((await store.list()).map((c) => c.id)).toEqual(["chat_new", "chat_mid", "chat_old"]);
    // 补出来的清单确实落了盘：下一次列表不再需要解析正文
    expect(readFileSync(join(root, "sessions", "chat_old.meta.json"), "utf-8")).toContain(
      "chat_old",
    );
    expect((await store.list()).map((c) => c.id)).toEqual(["chat_new", "chat_mid", "chat_old"]);
  });

  it("清单跟着正文走：messageCount / title / modelId / updatedAt 都能从列表拿到", async () => {
    await store.write({
      ...sample,
      title: "重构会话",
      modelId: "gpt-6-astra",
      messages: ["a", "b", "c"],
    });

    const [entry] = await store.list();
    expect(entry).toMatchObject({
      id: "chat_1",
      agentId: "default",
      title: "重构会话",
      modelId: "gpt-6-astra",
      messageCount: 3,
    });
    expect(Date.parse(entry!.updatedAt)).toBeGreaterThan(0);
  });

  it("entry 是 list 的单条版本：同一条逐字段一致（不能出现两个真相）", async () => {
    await store.write({
      ...sample,
      title: "重构会话",
      modelId: "gpt-6-astra",
      messages: ["a", "b", "c"],
    });
    await store.write({ ...sample, id: "chat_2", messages: ["x"] });

    const listed = (await store.list()).find((item) => item.id === "chat_1");
    // `toEqual`（而非 `toMatchObject`）：多一个字段、少一个字段都算不一致 ——
    // 侧栏显示的时间与续接时沿用下来的时间必须是同一个值
    expect(await store.entry("chat_1")).toEqual(listed);
    expect(await store.entry("chat_1")).toEqual({
      id: "chat_1",
      agentId: "default",
      title: "重构会话",
      modelId: "gpt-6-astra",
      messageCount: 3,
      updatedAt: listed!.updatedAt,
    });
  });

  it("entry：没有这一段就回 null（与 list 里没有它同义，不是错误）", async () => {
    // 会话目录还没建：真实路径（续接一个不存在的工作区里的存档）
    expect(await store.entry("chat_1")).toBeNull();

    await store.write(sample);
    expect(await store.entry("chat_nope")).toBeNull();
  });

  it("清单缺失：entry 从正文 mtime 回填，与 list 的回填逐字段一致", async () => {
    await store.write({ ...sample, id: "chat_a", title: "先问 entry", messages: ["a", "b"] });
    await store.write({ ...sample, id: "chat_b", title: "先问 list" });
    // 定死 mtime 再删清单：模拟「清单被手删 / 从未写过」的存档
    const base = Math.floor(Date.now() / 1000) - 500;
    for (const [id, offset] of [
      ["chat_a", 1],
      ["chat_b", 2],
    ] as const) {
      const path = join(root, "sessions", `${id}.json`);
      utimesSync(path, base + offset, base + offset);
      rmSync(join(root, "sessions", `${id}.meta.json`));
    }

    // 一条先问 entry、一条先问 list：两条回填路径必须落在同一份值上
    const viaEntry = await store.entry("chat_a");
    const viaList = (await store.list()).find((item) => item.id === "chat_b");

    expect(viaEntry).toEqual({
      id: "chat_a",
      agentId: "default",
      title: "先问 entry",
      messageCount: 2,
      updatedAt: new Date((base + 1) * 1000).toISOString(),
    });
    expect(await store.entry("chat_b")).toEqual(viaList);
    // 回填落了盘：下一次不再解析正文
    expect(readFileSync(join(root, "sessions", "chat_a.meta.json"), "utf-8")).toContain(
      "先问 entry",
    );
  });

  it("重写只刷新清单，不会把 title 弄丢", async () => {
    await store.write({ ...sample, title: "名字" });
    await store.write({ ...sample, title: "名字", messages: ["a", "b"] });

    const [entry] = await store.list();
    expect(entry!.title).toBe("名字");
    expect(entry!.messageCount).toBe(2);
  });

  it("list 在没有会话目录时返回空数组", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("read 遇到坏 JSON / 缺字段一律返回 null", async () => {
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(join(root, "sessions", "broken.json"), '{"id":"broken"', "utf-8");
    writeFileSync(join(root, "sessions", "shapeless.json"), '{"id":"x"}', "utf-8");

    expect(await store.read("broken")).toBeNull();
    expect(await store.read("shapeless")).toBeNull(); // messages 不是数组
    expect(await store.read("nope")).toBeNull(); // 根本不存在
  });

  it("remove / exists：正文与清单一起删（不留幽灵条目）", async () => {
    await store.write(sample);
    expect(await store.exists("chat_1")).toBe(true);
    await store.remove("chat_1");
    expect(await store.exists("chat_1")).toBe(false);
    expect(await store.list()).toEqual([]);
    await store.remove("chat_1"); // 幂等：再删一次不抛
  });

  it("上一轮会话指针：写读往返，没写过时是 null", async () => {
    expect(await store.lastSession()).toBeNull();
    await store.setLastSession("chat_1");
    const pointer = await store.lastSession();
    expect(pointer?.id).toBe("chat_1");
    expect(Date.parse(pointer!.updatedAt)).toBeGreaterThan(0);
  });

  it("指针写坏 / 旧格式（顶层没 id）当作没有", async () => {
    writeFileSync(join(root, "last-session.json"), '{"version":1,"sessions":{}}', "utf-8");
    expect(await store.lastSession()).toBeNull();
  });

  it("允许子目录 id（`/save 项目/a`）", async () => {
    await store.write({ ...sample, id: "项目/a" });
    expect(await store.read("项目/a")).toEqual({ ...sample, id: "项目/a" });
    expect(statSync(join(root, "sessions", "项目", "a.json")).isFile()).toBe(true);
  });

  it("挡住路径穿越：绝对路径 / .. / . / 空段 / 反斜杠", async () => {
    for (const id of ["../escape", "a/../../b", "/abs", ".", "a//b", "a\\b", ""]) {
      await expect(store.write({ ...sample, id })).rejects.toThrow(/invalid session id/);
    }
    // read 走的是同一道检查，但错误被吞成 null（读不到就是读不到）
    expect(await store.read("../escape")).toBeNull();
  });
});
