import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import {
  DEFAULT_MAX_TOOL_OUTPUT,
  guardOutput,
  headPreview,
  headTailPreview,
} from "./outputGuard.js";

describe("outputGuard", () => {
  it("缺省上限为 32768 字符", () => {
    expect(DEFAULT_MAX_TOOL_OUTPUT).toBe(32_768);
  });

  it("未超限时原样返回内容，不落盘", async () => {
    let dumpCalled = false;
    const content = { stdout: "ok", stderr: "" };

    const result = await guardOutput({
      tool: "unit",
      content,
      isOverLimit: () => false,
      dump: () => {
        dumpCalled = true;
        return [];
      },
      buildWarning: () => "warning",
    });

    expect(result).toBe(content);
    expect(dumpCalled).toBe(false);
  });

  it("超限时落盘并返回 buildWarning 结果，写入内容完整", async () => {
    const text = "x".repeat(5000);

    const result = (await guardOutput({
      tool: "unit",
      content: text,
      isOverLimit: () => true,
      dump: () => [{ name: "out.log", content: text }],
      buildWarning: (ctx) => JSON.stringify(ctx.files),
    })) as string;

    const filePath = JSON.parse(result)["out.log"] as string;
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe(text);
    expect(filePath.startsWith(tmpdir())).toBe(true);
    expect(filePath).toContain("ai-zen");
    expect(filePath).toContain("unit-");
  });

  it("超限但未提供 dump 时只警告、不落盘", async () => {
    const result = await guardOutput({
      tool: "unit",
      content: "big",
      isOverLimit: () => true,
      buildWarning: (ctx) => JSON.stringify(ctx),
    });

    expect(JSON.parse(result as string)).toEqual({ dir: null, files: {} });
  });

  it("每次调用使用独立目录，互不覆盖", async () => {
    const run = async (): Promise<string> => {
      const result = (await guardOutput({
        tool: "unit",
        content: "big",
        isOverLimit: () => true,
        dump: () => [{ name: "out.log", content: "big" }],
        buildWarning: (ctx) => JSON.stringify(ctx.files),
      })) as string;
      return JSON.parse(result)["out.log"] as string;
    };

    const first = await run();
    const second = await run();
    expect(first).not.toBe(second);
  });

  it("落盘文件内容与 dump 顺序一致", async () => {
    const result = (await guardOutput({
      tool: "unit",
      content: "big",
      isOverLimit: () => true,
      dump: () => [
        { name: "stdout.log", content: "OUT" },
        { name: "stderr.log", content: "ERR" },
      ],
      buildWarning: (ctx) => JSON.stringify(ctx.files),
    })) as string;

    const files = JSON.parse(result) as Record<string, string>;
    expect(Object.keys(files)).toEqual(["stdout.log", "stderr.log"]);
    expect(readFileSync(files["stdout.log"], "utf-8")).toBe("OUT");
    expect(readFileSync(files["stderr.log"], "utf-8")).toBe("ERR");
  });

  describe("headPreview", () => {
    it("短文本不省略，head 为全文", () => {
      expect(headPreview("abc", 1000)).toEqual({ head: "abc", omitted: 0 });
    });

    it("长文本只取头部 size 字符并给出省略数", () => {
      const text = "a".repeat(1500);
      const preview = headPreview(text, 1000);
      expect(preview.head).toBe("a".repeat(1000));
      expect(preview.omitted).toBe(500);
    });
  });

  describe("headTailPreview", () => {
    it("短文本不省略，head 为全文", () => {
      expect(headTailPreview("abc", 1000)).toEqual({ head: "abc", tail: "", omitted: 0 });
    });

    it("长文本取头尾各 size 字符并给出省略数", () => {
      const text = "a".repeat(1000) + "-".repeat(500) + "b".repeat(1000);
      const preview = headTailPreview(text, 1000);
      expect(preview.head).toBe("a".repeat(1000));
      expect(preview.tail).toBe("b".repeat(1000));
      expect(preview.omitted).toBe(500);
    });
  });
});
