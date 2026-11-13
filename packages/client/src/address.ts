/**
 * 宿主地址的**形状**与「地址 ↔ URL」的**唯一实现处**。
 *
 * 地址在本包内部一律是结构化字段（host / port / path / secure），字符串只出现在两个边界上：
 * 用户输入（{@link parseAddress}）与线上（{@link webSocketUrl}）。让每个调用点各自
 * `new URL(...)` 取一次的话，写错一处（`hostname` 与 `host` 混用、忘了 IPv6 要加方括号、缺省端口
 * 算错）都能编译通过，而它的后果不是一条报错 —— 是连到**另一台机器**上。
 *
 * 接受 `ws:` / `wss:` / `http:` / `https:` 四种 scheme（后两个按 `http→ws`、`https→wss` 映射）：
 * 用户手上拿到的地址几乎都是 `https://your.domain/ai-zen`，让他为了「我要用 WebSocket 连」去
 * 改写成 `wss://` 是把实现细节推给使用者。
 *
 * `path` 存在的理由只有一个：反向代理的子路径挂载（`location /ai-zen/`）。凭证**不进 URL**
 * （会进日志与进程表），所以 query / hash 解析时直接丢掉。
 */

import { badAddress } from "./errors.js";

/** 宿主在哪：host + port，外加两块可选的线上事实（子路径、是否加密） */
export interface HostTarget {
  /** 裸地址（IPv6 不带方括号，与宿主发现文件里的 `host` 同形） */
  host: string;
  port: number;
  /** URL 的 path 部分；缺省 = 根路径（子路径挂载需要它） */
  path?: string;
  /** true = `wss://`；缺省 false = `ws://` */
  secure?: boolean;
}

/** 四种 scheme 各自的两件事：加不加密、缺省端口是多少 */
const SCHEMES: Record<string, { secure: boolean; defaultPort: number }> = {
  ws: { secure: false, defaultPort: 80 },
  http: { secure: false, defaultPort: 80 },
  wss: { secure: true, defaultPort: 443 },
  https: { secure: true, defaultPort: 443 },
};

/**
 * 一串用户输入的地址 → 结构化地址。
 *
 * 缺省端口按 scheme 补（ws/http 80、wss/https 443）：`URL` 对这几个特殊 scheme 会把缺省端口
 * 吃掉（`url.port` 返回空串），所以缺省值只能在这里补，不能指望它。
 *
 * @throws `ClientError`（`bad_address`），错误信息里带原始字符串 —— 用户要能认出自己填的那一行
 */
export function parseAddress(input: string): HostTarget {
  const text = normalizeAddress(input);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw badAddress(input);
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  const known = SCHEMES[scheme];
  if (!known) throw badAddress(input);

  const target: HostTarget = {
    // `URL.hostname` 对 IPv6 字面量带着方括号（`[::1]`）：方括号是 URL 的语法，不是地址的一部分。
    // 存裸地址，与宿主发现文件里的 `host` 一致，两份东西拼在一条链上时不必层层剥
    host: stripBrackets(url.hostname),
    port: url.port === "" ? known.defaultPort : Number(url.port),
  };
  // 根路径就是「没有路径」：留着它只会在拼 URL 时多出一个斜杠
  if (url.pathname !== "" && url.pathname !== "/") target.path = url.pathname;
  if (known.secure) target.secure = true;
  return target;
}

/**
 * 用户敲的地址 → 一条能交给 {@link parseAddress} 的地址：**没写 scheme 就补 `ws://`**。
 *
 * `10.0.0.5:8790` 在终端里是最自然的写法，而 `parseAddress` 要求带 scheme。**不猜加密**：写了
 * `https://` / `wss://` 就按他的，没写就当内网明文 —— 反过来「自动升成 wss」会在连一个没配
 * 证书的宿主时得到一条与地址无关的 TLS 报错。
 */
export function normalizeAddress(raw: string): string {
  const text = raw.trim();
  if (text === "") return text;
  return text.includes("://") ? text : `ws://${text}`;
}

/**
 * 结构化地址 → `ws://…` / `wss://…`。全包唯一一份。
 *
 * IPv6 字面量要加方括号（`::1` 是本地实例的合法监听地址之一）；没有 `path` 时不多出一个斜杠。
 */
export function webSocketUrl(target: HostTarget): string {
  const host = stripBrackets(target.host.trim());
  const literal = host.includes(":") ? `[${host}]` : host;
  const scheme = target.secure ? "wss" : "ws";
  return `${scheme}://${literal}:${target.port}${pathOf(target.path)}`;
}

/** 一条给人看的地址（`host:port`，不含任何凭证；界面与错误文案都用它） */
export function addressLabel(target: HostTarget): string {
  const host = stripBrackets(target.host);
  return `${host.includes(":") ? `[${host}]` : host}:${target.port}`;
}

/**
 * 这个 host 是不是本机回环。
 *
 * 用来回答「本机的那串凭证对这台宿主有没有意义」：显式地址指向本机时，`run/token` 就是它的
 * 凭证；指向远端时，本地文件里那一串与对面的锁毫无关系，不该拿去试。
 */
export function isLoopbackHost(host: string): boolean {
  const value = stripBrackets(host.trim()).toLowerCase();
  return value === "localhost" || value === "::1" || value.startsWith("127.");
}

/** `[::1]` → `::1`（其它地址原样） */
function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}

/** `undefined` / 空串 / `"/"` 都算「没有路径」；其余补一个前导斜杠 */
function pathOf(path: string | undefined): string {
  const value = path?.trim() ?? "";
  if (value === "" || value === "/") return "";
  return value.startsWith("/") ? value : `/${value}`;
}
