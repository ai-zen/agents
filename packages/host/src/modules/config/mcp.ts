import { dirname, join } from "node:path";

import { discoverMcpServers, type LogSink, type McpServerConfig } from "@ai-zen/agents-sdk";

import type { Bus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import { ensureDirectory, readTextFile, writeTextFile } from "../../infra/files.js";
import type { Translator } from "../i18n/index.js";
import type { ConfigEvent } from "./events.js";

/**
 * MCP 配置的五层文件。`workspace` 是项目根下与其他工具共用的那一份，`workspaceAiZen` 与
 * `workspaceAgents` 是项目里的两个目录，`user` 在数据根，`userAgents` 在用户主目录下。
 */
export type McpScope = "workspace" | "workspaceAiZen" | "workspaceAgents" | "user" | "userAgents";

/** 由近及远：合并时靠前的那层赢 */
const LAYER_ORDER: readonly McpScope[] = [
  "workspace",
  "workspaceAiZen",
  "workspaceAgents",
  "user",
  "userAgents",
];

/**
 * 只有这两层由宿主写。另外三层要么在别人的仓库里、要么在别的工具的目录里：替人写那种文件，
 * 等于替人改他仓库里的内容。
 */
const WRITABLE: readonly McpScope[] = ["workspaceAiZen", "user"];

export interface McpConfigDeps {
  /** 数据根：`config.json` 所在的那一层，用户级 MCP 配置与它同目录 */
  readonly dataRoot: string;
  /** 用户主目录：`userAgents` 那一层在它下面 */
  readonly homeDir: string;
  readonly events: Bus<ConfigEvent>;
  readonly t: Translator;
  /**
   * 日志口。必填：某个配置文件坏了的话，那个文件里定义的服务器会安静地从清单里少掉——
   * 没有这一格就没有任何一处可以说原因。
   */
  readonly log: LogSink;
}

/**
 * MCP 服务器的配置。五层文件合并成一份有效清单，同名以离项目近的为准。
 *
 * 合并本身不在这里：`discoverMcpServers` 做的就是这件事，它认识的写法比这一层多（`transport`
 * 与 `transportType` 两个别名、停用、解析失败记日志）。这一层只剩 SDK 不知道的两件事 ——
 * 哪五个文件，以及哪两层可以写。
 *
 * 每次调用都重新读文件，不留缓存：缓存一份就要回答「什么时候让它失效」，而这几份文件用户
 * 随时会手改，命令行工具也可能在宿主运行期间写它们。
 */
export class McpConfig {
  constructor(private readonly deps: McpConfigDeps) {}

  /**
   * 合并后的有效清单。停用的条目自己也不在里面：SDK 归一化时就把它们丢了。所以「把一条停用的
   * 配置重新启用」读的是它所在的那层文件，不是这份清单。
   */
  async effective(cwd: string): Promise<McpServerConfig[]> {
    // 不传 `logger`：配置面还没有可接的日志口，SDK 的发现不注入就什么都不记 —— 某个文件
    // 解析失败时，清单里那一条会安静地少掉。
    const servers = await discoverMcpServers(this.layerPaths(cwd), { logger: this.deps.log });
    const disabled = this.disabledNames(cwd);
    return servers.filter((server) => !disabled.has(server.id));
  }

  async save(scope: McpScope, cwd: string, server: McpServerConfig): Promise<void> {
    const path = this.writablePath(scope, cwd);
    this.mutate(path, (servers) => {
      const existing = servers[server.id] ?? {};
      // 与文件里那一条合并，不是覆盖：这一层那条上的其他键（别的工具写的、这一版还不认识的）
      // 原样留着，否则一次保存就把用户的配置抹掉了。
      servers[server.id] = { ...existing, ...entryOf(server) };
    });
    this.deps.events.emit({ kind: "mcp", scope });
  }

  async remove(scope: McpScope, cwd: string, name: string): Promise<void> {
    const path = this.writablePath(scope, cwd);
    this.mutate(path, (servers) => {
      // 这一层里没有它，说明它来自更远的一层：删这一层什么也删不掉，不能报成功
      if (servers[name] === undefined) {
        throw new HostError(
          "not_found",
          this.deps.t("MCP 配置 {path} 里没有名为 {name} 的服务器", { path, name }),
          { path, name },
        );
      }
      delete servers[name];
    });
    this.deps.events.emit({ kind: "mcp", scope });
  }

  private pathOf(scope: McpScope, cwd: string): string {
    switch (scope) {
      case "workspace":
        return join(cwd, ".mcp.json");
      case "workspaceAiZen":
        return join(cwd, ".ai-zen", "mcp.json");
      case "workspaceAgents":
        return join(cwd, ".agents", "mcp.json");
      case "user":
        return join(this.deps.dataRoot, "mcp.json");
      case "userAgents":
        return join(this.deps.homeDir, ".agents", "mcp.json");
    }
  }

  /** 交给 SDK 的就是这五个路径，近的在前：它的合并按这个顺序先到先得 */
  private layerPaths(cwd: string): string[] {
    return LAYER_ORDER.map((scope) => this.pathOf(scope, cwd));
  }

  private writablePath(scope: McpScope, cwd: string): string {
    const path = this.pathOf(scope, cwd);
    if (!WRITABLE.includes(scope)) {
      throw new HostError("unsupported", this.deps.t("MCP 配置 {path} 不由宿主写入", { path }), {
        path,
      });
    }
    return path;
  }

  /**
   * 按层序读一遍各文件，收 `disabled: true` 的名字。
   *
   * 这是产品的规则，SDK 的合并没有它：`discoverMcpServers` 把停用的条目归一化成 `null` 之后
   * 直接 `continue`，名字因此不进它的 `seen`，远处同名的定义照样被收进结果 —— 人写「别用」，
   * 合出来的却是一条能用的。过滤排在 SDK 之后，归一化一行都没有抄回来。
   *
   * 坏文件在这里不报：同一趟 `effective()` 里 `discoverMcpServers` 已经为它记过一条日志，
   * 这里再抛一次会把整份清单变成一条失败，而 SDK 的合并没有这个失败面。
   *
   * 这是同一批文件的第二遍读：SDK 只交出合并结果，不交出每个文件里有哪些名字被它丢掉了。
   * 少读这一遍就得让 SDK 那边多一个返回值，而那属于 SDK 的接口，不属于这一层。
   */
  private disabledNames(cwd: string): Set<string> {
    const names = new Set<string>();
    for (const path of this.layerPaths(cwd)) {
      const file = parseRawFile(readTextFile(path));
      if (file === undefined) continue;
      for (const [name, entry] of Object.entries(file.mcpServers ?? {})) {
        if (entry?.disabled === true) names.add(name);
      }
    }
    return names;
  }

  /**
   * 改一层并写回**原文件的内容**：只动被点名的那一条，文件里其他键、条目上这一版不认识的键
   * 都原样留着。所以这里改的是解析出来的原始对象，而不是归一化之后的那一份 —— 归一化会把
   * 未知键去掉，用它写回等于把别人的字段洗掉了。
   */
  private mutate(path: string, change: (servers: RawServers) => void): void {
    const file = this.readForWrite(path);
    change(file.mcpServers);
    ensureDirectory(dirname(path));
    writeTextFile(path, `${JSON.stringify(file, null, 2)}\n`);
  }

  /**
   * 写回要的那一份：文件原样。`mcpServers` 缺了这一格就按空表算 —— 这一层第一次存服务器时
   * 正是这种情形，而文件里其余的键仍然要跟着走。
   *
   * 读不出 JSON 就报 `config_invalid` 并且不写：覆盖一份读不出来的文件，等于把人的配置换成
   * 我们这一份。SDK 那边没有写文件的能力，所以这条判断没有第二处可以借。
   */
  private readForWrite(path: string): RawFile {
    const text = readTextFile(path);
    if (text === undefined) return { mcpServers: {} };
    const raw = parseRawFile(text);
    if (raw === undefined) {
      throw new HostError("config_invalid", this.deps.t("读不出 MCP 配置 {path}", { path }), {
        path,
      });
    }
    return { ...raw, mcpServers: raw.mcpServers ?? {} };
  }
}

type RawServers = Record<string, Record<string, unknown> | undefined>;

/**
 * 文件原样：`mcpServers` 之外这一版不认识的键也要能带着走，所以不定成精确形状。
 *
 * 条目里的键同样不归这一层管 —— 认识哪些写法是 SDK 的事，这里只保证没认出来的那些原样回去。
 */
interface RawFile {
  mcpServers: RawServers;
  [key: string]: unknown;
}

/**
 * 文本读不成 JSON 回 `undefined`。两个调用处对它的处置不同：合并那一路当这一层空着（坏文件
 * 由 SDK 的发现记日志），写那一路报 `config_invalid` 并且不写。
 */
function parseRawFile(text: string | undefined): RawFile | undefined {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as RawFile;
  } catch {
    return undefined;
  }
}

/**
 * 写回时传输方式改回文件里的那个键名。读的时候几个别名都认（那是 SDK 的归一化），写只写标准
 * 那一个：一份文件里同时留着 `type` 与 `transport` 之后，人改哪一个都可能不生效。
 */
function entryOf(server: McpServerConfig): Record<string, unknown> {
  const { id: _id, transport, ...rest } = server;
  return { ...rest, type: transport };
}
