/**
 * 「纯边界」的**禁入包替身** —— 见 `tsconfig.pure.json`。
 *
 * ## 为什么需要这个文件而不是「把 paths 指向不存在的文件」
 *
 * `paths` 的替换**失败之后会回落到 node_modules**（实测 `tsc --traceResolution` 能看到那一步），
 * 所以「指到一个不存在的模块」根本不会报错 —— 那道门禁会永远绿。这里指向一个**存在、
 * 但什么都不导出**的声明文件：一旦 `session/stream.ts`（或它 import 的东西）引用
 * `@ai-zen/agents-server` / `agents-sdk` / `agents-testing`，`tsc` 立刻报 TS2305
 * 「模块没有导出成员 X」。
 *
 * ## 它不参与任何真实编译
 *
 * 只有 `tsconfig.pure.json` 的 `paths` 指向它；主 `tsconfig.json` 的 `include` 是 `src`，
 * 而它在包的根目录，所以构建、发布都不受影响（产物里没有它）。
 *
 * ## 唯一的盲点由用例补
 *
 * `import "@ai-zen/agents-server"`（只取副作用、一个导出都不要）在这里拿不到错误 —— 但它在
 * 纯状态机里没有任何意义，而且 `session/pure-boundary.test.ts` 会把 import 清单整段扫一遍，
 * 那种形状一样会被抓住。
 */
export type ForbiddenByPureBoundary = never;
