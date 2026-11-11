/**
 * 「上次连的是哪台」—— 一份连接配置的**读写、校验与措辞**。
 *
 * ## 为什么它在包里，而不在各前端
 *
 * CLI 与桌面端都要记住同一件事：用户选的是「本机」还是「某台远程」，选远程时地址与凭证是
 * 什么。这套东西的每一行都是踩出来的：`0600`（文件里有凭证）、`.tmp` → `rename`（进程被杀
 * 不留半个 JSON）、读不炸（坏文件不该让应用起不来）、`local` 模式必须吐 `undefined` 而不
 * 是空串（空串在客户端包里的语义是「显式给了个空值」）。写第二份的下场是**其中一份先修**：
 * 一端手上是 `0600`、另一端是 `0644`，而症状要等到某天 `ps`/`cat` 之后才知道。
 *
 * 所以这个文件是「怎么记住一次连接」的**唯一实现**，两个前端只负责决定**落在哪个文件名**
 * （{@link connectionSettingsPath} 的 `client` 参数）与**什么时候写**。
 *
 * ## 为什么两个前端不共用一份文件
 *
 * `cli/connection.json` 与 `desktop/connection.json` 分开存：这两个客户端可能在两台机器上，
 * 也可能在同一台上连着**不同**的服务端。「我这个终端连哪台」与「我的桌面端连哪台」是两件事。
 * 共用的只有 `<aiZenDir>/run/` 下那两样（发现文件与凭证）—— 那是**这台机器**的事实。
 *
 * ## 「没配过」是一个**独立的事实**，不是某个默认值
 *
 * {@link readConnectionSettings} 在没有可用配置时返回 `null`，而不是 `{ mode: "local" }`。
 * 用默认值兜底会把三种情形压成两格（没配过 / 配过本地 / 配过远程 → 只剩后两格的其中一格），
 * 于是「首次启动该进引导屏」这条判据**做不出来** —— 首启会被当成「用户选过本地」，直接拉起
 * 一个服务端。这和 `resolve-target.ts` 里那个「两格布尔装不下三种凭证来源」是同一型病。
 *
 * 坏 JSON / 字段不合法同样返回 `null`（与「文件不在」同一类事实：这份配置不可用），**绝不
 * 抛错** —— 一个手滑的文件不该变成「双击没反应」。
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { parseServerUrl } from "./wire/server-url.js";

/** `local` = 本机（发现文件 + 本机 `run/token`）；`remote` = 用户填的那台 */
export type ConnectionMode = "local" | "remote";

/** 哪个客户端的配置——决定落点，不影响内容 */
export type ConnectionClient = "cli" | "desktop";

/**
 * 一份连接配置。
 *
 * ## `local` 模式下那两个值必须是 `undefined`，不是空字符串
 *
 * 客户端把空串当成「显式给了一个空值」（于是它不会退回发现文件 / 本机 `run/token`），只有
 * `undefined` 才表示「按老路走」。这条口径由 {@link connectionSettingsToTarget} 保证。
 */
export interface ConnectionSettings {
  /** `local` = 老路：地址读 `<aiZenDir>/run/server.json`，凭证读 `<aiZenDir>/run/token` */
  mode: ConnectionMode;
  /** 仅 `remote` 有意义：显式地址（`ws:` / `wss:` / `http:` / `https:`） */
  serverUrl?: string;
  /** 仅 `remote` 有意义：显式凭证。留空 = 退回 `<aiZenDir>/run/token`（本地兜底那条路） */
  serverToken?: string;
}

/**
 * 落点：`<aiZenDir>/<client>/connection.json`。
 *
 * 放在各自的子目录下而不是根下：根下（`config.json` / `agents/` / `workspaces/` / `run/`）
 * 全是**服务端的事实**，客户端往里写东西会模糊那条边界；`cli/` / `desktop/` 一眼就是「这个
 * 客户端自己的」。
 */
export function connectionSettingsPath(aiZenDir: string, client: ConnectionClient): string {
  return join(aiZenDir, client, "connection.json");
}

/**
 * 读配置：**没配过返回 `null`**（文件不在 / 坏 JSON / 字段不合法），任何情况下不抛。
 *
 * 参数是**文件路径**而不是 `aiZenDir`：两个前端各拼各的（见 {@link connectionSettingsPath}），
 * 用例也能直接指到临时文件上。这条函数不关心「谁在叫我」。
 */
export async function readConnectionSettings(file: string): Promise<ConnectionSettings | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    // 文件不在是**正常状态**：第一次启动之前就是它
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 坏 JSON（手改坏了、写到一半被 kill）：当作没有配置，别让应用起不来
    return null;
  }

  return normalizeStored(parsed);
}

/**
 * 写配置：**先写 `.tmp` 再 `rename`**，权限 `0600`。
 *
 * 关键在 `rename`：同一个文件系统内的 rename 是原子的，所以读方要么看到旧内容、要么看到
 * 新内容，永远看不到半份。`mode` 只在「这次新建的文件」上生效，`.tmp` 若是上一轮崩溃留下的
 * （进程被杀在 rename 之前），它的权限不会自己变回 0600 —— 所以再显式 `chmod` 一次，与
 * `agents-server` 的 `wire/token.ts` 逐字同一手法。
 *
 * 校验不在这里做：本函数只负责「把给我的这份写下去」。校验在 {@link parseConnectionSettings}
 * （表单 / IPC 边界）与 {@link readConnectionSettings}（读路径）—— 一处负责「收进来的」，
 * 一处负责「读回来的」，写只负责落地。
 */
export async function writeConnectionSettings(
  file: string,
  settings: ConnectionSettings,
): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });

  const tmp = `${file}.tmp`;
  // 末尾留一个换行：这份文件可能被人 `cat` / 手改，一行结束得像个文本文件
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  await fs.writeFile(tmp, content, { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

/**
 * 把一份**外来**的设置校验成可落盘的那一份（表单 / IPC 边界用）。
 *
 * 与读路径的区别是**失败方式**：读路径上「不可用」= `null`（应用要继续启动）；保存路径上
 * 「不可用」= 抛人话（用户刚刚在面板里敲的，静默改掉他的输入比报错更糟）。
 *
 * 校验规则：
 *
 *   · `mode` 只能是 `local` / `remote`；
 *   · `remote` 必须有地址，而且必须是 `parseServerUrl` 认得的地址；
 *   · `local` 下 `serverUrl` / `serverToken` **不被使用**（{@link connectionSettingsToTarget}
 *     对 `local` 一律给连接层 `undefined`）。本函数对它们**只照存、不主动抹**：入参里带了
 *     就照抄进返回值。但**落盘是整份替换、不是合并**，所以**调用方不传 = 从盘上清掉这两个
 *     字段**。界面在 `local` 下只发 `{ mode: "local" }`，于是实际行为是「切到本地并保存 →
 *     远端地址与凭证从盘上消失」。这是**有意的**（切到本地 = 不再用那台远程机，没必要把凭证
 *     留在盘上），不是「保留」承诺 —— 想让它们留下的调用方得自己传；
 *   · `serverToken` 允许留空（空 = 用本机 `run/token`，是一条明文支持的路，不许在校验里禁掉）。
 */
export function parseConnectionSettings(raw: unknown): ConnectionSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("连接设置必须是一个对象");
  }
  const input = raw as Partial<ConnectionSettings>;
  if (input.mode !== "local" && input.mode !== "remote") {
    throw new Error(
      `连接设置里的 mode 只能是 local 或 remote（收到：${JSON.stringify(input.mode)}）`,
    );
  }

  const serverUrl = trimmed(input.serverUrl);
  const serverToken = trimmed(input.serverToken);

  if (input.mode === "remote") {
    if (!serverUrl) {
      throw new Error("选了远程模式，但没填服务端地址");
    }
    // 地址的合法性只问那一个实现（错误信息里带原串，用户认得出自己填了什么）
    parseServerUrl(serverUrl);
  }

  return {
    mode: input.mode,
    ...(serverUrl ? { serverUrl } : {}),
    ...(serverToken ? { serverToken } : {}),
  };
}

/**
 * 一份设置 → 递给连接层的两个值（`serverUrl` / `serverToken`）。
 *
 * ## 这就是「`local` 传 `undefined` 而不是空串」的唯一实现处
 *
 * 客户端把空串理解成「显式给了一个空值」：给了空地址 ⇒ 不走发现文件；给了空凭证 ⇒ 不退回
 * `run/token`。所以 `local` 模式下这里必须吐出 `undefined`，而「两个字段都是空串」也得同样
 * 折成 `undefined`。
 *
 * 输入在保存时已校验、读回时已归一化，这里只做映射，不再判合法性。
 */
export function connectionSettingsToTarget(settings: ConnectionSettings): {
  serverUrl?: string;
  serverToken?: string;
} {
  if (settings.mode !== "remote") {
    // `local` = 老路：两个值都是「没给」，而不是「给了空的」
    return { serverUrl: undefined, serverToken: undefined };
  }
  return {
    serverUrl: trimmed(settings.serverUrl),
    serverToken: trimmed(settings.serverToken),
  };
}

/**
 * 界面上那一行字（`本机服务端` / 那个地址）。
 *
 * 界面不许自己拼地址、也不许猜模式（`local` / `remote` 是配置的事实）：这就是它该显示的那
 * 一行。**它绝不包含凭证** —— 地址里的 userinfo 会被抹掉（{@link stripUserInfo}），因为有人
 * 会把钥匙写进地址（`wss://token@host`），而这一行要上屏。
 */
export function connectionLabel(settings: ConnectionSettings): string {
  if (settings.mode !== "remote") return "本机服务端";
  // `remote` 一定有地址（校验与归一化都保证过），兜底只是不写 `!`
  return stripUserInfo(settings.serverUrl ?? "") || "远程服务端";
}

/**
 * 一份设置的一句话描述（**进日志**）。
 *
 * 只印模式与地址：凭证是钥匙，它不许出现在任何会被 `cat` 出去的东西里。这也是本文件里唯一
 * 一处「把配置写出去」的地方 —— 想加日志的人只能改这里，于是「别印凭证」是一条结构上的保证，
 * 而不是一句提醒。地址先过一遍 {@link stripUserInfo}：写在 URL 里的凭证同样不许出去。
 */
export function describeConnection(settings: ConnectionSettings): string {
  if (settings.mode !== "remote") return "本地（发现文件 + 本机凭证）";
  return `远程 ${stripUserInfo(settings.serverUrl ?? "")}`.trim();
}

/**
 * 抹掉一段文本里出现的凭证（错误信息上屏 / 进日志之前的那一道）。
 *
 * `error.message` 今天不含凭证（包的 `explainUnauthorized` 只给结论），但这句话会被推到
 * 界面上、也会被贴进 issue —— 一条「万一哪天错误里带了上下文」的保险，代价是一次
 * `split/join`。`local` 模式下这里抹不掉什么（凭证在 `<aiZenDir>/run/token`，调用方手上
 * 没有那一串）；那条路上「不进日志」由连接层保证。
 */
export function redactCredential(text: string, settings: ConnectionSettings): string {
  const token = settings.serverToken?.trim();
  if (!token) return text;
  return text.split(token).join("***");
}

// ==================================================================
// 内部
// ==================================================================

/**
 * 读回来那份的**宽松**归一化：认不出来就返回 `null`，任何情况下不抛。
 *
 * 与 {@link parseConnectionSettings} 的两处差别，都是有意的：
 *
 *   · 不认得 = `null`（不是抛错）：读路径不能把一份手滑的文件变成一次启动失败；
 *   · `local` 模式下**不校验**残留的 `serverUrl`：它不会被使用（{@link connectionSettingsToTarget}
 *     对 local 一律吐 `undefined`），为一段用不上的字符串拒掉整份配置只会让人莫名其妙。
 *     「不校验」与「会被清掉」不矛盾：清理发生在**保存路径**上（界面在 `local` 下只发
 *     `{ mode: "local" }`），而这里是读路径 —— 盘上真有一份手改出来的 `mode: "local"` +
 *     残留 `serverUrl`，就照读、照留着；从面板保存一次就没了。
 */
function normalizeStored(raw: unknown): ConnectionSettings | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as Partial<ConnectionSettings>;
  if (input.mode !== "local" && input.mode !== "remote") return null;

  const serverUrl = trimmed(input.serverUrl);
  const serverToken = trimmed(input.serverToken);
  if (input.mode === "remote") {
    // 远程模式没有可解析的地址 = 这份配置不可用（与坏 JSON 同一类事实）
    if (!serverUrl) return null;
    try {
      parseServerUrl(serverUrl);
    } catch {
      return null;
    }
  }

  return {
    mode: input.mode,
    ...(serverUrl ? { serverUrl } : {}),
    ...(serverToken ? { serverToken } : {}),
  };
}

/**
 * 去首尾空白；不是字符串 / 空串 → `undefined`。
 *
 * 空串在这套配置里没有含义（空地址、空凭证都是「没填」），折成 `undefined` 让下游只剩一种
 * 「没有」的写法 —— 类型上也就不会出现「有值、但值是空的」这种半截状态。
 */
function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

/**
 * 抹掉 URL 里的 userinfo。
 *
 * `parseServerUrl` 不看 userinfo（它只取 host / port / path），但**那一串会被原样写进
 * `label` 与日志** —— 而两者都要上屏。有人把钥匙写进地址时，凭证就会顺着界面与日志出去；
 * 这里多十行，那条路就是封死的。
 */
function stripUserInfo(url: string): string {
  const scheme = url.indexOf("://");
  if (scheme < 0) return url;
  const at = url.lastIndexOf("@");
  if (at < scheme) return url;
  return `${url.slice(0, scheme + 3)}${url.slice(at + 1)}`;
}
