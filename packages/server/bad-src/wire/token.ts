/**
 * 访问凭证 —— 「这个端口归谁用」这件事的唯一真相源。
 *
 * 位置：`<aiZenDir>/run/token`（`aiZenDir` 由**调用方注入**，本模块不读任何全局路径）。
 * 内容是服务端自己生成的一串不透明随机字节（`crypto.randomBytes(32)` → base64url，43 字符），
 * 没有结构、没有对端、也没有撤销名单 —— 它只是一个「你手上有这把钥匙吗」的答案。
 *
 * ## 为什么放 `run/` 下
 *
 * `run/` 已经是「这个正在跑的进程」的目录：`server.json`（发现文件）就住在这里，同一个
 * `aiZenDir` 下的客户端本来就会来这里找「服务端在哪」。凭证与地址是**同一个问题的两半**
 * （连哪儿 + 拿什么进门），客户端要多一次文件读取，但不必多知道一个目录约定 —— 而多出来
 * 的目录约定，正是那一类「本地能跑、远程就跑不起来」的错。
 *
 * ## 为什么不进 `server.json`
 *
 * 那个文件是**诊断用**的：用户报障时会 `cat ~/.ai-zen/run/server.json`，然后把它整个贴进
 * issue / 聊天窗口。地址、pid、版本贴出去都没关系，凭证贴出去等于把端口交出去。所以凭证
 * 单开一个文件，而且权限是 0600 —— 顺手 `cat` 一下这个文件的代价是零，把它贴出去的代价
 * 不该由「记得别贴」来兜。
 *
 * ## 为什么是单独一个 0600 文件，而不是复用别的什么
 *
 *   · `config.json` —— 那是用户手改的配置（会进 git、会被同步、会被备份），凭证放进去
 *     就等于把它散布到那些地方；
 *   · 环境变量 / 进程参数 —— 会进 `ps` 输出与 shell 历史；
 *   · 一个随进程存亡的内存值 —— 客户端（另一个进程）读不到，那就只能靠调用方每次注入。
 *
 * 文件同时解决「谁生成」与「谁知道」：服务端 `start()` 时读或生成（见 `ensureToken`），
 * 客户端按同一个路径读。**本机场景不需要任何人手动搬运它**。
 *
 * ## 写法的两条要点
 *
 *   · **原子**：先写 `.tmp` 再 `rename`，与发现文件（`discovery.ts` 的 `writeDescriptor`）
 *     同一手法 —— 客户端永远不会读到半个 token；
 *   · **0600**：`mode` 在 `writeFile` 里只对「这次新建的文件」生效，`.tmp` 若是上一轮崩溃
 *     留下的，权限不会自己变回 0600，所以再显式 `chmod` 一次。
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 凭证文件路径（每次现拼：`aiZenDir` 会变，模块顶层算出来就是快照）。
 *
 * 文件名就叫 `token`：目录已经说明了它的归属，`run/auth-token.txt` 那样的名字只会让人
 * 以为里面还有第二种凭证。
 */
export function tokenPath(aiZenDir: string): string {
  return join(aiZenDir, "run", "token");
}

/**
 * 读凭证；不存在 / 读不出来 / 内容为空一律返回 `null`（视为「还没有凭证」）。
 *
 * 不抛错：调用方（`Daemon.start()` 与客户端）要的都是「有没有」这个答案，
 * 「文件不在」是正常状态（第一次启动之前就是它），不是异常。
 *
 * 前后空白会被去掉：这个文件是给人看的路径下的明文，被 `echo` 追加过一个换行之类的事
 * 一定会发生，而那一行空白不该让整台机器连不上。
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

/**
 * 取凭证：**有就复用，没有就生成**（服务端 `start()` 时调）。
 *
 * 复用是硬要求：每启动一次就换一串的话，一个已经连着的长连接客户端会在下一次重连时突然
 * 被拒 —— 而用户什么都没改。凭证的生命周期比进程长，它就是「这台机器上的这个 `aiZenDir`
 * 归谁用」。
 *
 * 生成的形状：32 字节随机 → base64url（43 字符）。32 字节是「猜不出来」这一条的全部要求
 * （256 bit）；base64url 则是因为它会出现在环境变量、URL、以及用户手抄的地方，不能有需要
 * 转义或引起来的字符。
 */
export async function ensureToken(aiZenDir: string): Promise<string> {
  const existing = await readToken(aiZenDir);
  if (existing) return existing;

  const token = randomBytes(32).toString("base64url");
  const file = tokenPath(aiZenDir);
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, token, { encoding: "utf-8", mode: 0o600 });
  // `mode` 只对「这次新建的文件」有效：`.tmp` 若是上一轮留下的（进程被杀在 rename 之前），
  // 它的权限不会被 `writeFile` 改回 0600 —— 显式 chmod 一次，别让一次崩溃留下一个 644 的
  // 凭证文件。
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
  return token;
}
