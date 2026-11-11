/**
 * 服务端地址的**形状**与 URL 的**唯一实现处**。
 *
 * ## 为什么内部坚持结构化字段，而不是到处存字符串
 *
 * `isLoopbackHost(target.host)` 是「工作区归属」的唯一判据（见 `local-host.ts`）：服务端在本机
 * 就把客户端的 `process.cwd()` 递上去，不在本机就**不说**。让每个调用点各自 `new URL(...)`
 * 取一次 host 的话，写错一处（`hostname` 与 `host` 混用、忘了 IPv6 要加方括号、把缺省端口算
 * 错）都是**能编译通过**的错误 —— 而它的后果不是一条报错，是一个静默跑在**错误目录**里的会话。
 * 所以地址在本包内部一律是字段，字符串只出现在两个边界上：用户输入（{@link parseServerUrl}）
 * 与线上（{@link webSocketUrl}）。
 *
 * ## 为什么 `path` 与 `secure` 是可选的
 *
 * 地址的大多数来源是发现文件（`{ host, port }`：本机、明文 ws、根路径），强迫那些调用点补两个
 * `undefined` 只会让「写全才合法」变成噪音。缺省值集中在 {@link webSocketUrl} 一处：没有
 * `path` = `/`，没有 `secure` = `ws://`。
 *
 * ## 为什么接受 `http:` / `https:`
 *
 * 用户手上拿到的地址几乎都是 `https://your.domain/ai-zen`（nginx 的对外入口、浏览器地址栏里
 * 那一串），而 WS 的 scheme 只是它的另一种写法（`http → ws`、`https → wss`，同一个端口、同一
 * 条连接）。让用户为「我要用 WebSocket 连」去把 `https` 改写成 `wss` 是把实现细节推给使用者：
 * 他十有八九会填 `https://`，然后对着一条 `不是合法的服务端地址` 猜。
 *
 * 反过来，`path` 存在的理由只有一个：nginx 子路径挂载（`location /ai-zen/`）。凭证**不在** URL
 * 里（D2：不进 query string —— 那会进日志、历史与 Referer），所以 query / hash 解析时直接丢掉。
 */

/** 服务端在哪：host + port，外加两个可选的两块线上事实（子路径、加密） */
export interface ServerTarget {
  host: string;
  port: number;
  /** URL 的 path 部分；缺省 "/"（nginx 子路径挂载需要它，如 `location /ai-zen/`） */
  path?: string;
  /** URL 的 scheme 算出来的；缺省 false = ws://，true = wss:// */
  secure?: boolean;
}

/** 四种 scheme 各自的两件事：加不加密、缺省端口是多少（`URL` 对它们都按特殊 scheme 处理） */
const SCHEMES: Record<string, { secure: boolean; defaultPort: number }> = {
  ws: { secure: false, defaultPort: 80 },
  http: { secure: false, defaultPort: 80 },
  wss: { secure: true, defaultPort: 443 },
  https: { secure: true, defaultPort: 443 },
};

/**
 * 一串用户输入的地址 → 结构化地址。
 *
 * 接受 `ws:` / `wss:` / `http:` / `https:`（后两个按 `http→ws`、`https→wss` 映射）；缺省端口按
 * scheme 给（ws/http 80、wss/https 443）—— `URL` 对特殊 scheme 会把这几个缺省端口吃掉
 * （`url.port` 返回空串），所以缺省值只能在这里补，不能指望它。
 *
 * @throws 不是合法 URL、或 scheme 不在这四种里 —— 错误信息里带**原始字符串**（用户得知道
 * 是他填的那一行里的哪一个字符不对，而不是一句「地址不合法」）
 */
export function parseServerUrl(input: string): ServerTarget {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw notAnAddress(input);
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  const known = SCHEMES[scheme];
  if (!known) throw notAnAddress(input);

  const target: ServerTarget = {
    // `URL.hostname` 对 IPv6 字面量**带着方括号**（`[::1]`）—— 方括号是 URL 的语法，不是地址的
    // 一部分。`host` 一律存裸地址：发现文件里的 `host`（服务端从 `server.address().address`
    // 拿到的）就是裸的，两份东西拼在一条链上时，一张一张剥没人记得住
    host: stripBrackets(url.hostname),
    port: url.port === "" ? known.defaultPort : Number(url.port),
  };
  // 根路径就是「没有路径」：留着它只会在拼 URL 时多出一个斜杠，别处还要再判一次
  if (url.pathname !== "" && url.pathname !== "/") target.path = url.pathname;
  if (known.secure) target.secure = true;
  return target;
}

/**
 * 结构化地址 → `ws://…` / `wss://…`。
 *
 * **全仓唯一一份**：从前 `socket-server-client.ts` 与 `wire/call-once.ts` 各有一份逐字相同的私
 * 有实现 —— 而它们已经差一点分叉（一个只管 IPv6、两个都不管 `path` 与 scheme）。地址的线上
 * 写法只该有一处，否则「长连接连上了、诊断问话连不上」这种错要找两个地方。
 *
 * IPv6 字面量要加方括号（`::1` 是允许的监听地址之一，也是唯一能确定「同一个内核」的地址之
 * 一）；没有 `path` 时不多出一个斜杠。
 */
export function webSocketUrl(target: ServerTarget): string {
  // 方括号在 IPv6 里是语法，不是地址的一部分：进来时无论是 `::1` 还是 `[::1]`，出去都写一次
  const host = stripBrackets(target.host.trim());
  const literal = host.includes(":") ? `[${host}]` : host;
  const scheme = target.secure ? "wss" : "ws";
  return `${scheme}://${literal}:${target.port}${pathOf(target.path)}`;
}

/** `[::1]` → `::1`（其它地址原样） */
function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}

/** `undefined` / 空串 / `"/"` 都算「没有路径」；其余补一个前导斜杠（`ai-zen` 与 `/ai-zen` 同义） */
function pathOf(path: string | undefined): string {
  const value = path?.trim() ?? "";
  if (value === "" || value === "/") return "";
  return value.startsWith("/") ? value : `/${value}`;
}

/** 不合法地址的错误：**带原始字符串**（去掉首尾空白之前的那一串，用户要能认出自己填了什么） */
function notAnAddress(input: string): Error {
  return new Error(
    `不是合法的服务端地址：${JSON.stringify(input)}（要 ws:// 、wss:// 、http:// 或 https:// 开头的地址）`,
  );
}
