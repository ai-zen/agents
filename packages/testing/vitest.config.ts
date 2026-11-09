import { defineConfig } from "vitest/config";

/**
 * 这个包自己也要有测试。
 *
 * 它是**测试件**：一旦它悄悄坏了（少发一片、`[DONE]` 忘了、`usage` 挂错位置），下游那些
 * 用它写的集成用例会变绿得毫无意义 —— 假件坏掉时最糟的结果不是红灯，是**绿灯**。所以
 * 先钉住它自己的外部行为（SSE 帧形状 / 一次性 JSON / 错误码），再让下游放心用。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
