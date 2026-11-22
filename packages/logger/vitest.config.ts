import { defineConfig } from "vitest/config";

/** 只收 `src/` 下的用例：这个包没有需要仓库外夹具的集成套件 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    isolate: false,
  },
});
