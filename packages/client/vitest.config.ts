import { defineConfig } from "vitest/config";

/**
 * 与 server 同口径：**保持默认隔离**。
 *
 * 本包调用的正是服务端那些「不读进程级全局」的接口，隔离本身是最便宜的纪律检查；
 * 但真正的理由在下面这条 —— 用例会起**真 Daemon + 真 socket**，隔离能保证一个用例
 * 留下的发现文件 / 临时目录不会变成下一个用例的「环境」。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
