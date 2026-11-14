import { defineConfig } from "vitest/config";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "./.env.local") });

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // 与 sdk / host / cli 同口径：同进程内复用模块图（本包的依赖图被它们逐层 import，重载最贵）
    isolate: false,
  },
});
