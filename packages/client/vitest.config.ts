import { defineConfig } from "vitest/config";

/**
 * `isolate: false`：同进程内复用模块图，与 sdk / host / cli 同口径。
 *
 * 本包的用例会起**真 Daemon + 真 socket**，所以每个用例自己负责把自己的发现文件、临时目录
 * 收干净（`mkdtemp` 出来、`afterEach` 删掉），不指望「反正下一个用例是新的进程」。
 * 一旦有模块级状态被留在进程里，症状就是「单跑绿、合跑红」。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    isolate: false,
  },
});
