import { defineConfig } from "vitest/config";

/**
 * `isolate: false`：同进程内复用模块图。宿主的依赖图是最重的那一类（sdk / core / mcp sdk），
 * 59 个文件各重载一遍原本占掉整个套件的一大截。
 *
 * 代价和 cli / sdk 一样由用例自己承担：不用 `vi.mock`（按模块说明符全局注册，会串到别的
 * 文件）、不靠 `AI_ZEN_DIR` / 全局 locale 这类模块级状态跨文件、不从 `process.cwd()` 推路径
 * （一律从 `import.meta.url` 推包根）。违反了就是一例「单跑绿、合跑红」。
 *
 * 只收「不依赖构建产物 / 子进程 / 端口」的那些：两条真进程用例在 `vitest.e2e.config.ts`
 * （`npm run test:e2e`），它们要能写盘、能编译。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "!src/serve.process.test.ts", "!src/host.integration.test.ts"],
    isolate: false,
  },
});
