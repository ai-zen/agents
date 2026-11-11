/**
 * 地址与凭证的**同源解析**（D9）—— 「连哪儿 + 拿什么进门」这两个答案只在这一处产生。
 *
 * ## 为什么两件事必须同源
 *
 * 地址一旦能指向远端，凭证就**不可能**只来自本地文件：`--server https://your.domain/ai-zen`
 * 那台机器上的 `<aiZenDir>/run/token` 与它手里那把锁毫无关系。反过来，只把地址做成可配置、凭
 * 证仍然"就地读文件"，得到的是最难查的一种半远程状态 —— 连得上、握手被拒，而错误信息不说为
 * 什么。
 *
 * ## 凭证的来源是**三态**，不是布尔
 *
 * 「用了 `AI_ZEN_SERVER_TOKEN`」「用了本地文件」「**根本没有**凭证」是三种情形，三种修法。
 * 用一个 `fromLocalFile: boolean` 表达它们，必然把后两种压成同一个 `false`（本批修的 bug 就是
 * 这一压）：显式地址 + 本机没有凭证文件时，用户被告知「重启服务端」—— 而那台服务端根本不在他
 * 手里。所以 {@link ResolvedToken.source} 是判别依据，布尔只作兼容字段留着。
 *
 * ## 为什么**不做**静态的 loopback 判断来决定去哪读凭证
 *
 * 「本机就从文件读、远端就用环境变量」听起来很自然，但它认错了信号：隧道的入口恰恰是
 * `127.0.0.1:9999`（`ssh -L` / `kubectl port-forward` / tailscale serve 都是这样），从地址上
 * 根本分不出「本机 daemon」还是「隧道另一端」。所以这里一律**先按本地文件试**，失败时靠
 * {@link explainUnauthorized} 把那句话说到位 —— 两条路都可能通向同一个地址，唯一可靠的判据是
 * 服务端的回答。
 *
 * ## 纯的那一半与脏的那一半分开
 *
 * {@link readExplicitTarget} 是同步纯函数（只解析一行显式地址，不读任何文件），
 * {@link resolveToken} 才碰磁盘。这条边界让 `--server` 的解析可以在任何地方（包括配置面）用，
 * 而「读不到凭证」不会变成一次意外的 I/O。
 */

import type { ServerTarget } from "./wire/server-url.js";
import { parseServerUrl } from "./wire/server-url.js";
import { readToken, tokenPath } from "./wire/token.js";
import { codeOf } from "./wire/errors.js";

export interface ServerTargetSource {
  /** 配置根目录（`AI_ZEN_DIR`）。凭证文件与发现文件都在它的 `run/` 下 */
  aiZenDir: string;
  /** 显式地址原始串（来自 `--server` 或 `AI_ZEN_SERVER_URL`）；空 = 走发现文件 */
  serverUrl?: string;
  /** 显式凭证（`AI_ZEN_SERVER_TOKEN`） */
  serverToken?: string;
}

/**
 * 只解析**显式地址**：同步、纯，不读任何文件。没有显式地址返回 `null`。
 *
 * `serverUrl` 只有空白（`AI_ZEN_SERVER_URL=""` / `"  "`）时同样算「没有」：环境变量被置空是
 * 「别用它」的常见写法，把它当成一个非法地址去抛错，只会让一句 `AI_ZEN_SERVER_URL= ai` 报
 * 「不是合法的服务端地址」。
 *
 * 返回的 `token` 是**显式凭证**（`AI_ZEN_SERVER_TOKEN`），不是文件里那一份 —— 这个函数不碰磁
 * 盘。要不要退回文件由 {@link resolveToken} 决定。
 *
 * @throws 显式地址不是合法 URL / scheme 不在四种里（错误信息带原值，见 `parseServerUrl`）
 */
export function readExplicitTarget(
  source: ServerTargetSource,
): { address: ServerTarget; token: string | null } | null {
  const raw = source.serverUrl?.trim() ?? "";
  if (raw === "") return null;
  return { address: parseServerUrl(raw), token: nonEmpty(source.serverToken) };
}

/**
 * 凭证的**来源** —— 三态，与修法一一对应（各对应哪一句话见 {@link explainUnauthorized}）：
 *
 * - `explicit`：`AI_ZEN_SERVER_TOKEN` 给的，改的是**那台服务端上的凭证**；
 * - `local-file`：`<aiZenDir>/run/token` 给的，对面可能不是本机 daemon，要另设环境变量；
 * - `none`：没有任何凭证，唯一要做的是**设** `AI_ZEN_SERVER_TOKEN`。
 */
export type TokenSource = "explicit" | "local-file" | "none";

/** {@link resolveToken} 的返回值：一串凭证 + 它是从哪来的 */
export interface ResolvedToken {
  /** 这次要递出去的凭证；`null` = 没有任何凭证可用 */
  token: string | null;
  /** 它从哪来 —— **唯一**可以用来区分那三种情形的字段 */
  source: TokenSource;
  /**
   * `source === "local-file"` 的缩写，只为兼容旧调用点而留着。
   *
   * @deprecated 别再用它做判断：布尔只有两格而情形有三格，`false` 同时代表「显式凭证」与「没
   * 有凭证」—— 本批的 bug（显式地址 + 本机无凭证时建议「重启服务端」）就出在这一压上。新逻辑
   * 一律读 {@link ResolvedToken.source}。
   */
  fromLocalFile: boolean;
}

/**
 * 取凭证：显式凭证（`AI_ZEN_SERVER_TOKEN`）> `<aiZenDir>/run/token` > 没有，并报告**来源**。
 *
 * 返回值里那句 `source` 是 {@link explainUnauthorized} 选措辞的唯一依据 —— 「对面可能不是本机
 * daemon」与「本机压根没有凭证」是两句完全不同的话，靠布尔分不开（理由见文件头）。
 */
export async function resolveToken(source: ServerTargetSource): Promise<ResolvedToken> {
  const explicit = nonEmpty(source.serverToken);
  if (explicit) return { token: explicit, source: "explicit", fromLocalFile: false };

  const local = await readToken(source.aiZenDir);
  return local
    ? { token: local, source: "local-file", fromLocalFile: true }
    : { token: null, source: "none", fromLocalFile: false };
}

/**
 * `unauthorized` 翻成**对症**的话；其余错误原样返回。
 *
 * 同一个 `unauthorized` 有四种成因，修法互不相干 —— 判据是「地址是谁给的」×「凭证从哪来」：
 *
 *   1. **非显式地址**（发现文件那条路）—— 服务端就在本机，它手上那串与本机文件对不上（比如另
 *      一份凭证在跑）；重启本端服务端就会重新对齐；
 *   2. **显式地址 + `AI_ZEN_SERVER_TOKEN`** —— 这串是用户给的，被那台服务端拒了；要去**那台
 *      服务端上**核对凭证（「重启」在这里是错的方向：重启的机器根本没读过这串凭证）；
 *   3. **显式地址 + 本地文件那串凭证** —— 对面很可能根本不是本机 daemon（SSH 转发 / nginx /
 *      tailscale 隧道），要改的是**凭证从哪来**：设 `AI_ZEN_SERVER_TOKEN`；
 *   4. **显式地址 + 完全没有凭证** —— 本机上没有任何东西可以试（连文件都不存在），所以唯一
 *      的动作就是**设** `AI_ZEN_SERVER_TOKEN`。这一支从前被压进第 1 条，是本批修的 bug。
 *
 * 措辞在这里定，因为它只该有一份：CLI、桌面端、`status` 三处都要说同一句话，各写一遍必然分成
 * 三种说法。
 *
 * ## 为什么每句话里必须印**真实路径**，而不是 `<aiZenDir>/run/token` 这个占位符
 *
 * 这几句话的用途只有一个：告诉人去**哪儿看 / 改 / 拄**那一份凭证。而 `aiZenDir` 是**可被自定义**的
 * （`AI_ZEN_DIR`，CLI 与桌面端都可能改过），所以占位符印出来的那一刻，最后一步又被推回给用户
 * —— 他还得自己猜「这个进程眼里的 `aiZenDir` 到底解析成了什么」，而那恰恰是他此刻最没有信息的
 * 一件事（服务端跑在另一个 `--ai-zen-dir` 下时尤其如此）。因此 `ctx` 给了 `aiZenDir` 就用
 * {@link tokenPath} 算出真路径（路径怎么拼只由那一处决定，这里不许自己拼字符串），只有调用方
 * 确实没有这个上下文时才退回占位符。
 *
 * **不是 `unauthorized` 的错误原样返回**（连对象都不换）：调用方 `catch` 拿到的还是它抛出来的
 * 那一个 —— 包一层新 `Error` 会把 `code`、`cause`、栈全部换成「这里」，而真正的失败点在别处。
 */
export function explainUnauthorized(
  error: unknown,
  ctx: {
    /** 地址是显式给的（`--server` / `AI_ZEN_SERVER_URL`）还是从发现文件读的 */
    explicit: boolean;
    /** 凭证来源（`resolveToken` 的 `source`）—— **不许**用 `fromLocalFile` 那种布尔代替 */
    source: TokenSource;
    serverUrl?: string;
    /**
     * 配置根目录（`AI_ZEN_DIR`）。给了就把**真路径**印进提示（理由见上文）；空串算「没给」
     * —— 它不是一条路径，拼出来会是一句没有根目录的残句。
     */
    aiZenDir?: string;
  },
): Error {
  if (codeOf(error) !== "unauthorized") {
    // 不是鉴权失败：原样返回（非 Error 的抛出值兜一下，别让返回值违反签名）
    return error instanceof Error ? error : new Error(String(error));
  }

  const original = error instanceof Error ? error.message : String(error);
  const at = ctx.serverUrl?.trim();
  // 地址是**第一信息**：远程排障时「我在连谁」决定了下一条命令在哪台机器上敲
  const atText = at ? `地址 ${at} 上` : "这个地址上";
  // 真路径优先（`tokenPath` 是位置约定的唯一实现处）；拿不到 `aiZenDir` 才印占位符
  const tokenAt = ctx.aiZenDir ? tokenPath(ctx.aiZenDir) : "<aiZenDir>/run/token";

  // 凭证串本身**永不回显**：这些话会被贴进 issue、进日志，而它是一把钥匙
  let message: string;
  if (!ctx.explicit) {
    // 1. 发现文件那条路：服务端就在本机，重启就能重新对齐（`start()` 会重读那一份）
    message =
      `unauthorized: 服务端手上的凭证与 ${tokenAt} 不一致（可能是另一份凭证在跑）—— ` +
      `重启服务端即可重新对齐（原消息：${original}）`;
  } else if (ctx.source === "explicit") {
    // 2. 显式凭证被拒：「重启服务端」在这里指错了机器（那台机器没读过这串凭证），
    //    要说的只是「去那台上核对凭证本身」
    message =
      `unauthorized: ${atText}的服务端不认这串凭证 —— 它是 AI_ZEN_SERVER_TOKEN 给的，` +
      `请到那台服务端上核对它的凭证本身` +
      (ctx.aiZenDir ? `（本机的 ${tokenAt} 与这次无关，改它没有用）` : "") +
      `（原消息：${original}）`;
  } else if (ctx.source === "local-file") {
    // 3. 显式地址 + 本地文件那串：对面很可能不是本机 daemon（D9），要改的是凭证从哪来
    message =
      `unauthorized: ${atText}可能不是本机 daemon —— ` +
      `此刻用的凭证是 ${tokenAt} 里那一份；若是 SSH 转发 / nginx / tailscale 隧道，` +
      `请设 AI_ZEN_SERVER_TOKEN（原消息：${original}）`;
  } else {
    // 4. 显式地址 + 没有任何凭证：本机连一份都没得试（文件都不在），只能显式设一个
    message =
      `unauthorized: ${atText}的服务端要凭证，而本机没有任何凭证可用` +
      `（AI_ZEN_SERVER_TOKEN 没设，${tokenAt} 也不存在）—— ` +
      `若是 SSH 转发 / nginx 反代 / tailscale 隧道，两头就不是同一台机器，` +
      `必须显式设 AI_ZEN_SERVER_TOKEN，值取自服务端那台机器上的 ${tokenAt}` +
      `（原消息：${original}）`;
  }

  // 码留着：上层（会话层 / 重连判定）仍然要能认出「这是鉴权失败」这件事
  return Object.assign(new Error(message), { code: "unauthorized" });
}

/** 空白 = 没有（`AI_ZEN_SERVER_TOKEN=" "` 不该变成一个「值是一格空格」的凭证） */
function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}
