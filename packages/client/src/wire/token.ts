/**
 * 凭证的**读端** —— 「这个 `aiZenDir` 的凭证住在哪、里面是什么」的唯一真相源。
 *
 * 位置与服务端一致：`<aiZenDir>/run/token`（服务端 `start()` 时读或生成，见服务端那份
 * `wire/token.ts`）。与发现文件（`wire/discovery.ts` 的 `run/server.json`）**同目录、同一条
 * 「每次现拼路径」的写法**：地址与凭证是同一个问题的两半（连哪儿 + 拿什么进门），客户端多读
 * 一次文件，但不该多知道一个目录约定 —— 多出来的目录约定正是「本地能跑、远程就跑不起来」那类
 * 错。
 *
 * ## 只读，不写
 *
 * 客户端**不许**生成凭证：写端只有服务端一个（`ensureToken`），客户端也生成的话，两个进程会
 * 各自写一份、各自认为自己是那把锁 —— 而症状是「刚连上就被 `unauthorized`」。
 *
 * ## 为什么读不出来一律返回 `null`
 *
 * 「文件不在」是正常状态（服务端从没在这台机器上跑过），不是异常。上层要的是「有没有」这个答
 * 案，然后由 {@link import("../resolve-target.js").resolveToken} 决定是退回显式凭证还是干脆
 * 没有；在这里抛错，等于让「第一次启动」变成一条要 `try` 的失败路径。
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * 凭证文件路径（每次现拼：`aiZenDir` 会变，模块顶层算出来就是快照）。
 *
 * 文件名就叫 `token`：目录已经说明了它的归属，`run/auth-token.txt` 那样的名字只会让人以为里
 * 面还有第二种凭证。
 */
export function tokenPath(aiZenDir: string): string {
  return join(aiZenDir, "run", "token");
}

/**
 * 读凭证；不存在 / 读不出来 / 内容为空一律返回 `null`。
 *
 * 前后空白会被去掉：这个文件是路径下的明文，被 `echo` 追加过一个换行之类的事一定会发生，而那
 * 一行空白不该让整台机器连不上（与服务端的 `readToken` 同一条口径 —— 两边对一个文件的读法必须
 * 一样，否则「服务端认为自己存的是 X、客户端认为自己读到的是 `X\n`」）。
 */
export async function readToken(aiZenDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(tokenPath(aiZenDir), "utf-8");
    const token = raw.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
