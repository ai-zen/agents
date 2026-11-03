import { defineConfig } from "vitest/config";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

/**
 * `isolate: false`：同进程内复用模块图，省掉每个测试文件重复的 transform / import
 * （此前占掉约 6s，总耗时 14.9s → 4.3s）。
 *
 * 前提是测试不靠模块级 `vi.mock("openai")` 这类手段打穿依赖——出网动作统一走
 * `ToolEnv.deps`（`upload` / `generateImage`）注入，见 src/types/index.ts 的 ToolEnvDeps。
 * 若某个测试又引入了对共享模块的 `vi.mock`，请优先改成依赖注入，而不是退回隔离模式。
 */
export default defineConfig({
  test: {
    // 默认套件只收「不依赖仓库外夹具 / 真实 API / 本机服务」的用例：
    // e2e-*.test.ts 需要 API Key、真实网络或本机 MCP 服务，放到 `npm run test:e2e`。
    // 干净 clone 上 `npm test`（以及挂在它后面的 prepublishOnly）必须只取决于仓库内容。
    include: ["src/**/*.test.ts", "test/integration.test.ts"],
    isolate: false,
  },
});
