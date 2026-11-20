import { defineConfig } from "vitest/config";

/**
 * 真端口那一组（`npm run test:e2e`）：`src/app.e2e.test.ts` 一条 —— 起一个真的宿主、用真的 ws
 * 客户端连上去、对着一个本地的 OpenAI 兼容端点要一句流回来的回答，数据根是临时目录。
 *
 * 从默认套件里分出来的理由是**前置条件**：它不只看仓库内容，还要能绑端口、能写真实磁盘。
 * `npm test` 该是一条只看仓库的门禁（发版前 `prepublishOnly` 走的正是它）。
 *
 * `isolate: false` 与默认套件同口径。
 */
export default defineConfig({
  test: {
    isolate: false,
    include: ["src/app.e2e.test.ts"],
  },
});
