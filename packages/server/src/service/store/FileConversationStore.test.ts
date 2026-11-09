import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConversationStore } from "./FileConversationStore.js";

let root: string;
let store: FileConversationStore<string>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aiz-store-"));
  store = new FileConversationStore<string>({ rootDir: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sample = { id: "chat_1", agentId: "default", messages: ["hi"] };

describe("FileConversationStore", () => {
  it("写读往返：目录不存在时自动建", async () => {
    await store.write(sample);
    expect(await store.read("chat_1")).toEqual(sample);
    expect(readFileSync(join(root, "conversations", "chat_1.json"), "utf-8")).toContain("chat_1");
  });

  it("写完不留 .tmp，且 list 不会把它当会话", async () => {
    await store.write(sample);
    expect(() => readFileSync(join(root, "conversations", "chat_1.json.tmp"))).toThrow();
    expect((await store.list()).map((c) => c.id)).toEqual(["chat_1"]);
  });

  it("list 按文件 mtime 倒序（不解析内容）", async () => {
    await store.write({ ...sample, id: "chat_old" });
    await store.write({ ...sample, id: "chat_mid" });
    await store.write({ ...sample, id: "chat_new" });

    const base = Date.now() / 1000;
    const touch = (id: string, seconds: number) =>
      utimesSync(join(root, "conversations", `${id}.json`), base - 100 + seconds, base - 100 + seconds);
    touch("chat_new", 3);
    touch("chat_mid", 2);
    touch("chat_old", 1);

    expect((await store.list()).map((c) => c.id)).toEqual(["chat_new", "chat_mid", "chat_old"]);
  });

  it("list 在没有会话目录时返回空数组", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("read 遇到坏 JSON / 缺字段一律返回 null", async () => {
    mkdirSync(join(root, "conversations"), { recursive: true });
    writeFileSync(join(root, "conversations", "broken.json"), '{"id":"broken"', "utf-8");
    writeFileSync(join(root, "conversations", "shapeless.json"), '{"id":"x"}', "utf-8");

    expect(await store.read("broken")).toBeNull();
    expect(await store.read("shapeless")).toBeNull(); // messages 不是数组
    expect(await store.read("nope")).toBeNull(); // 根本不存在
  });

  it("remove / exists", async () => {
    await store.write(sample);
    expect(await store.exists("chat_1")).toBe(true);
    await store.remove("chat_1");
    expect(await store.exists("chat_1")).toBe(false);
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
    expect(statSync(join(root, "conversations", "项目", "a.json")).isFile()).toBe(true);
  });

  it("挡住路径穿越：绝对路径 / .. / . / 空段 / 反斜杠", async () => {
    for (const id of ["../escape", "a/../../b", "/abs", ".", "a//b", "a\\b", ""]) {
      await expect(store.write({ ...sample, id })).rejects.toThrow(/invalid conversation id/);
    }
    // read 走的是同一道检查，但错误被吞成 null（读不到就是读不到）
    expect(await store.read("../escape")).toBeNull();
  });
});
