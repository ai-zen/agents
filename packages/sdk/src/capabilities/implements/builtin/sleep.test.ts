import { describe, it, expect } from "vitest";
import { sleepTool } from "./sleep.js";

describe("sleepTool", () => {
  it("工具名称和描述正确", () => {
    expect(sleepTool.function.name).toBe("sleep");
    expect(sleepTool.function.description).toContain("等待");
    const params = sleepTool.function.parameters as Record<string, unknown>;
    expect(params.properties).toHaveProperty("ms");
    expect(params.required).toEqual(["ms"]);
  });

  it("等待指定毫秒数并返回成功", async () => {
    const start = Date.now();
    const result = await sleepTool.callback({ ms: 100 });
    const elapsed = Date.now() - start;

    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(true);
    expect(parsed.waitedMs).toBe(100);
    expect(elapsed).toBeGreaterThanOrEqual(80); // 允许少量误差
  });

  it("ms 为 0 时立即返回", async () => {
    const start = Date.now();
    const result = await sleepTool.callback({ ms: 0 });
    const elapsed = Date.now() - start;

    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(true);
    expect(parsed.waitedMs).toBe(0);
    expect(elapsed).toBeLessThan(50);
  });

  it("负数 ms 返回错误", async () => {
    const result = await sleepTool.callback({ ms: -1 });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("正整数");
  });

  it("非数字 ms 返回错误", async () => {
    const result = await sleepTool.callback({ ms: "abc" as unknown as number });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(false);
  });

  it("过长等待时间返回错误", async () => {
    const result = await sleepTool.callback({ ms: 600_000 });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("过长");
  });
});
