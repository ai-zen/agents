import { defineConfig } from "vitest/config";

/**
 * `isolate: false`：同进程内复用模块图。宿主的依赖图是最重的那一类（sdk / core / mcp sdk），
 * 59 个文件各重载一遍原本占掉整个套件的一大截。
 *
 * 代价和 cli / sdk 一样由用例自己承担：不用 `vi.mock`（按模块说明符全局注册，会串到别的
 * 文件）、不靠 `AI_ZEN_DIR` / 全局 locale 这类模块级状态跨文件、不从 `process.cwd()` 推路径
 * （一律从 `import.meta.url` 推包根）。违反了就是一例「单跑绿、合跑红」。
 *
 * 只收不依赖构建产物 / 子进程 / 端口的那些：`*.e2e.test.ts` 起真端口、写真实磁盘、连真
 * WebSocket，它们在 `vitest.e2e.config.ts`（`npm run test:e2e`），这里排除掉。
 * `src-bad/` 那两条旧用例（`serve.process.test.ts` / `host.integration.test.ts`）不在 `src/`
 * 下，本来就不进这个 glob。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "!src/**/*.e2e.test.ts"],
    isolate: false,
  },
});
