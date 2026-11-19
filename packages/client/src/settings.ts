/**
 * 「上次连的是哪台、说什么语言」—— 一份连接设置的**读写、校验与措辞**（PRD D26）。
 *
 * ## 为什么它在包里，而不在各前端
 *
 * CLI 与桌面端都要记住同一件事：用户选的是「本机」还是「某台远程」，选远程时地址、凭证是什么，
 * 以及上一回用的是哪种语言。这套东西每一行都是踩出来的：`0600`（文件里有凭证）、
 * `.tmp` → `rename`（进程被杀不留半个 JSON）、读不炸（坏文件不该让应用起不来）、`local` 模式必须
 * 吐 `undefined` 而不是空串。抄两份的下场是**其中一份先修**：一端手上是 `0600`、另一端是
 * `0644`，而症状要等到某天 `cat` 之后才知道。
 *
 * ## 两个前端不共用一份文件
 *
 * `<数据根>/cli/connection.json` 与 `<数据根>/desktop/connection.json` 分开存：这两个客户端可能
 * 在两台机器上，也可能在同一台上连着**不同**的宿主。共用的只有 `<数据根>/run/` 下那两样
 * （发现文件与凭证）—— 那是**这台机器**的事实。
 *
 * ## 「没配过」是一个独立的事实
 *
 * {@link readSettings} 在没有可用配置时返回 `null`，而不是 `{ mode: "local" }`。用默认值兜底会
 * 把三种情形压成两格（没配过 / 配过本地 / 配过远程），于是「首次启动该进连接屏」这条判据做不
 * 出来 —— 首启会被当成「用户选过本地」，直接拉起一个宿主。
 *
 * 坏 JSON / 字段不合法同样返回 `null`（与「文件不在」同一类事实：这份配置不可用），**绝不抛错**。
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { parseAddress } from "./address.js";

/** `local` = 本机（发现文件 + 本机 `run/token`）；`remote` = 用户填的那台 */
export type ConnectionMode = "local" | "remote";

/** 哪个客户端的配置 —— 决定落点，不影响内容 */
export type ConnectionClient = "cli" | "desktop";

/**
 * 一份连接设置。
 *
 * `local` 模式下 `url` / `token` 必须是 `undefined` 而不是空串：连接层把空串当成「显式给了一个
 * 空值」，只有 `undefined` 才表示「走发现文件与本机 `run/token`」。这条口径由
 * {@link settingsToTarget} 保证。
 */
export interface ConnectionSettings {
  mode: ConnectionMode;
  /** 仅 `remote` 有意义：显式地址（`ws:` / `wss:` / `http:` / `https:`，或裸 `host:port`） */
  url?: string;
  /** 仅 `remote` 有意义：显式凭证。留空 = 退回本机 `<数据根>/run/token`（本机实例那条兜底） */
  token?: string;
  /** 连接语言（`hello` 时带上）。留空 = 由宿主的默认语言决定（D8：缺省英文） */
  language?: string;
}

/**
 * 落点：`<数据根>/<client>/connection.json`。
 *
 * 放在各自的子目录下而不是数据根下：根下（`config.json` / `agents/` / `run/` / 库 / `assets/`）
 * 全是**宿主的事实**，客户端往里写东西会模糊那条边界；`cli/` / `desktop/` 一眼就是「这个
 * 客户端自己的」。
 */
export function settingsPath(dataRoot: string, client: ConnectionClient): string {
  return join(dataRoot, client, "connection.json");
}

/**
 * 读配置：文件不在 / 坏 JSON / 字段不合法一律 `null`，任何情况下不抛。
 *
 * 参数是**文件路径**而不是数据根：两个前端各拼各的（{@link settingsPath}），用例也能直接指到
 * 临时文件上。
 */
export async function readSettings(file: string): Promise<ConnectionSettings | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    // 文件不在是正常状态：第一次启动之前就是它
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // 坏 JSON（手改坏了、写到一半被 kill）：当作没有配置，别让应用起不来
    return null;
  }
  return storedSettings(parsed);
}

/**
 * 写配置：先写 `.tmp` 再 `rename`，权限 `0600`。
 *
 * 关键在 `rename`：同一文件系统内它是原子的，读方要么看到旧内容、要么看到新内容。`mode` 只在
 * 「这次新建的文件」上生效，`.tmp` 若是上一次崩溃留下的，权限不会自己变回 `0600`，所以显式再
 * `chmod` 一次。
 */
export async function writeSettings(file: string, settings: ConnectionSettings): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });

  const tmp = `${file}.tmp`;
  // 末尾留一个换行：这份文件可能被人 `cat` / 手改，一行结束得像个文本文件
  await fs.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

/**
 * 把一份**外来**的设置校验成可落盘的那一份（表单 / IPC 边界用）。
 *
 * 与读路径的区别是失败方式：读路径上「不可用」= `null`（应用要继续启动），保存路径上「不可用」=
 * 抛人话（用户刚在面板里敲的，静默改掉他的输入比报错更糟）。
 */
export function parseSettings(raw: unknown): ConnectionSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("连接设置必须是一个对象");
  }
  const input = raw as Partial<ConnectionSettings>;
  if (input.mode !== "local" && input.mode !== "remote") {
    throw new Error(
      `连接设置里的 mode 只能是 local 或 remote（收到：${JSON.stringify(input.mode)}）`,
    );
  }

  const url = trimmed(input.url);
  const token = trimmed(input.token);
  const language = trimmed(input.language);

  if (input.mode === "remote") {
    if (!url) throw new Error("选了远程模式，但没填宿主地址");
    // 地址合法性只问那一个实现（错误信息里带原串，用户认得出自己填了什么）
    parseAddress(url);
  }

  return {
    mode: input.mode,
    ...(url ? { url } : {}),
    ...(token ? { token } : {}),
    ...(language ? { language } : {}),
  };
}

/**
 * 一份设置 → 递给连接层的两个值（`url` / `token`）。**这是「`local` 传 `undefined` 而不是空串」
 * 的唯一实现处**：空串会被连接层理解成「显式给了空值」，于是不走发现文件、不读本机凭证。
 */
export function settingsToTarget(settings: ConnectionSettings): {
  url?: string;
  token?: string;
  language?: string;
} {
  if (settings.mode !== "remote") {
    return { url: undefined, token: undefined, language: trimmed(settings.language) };
  }
  return {
    url: trimmed(settings.url),
    token: trimmed(settings.token),
    language: trimmed(settings.language),
  };
}

/**
 * 界面上那一行字（`本机宿主` / 那个地址）。**绝不包含凭证**：地址里的 userinfo 会被抹掉 ——
 * 有人会把钥匙写进地址（`wss://token@host`），而这一行要上屏。
 */
export function settingsLabel(settings: ConnectionSettings): string {
  if (settings.mode !== "remote") return "本机宿主";
  return stripUserInfo(settings.url ?? "") || "远程宿主";
}

/**
 * 一份设置的一句话描述（**进日志**）：只印模式与地址，凭证是钥匙，不许出现在任何会被 `cat`
 * 出去的东西里。
 */
export function describeSettings(settings: ConnectionSettings): string {
  if (settings.mode !== "remote") return "本地（发现文件 + 本机凭证）";
  return `远程 ${stripUserInfo(settings.url ?? "")}`.trim();
}

/** 抹掉一段文本里出现的凭证（错误信息上屏 / 进日志之前的那一道） */
export function redactToken(text: string, settings: ConnectionSettings): string {
  const token = settings.token?.trim();
  if (!token) return text;
  return text.split(token).join("***");
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

/**
 * 读回来那份的**宽松**归一化：认不出来就返回 `null`，任何情况下不抛。
 *
 * 与 {@link parseSettings} 的两处差别都是有意的：不认得 = `null`（读路径不能把一份手滑的文件
 * 变成一次启动失败）；`local` 模式下**不校验**残留的 `url`（它不会被使用 ——
 * {@link settingsToTarget} 对 local 一律吐 `undefined`）。
 */
function storedSettings(raw: unknown): ConnectionSettings | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as Partial<ConnectionSettings>;
  if (input.mode !== "local" && input.mode !== "remote") return null;

  const url = trimmed(input.url);
  const token = trimmed(input.token);
  const language = trimmed(input.language);
  if (input.mode === "remote") {
    // 远程模式没有可解析的地址 = 这份配置不可用（与坏 JSON 同一类事实）
    if (!url) return null;
    try {
      parseAddress(url);
    } catch {
      return null;
    }
  }

  return {
    mode: input.mode,
    ...(url ? { url } : {}),
    ...(token ? { token } : {}),
    ...(language ? { language } : {}),
  };
}

/** 去首尾空白；不是字符串 / 空串 → `undefined`（空串在这套配置里没有含义） */
function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

/** 抹掉 URL 里的 userinfo（地址里的那一串凭证不该跟着界面与日志出去） */
function stripUserInfo(url: string): string {
  const scheme = url.indexOf("://");
  if (scheme < 0) return url;
  const at = url.lastIndexOf("@");
  if (at < scheme) return url;
  return `${url.slice(0, scheme + 3)}${url.slice(at + 1)}`;
}
