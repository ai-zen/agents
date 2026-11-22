import { defineConfig } from "vitest/config";

/**
 * 这个包自己也要有测试：它是「模型提供方」的替身，坏掉时下游那些用例不会变红，只会失去意义。
 * 先钉住它自己的外部行为（分片序列、SSE 帧形状、一次性 JSON、错误与断流），再用它。
 *
 * `isolate: false`：同进程内复用模块图，与 sdk / host / client 同口径。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    isolate: false,
  },
});
