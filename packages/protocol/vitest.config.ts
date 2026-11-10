import { defineConfig } from "vitest/config";

/**
 * 与 server / client 同口径：**保持默认隔离**（一个用例文件一个 worker）。
 *
 * 本包的用例动的是真磁盘（发现文件用 `mkdtemp`）与真 socket（`call-once` 的用例自己起
 * 一个只认握手 + 一帧的假服务端）。隔离能保证一个用例留下的临时目录 / 端口不会变成
 * 下一个用例的「环境」—— 共享 worker 时这类泄漏会表现成偶发失败，最难查。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
