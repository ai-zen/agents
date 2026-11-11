/**
 * 「纯边界」的机制（二）：`session/stream.ts` 的 **import 清单**必须落在白名单里。
 *
 * ## 为什么除了 `tsconfig.pure.json` 还要这一条
 *
 * 那个配置把 `@ai-zen/agents-server` 的**包根** / `agents-sdk` / `agents-testing` 映射到一个
 * 空声明文件，于是「具名 import」会编译不过。但它有形状上的漏口：`import "@ai-zen/agents-server"`
 * （只取副作用、一个导出都不要）在类型检查里什么错都没有。而「纯」这件事不该有形状上的例外
 * —— 一旦这类 import 进来了，这套状态机就再也起不了假时钟、测不了竞态。
 *
 * 所以这里读**源文件**、把 specifier 全抓出来逐个比对白名单。它比类型检查更粗，但正因为粗
 * 才没有漏口：任何新依赖（包括动态 `import()`）都会在这里变成一个具体的字符串。
 *
 * ## 白名单为什么是这三条
 *
 *   · `@ai-zen/agents-server/protocol` —— 线上契约的**类型面**（形状、名字、载荷）；只以
 *     `import type` 出现，编译后一行不剩；服务端本体（daemon / 存档 / 会话管理）不在这条图上；
 *   · `../stream-merge.js` —— 同一份合并规则（它自己也是纯的）；
 *   · `@ai-zen/agents-core` —— 本包在运行期就依赖它：折 chunk（`applyChunk`）、用量求和
 *     （`sumUsage`）、角色枚举（`AgentNS.Role`）都用它那一份，不抄镜像。它纯，是因为
 *     用到的这三个都是不碰 I/O 的值/函数（`dist/applyChunk.js` 连 import 都没有）；
 *   · 别的都不行：`node:fs` / `node:net` 是 I/O，`@ai-zen/agents-server`（包根）是 daemon 与存档，
 *     `agents-sdk` 会去读配置、建模型客户端。
 *
 * 判据是**运行期图**，不是包名：契约能进，是因为它的产物 import 图闭合在自身与 `node:*`
 * （`packages/protocol/README.md` 里有可跑的判据）；反过来说，哪天有人往 `src/` 里 import 了
 * 会碰 I/O 的东西，白名单这一条拦得住（specifier 变了），但拦不住同一个包内的行为变化 ——
 * 那种得看产物判据。
 *
 * ## 「不是永远绿」的自检
 *
 * 正则写错（比如把任何字符串都当成命中）会让这条用例永远通过 —— 所以第 2 条用例直接断言
 * 白名单**会拒绝**几个真实存在的坏依赖。门禁自己也要被钉住。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** 允许出现在纯状态机 import 图里的模块 */
const ALLOWED: RegExp[] = [
  /^@ai-zen\/agents-server\/protocol$/,
  /^\.\.\/stream-merge\.js$/,
  /^@ai-zen\/agents-core$/,
];

/** 把源文件里出现的模块 specifier 全抓出来（`from "x"`、`import "x"`、`import("x")` 三种形状） */
function importsOf(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) found.add(match[1]!);
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) found.add(match[1]!);
  for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) found.add(match[1]!);
  return [...found];
}

const isAllowed = (specifier: string): boolean => ALLOWED.some((rule) => rule.test(specifier));

describe("纯边界：SessionStream 的 import 清单", () => {
  it("只 import 白名单里的东西（想加新依赖，先回答「这层还纯吗」）", () => {
    const source = readFileSync(fileURLToPath(new URL("./stream.ts", import.meta.url)), "utf-8");
    const imports = importsOf(source);

    // 抓不到 import 就说明正则失效了 —— 那条断言本身也得能红
    expect(imports.length).toBeGreaterThan(0);
    // 命中不了任何一个不合法项：`filter` 出来必须为空
    expect(imports.filter((specifier) => !isAllowed(specifier))).toEqual([]);
    // 正向也钉一下：这两个是它现在真的需要的（正则漏抓会让上面两条都变成空断言）
    expect(imports).toContain("@ai-zen/agents-server/protocol");
    expect(imports).toContain("../stream-merge.js");
  });

  it("白名单本身会拒绝东西（否则这条门禁就是永远绿的）", () => {
    for (const forbidden of [
      "@ai-zen/agents-server",
      "@ai-zen/agents-sdk",
      "node:fs",
      "node:net",
      "./channel.js",
    ]) {
      expect(isAllowed(forbidden)).toBe(false);
    }
    expect(isAllowed("@ai-zen/agents-server/protocol")).toBe(true);
    expect(isAllowed("../stream-merge.js")).toBe(true);
    // core 只放行**包根**这一条：深路径（`@ai-zen/agents-core/dist/...`、`/Agent.js`）不认
    expect(isAllowed("@ai-zen/agents-core/Agent.js")).toBe(false);
  });
});
