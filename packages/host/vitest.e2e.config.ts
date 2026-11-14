import { defineConfig } from "vitest/config";

/**
 * 真进程那一组（`npm run test:e2e`）：两条用例各自跑一次真的 `tsc`（产物分别是 `dist/` 与
 * `.dist-it/`），再起真子进程 + 真 WebSocket。
 *
 * 从默认套件里分出来的理由是**前置条件**：它们不只看仓库内容，还要能写盘、能起子进程、能编译。
 * `npm test` 该是一条只看仓库的门禁（发版前 `prepublishOnly` 走的正是它）。
 *
 * `isolate: false` 与默认套件同口径。
 */
export default defineConfig({
  test: {
    isolate: false,
    include: ["src/serve.process.test.ts", "src/host.integration.test.ts"],
  },
});
