import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    env: {
      // vitest 不自动加载 .env.local，手动指定
    },
  },
});
