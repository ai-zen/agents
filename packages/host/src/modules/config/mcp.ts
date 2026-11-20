import { dirname, join } from "node:path";

import { z } from "zod";

import type { Bus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import { ensureDirectory, readTextFile, writeTextFile } from "../../infra/files.js";
import type { Translator } from "../i18n/index.js";
import type { ConfigEvent } from "./events.js";

const transportSchema = z.enum(["stdio", "http", "sse"]);

type Transport = z.infer<typeof transportSchema>;

/** 字段留着：配了也连不上，因为 OAuth 授权流程还没做 */
const oauthSchema = z.object({
  authorizationUrl: z.string(),
  tokenUrl: z.string(),
  clientId: z.string(),
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
});

/**
 * 文件里的一条服务器。stdio 用 `command` / `args` / `env`，http 与 sse 用 `url` / `headers`；
 * 这里不校验「stdio 必须给 command」这类配套关系，缺的那一项在连不上的那一刻才有答案，
 * 而配置面不该因为一条连不上的服务器就整层读不出来。
 *
 * `type` 可省：别的工具写的 `.mcp.json` 常常不写它，见 {@link transportOf}。
 */
const entrySchema = z.object({
  type: transportSchema.optional(),
  description: z.string().optional(),
  disabled: z.boolean().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  oauth: oauthSchema.optional(),
});

type Entry = z.infer<typeof entrySchema>;

/** 一份 MCP 配置文件：服务器按名字放在 `mcpServers` 下，没有这个键就是这一层空着 */
const fileSchema = z.object({
  mcpServers: z.record(z.string(), entrySchema).default({}),
});

/**
 * 有效清单里的一条服务器。服务器名在文件里是 `mcpServers` 的键，进了清单才是 `id` 字段，
 * 所以它与文件里那一条不是同一个形状，两者各有一个类型。
 *
 * 传输方式在文件里叫 `type`，这里叫 `transport`：`McpServer` 因此与
 * `@ai-zen/agents-sdk` 的 `McpServerConfig` 逐字段一致，接上连接那一侧不需要再转一次。
 */
export type McpServer = Omit<Entry, "type"> & {
  readonly id: string;
  readonly transport: Transport;
};

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
}

/**
 * MCP 服务器的配置。五层文件合并成一份有效清单，同名以离项目近的为准。
 *
 * 每次调用都重新读文件，不留缓存：缓存一份就要回答「什么时候让它失效」，而这几份文件用户
 * 随时会手改，命令行工具也可能在宿主运行期间写它们。
 */
export class McpConfig {
  constructor(private readonly deps: McpConfigDeps) {}

  /**
   * 合并后的有效清单。停用的条目照旧在里面、带着 `disabled`：滤掉它，界面就再也无法把它重新
   * 启用；而且用停用来取消远处同名的定义就失效了 —— 挡住的必须是名字，不是可用性。
   */
  async effective(cwd: string): Promise<McpServer[]> {
    const merged = new Map<string, McpServer>();
    for (const layer of LAYER_ORDER) {
      for (const server of this.read(this.pathOf(layer, cwd))) {
        if (!merged.has(server.id)) merged.set(server.id, server);
      }
    }
    return [...merged.values()];
  }

  async save(scope: McpScope, cwd: string, server: McpServer): Promise<void> {
    const path = this.writablePath(scope, cwd);
    this.mutate(path, (file) => {
      const existing = file.mcpServers[server.id] ?? {};
      // 与文件里那一条合并，不是覆盖：这一层那条上的其他键（别的工具写的、这一版还不认识的）
      // 原样留着，否则一次保存就把用户的配置抹掉了。
      file.mcpServers[server.id] = { ...existing, ...toEntry(server) };
    });
    this.deps.events.emit({ kind: "mcp", scope });
  }

  async remove(scope: McpScope, cwd: string, name: string): Promise<void> {
    const path = this.writablePath(scope, cwd);
    const servers = this.read(path);
    // 这一层里没有它，说明它来自更远的一层：删这一层什么也删不掉，不能报成功
    if (!servers.some((server) => server.id === name)) {
      throw new HostError(
        "not_found",
        this.deps.t("MCP 配置 {path} 里没有名为 {name} 的服务器", { path, name }),
        { path, name },
      );
    }
    this.mutate(path, (file) => {
      delete file.mcpServers[name];
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
   * 读一层。文件不在就是这一层空着。
   *
   * 文件在但读不成配置时，五层只有一种处置：报 `config_invalid` 并指出是哪个文件。数据根那一份
   * 由启动时的出厂恢复负责（坏文件留档为 `mcp.json.broken`），项目里那三份与 `~/.agents/`
   * 那一份在用户的仓库和别的工具目录里，恢复出厂等于改写别人的文件，只能让人自己修。
   */
  private read(path: string): McpServer[] {
    const file = this.parse(path);
    if (file === undefined) return [];
    return Object.entries(file.mcpServers).map(([id, entry]) => toServer(id, entry));
  }

  /**
   * 改一层并写回**原文件的内容**：只动被点名的那一条，文件里其他键、条目上这一版不认识的键
   * 都原样留着。所以这里改的是解析出来的原始对象，而不是校验之后的那一份 —— 校验会把未知键
   * 去掉，用它写回等于把别人的字段洗掉了。
   */
  private mutate(path: string, change: (file: RawFile) => void): void {
    const parsed = this.parse(path);
    const file: RawFile = parsed === undefined ? { mcpServers: {} } : { ...parsed };
    change(file);
    ensureDirectory(dirname(path));
    writeTextFile(path, `${JSON.stringify(serialize(file), null, 2)}\n`);
  }

  /** 文件不在回 `undefined`；在但读不成配置就报 `config_invalid` */
  private parse(path: string): RawFile | undefined {
    const text = readTextFile(path);
    if (text === undefined) return undefined;

    const raw = jsonOf(text);
    if (!fileSchema.safeParse(raw).success) {
      throw new HostError("config_invalid", this.deps.t("读不出 MCP 配置 {path}", { path }), {
        path,
      });
    }
    return raw as RawFile;
  }
}

/** 文件原样：`mcpServers` 之外这一版不认识的键也要能带着走，所以不定成精确形状 */
interface RawFile {
  mcpServers: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * 解析失败返回 `undefined`，交给 schema 判死：JSON 语法错与形状错是同一档坏文件，往上抛两种
 * 错误只会让调用方多一条没人走的路径。
 */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 传输方式。文件里没写时按形状推断：给 `command` 就是 stdio，否则按 http 算。
 *
 * 收紧成必填会让最常见的那份 `.mcp.json` 整层读不出来 —— 它由别的工具写、宿主只读不改，
 * 报一个「配置坏了」既不真、又没法修。
 */
function transportOf(entry: Entry): Transport {
  if (entry.type !== undefined) return entry.type;
  return entry.command === undefined ? "http" : "stdio";
}

/** 传输方式的两个名字在读写各出现一次，都在这里对齐 */
function toServer(id: string, entry: Entry): McpServer {
  const { type: _type, ...rest } = entry;
  return { id, transport: transportOf(entry), ...rest };
}

function toEntry(server: McpServer): Entry {
  const { id: _id, transport, ...rest } = server;
  return { type: transport, ...rest };
}

/** 写回时保住 `mcpServers` 之外那些键：它们属于同一份文件，不属于我们 */
function serialize(file: RawFile): unknown {
  return { ...file, mcpServers: file.mcpServers };
}
