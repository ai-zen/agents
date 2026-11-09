import { defineConfig } from "vitest/config";

/**
 * 与 sdk 相反，这里**保持默认的隔离模式**。
 *
 * sdk 关掉隔离（`isolate: false`）是为了提速，前提是「测试不靠模块级 mock」。但隔离本身
 * 是一条隐形的纪律检查：模块一旦藏了进程级状态（全局路径、全局 locale、单例），隔离开着
 * 就会当场露馅，关着则会被前一个文件残留的状态蒙过去。本包的整个存在理由就是「局部可
 * 实例化」，故先用最严格的口径；等 `grep -rn "process\.cwd()\|AI_ZEN_DIR\|setLocale" src`
 * 长期为空之后，再考虑用隔离换速度。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
