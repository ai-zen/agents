/**
 * 能力发现服务：把「这个项目现在能用哪些 MCP / Skill / 工具 / subagent」摊成分层清单。
 *
 * 对应能力编号：F-G1（MCP 5 层链，可编辑的只有 2 个作用域）、F-G2（Skill 4 层、工具与 subagent
 * 各 2 层，只发现真实存在的目录，离项目越近越优先）、F-F6（坏文件按层分两种处置，见下）、
 * R54（各能力目录由本服务算好交给 ScopeRegistry）。
 *
 * **F-F6 里「坏文件」的那条口径不是一句话，按文件在哪分**：用户级那份
 * （`<数据根>/mcp.json`）坏了由 SDK 恢复出厂并留残骸（PRD D32），本服务因此看到的是一个
 * 好文件（除非文件是运行期才坏的，那时下一次启动才恢复）；项目侧
 * （`<cwd>/.mcp.json`、`<cwd>/.ai-zen/mcp.json`、`<cwd>/.agents/mcp.json`）与
 * `~/.agents/mcp.json` 坏了仍然是看得见的 `broken` 状态、能修 —— 那些文件在用户的仓库里，
 * 恢复出厂等于改人家的 git 内容。
 *
 * 三件事分开：
 *
 *   1. **路径**（{@link DiscoveryService.scopeAbilityPaths} 等）：只有「按 cwd 推出各能力应该去
 *      哪些目录 / 文件找」这一件事，与有没有东西在里面无关。组装层（ScopeRegistry 的
 *      `createWorkspaceScopeFactory`）拿的就是这些路径。
 *   2. **读**（{@link DiscoveryService.discover}）：把每一层的 `missing | ok | broken` 与条目
 *      报出来。这两档分开的理由见上面 F-F6 那段。
 *   3. **写**（{@link DiscoveryService.writeMcpEntry} / {@link DiscoveryService.deleteMcpEntry}）：
 *      只写 MCP 的两个可编辑作用域，一次只动一条；写回时保留这一版不认识的字段与 `oauth`
 *      （F-F6），其中 `oauth.clientSecret` 省略就按磁盘原文保留（F-F2：读出去的是掩码，
 *      回写掩码就是把掩码当密钥存下来）。
 *
 * 判断「近的优先」用的是层序 `depth`（0 最靠近项目）：合并时同 id 取 depth 小的那一层，
 * 被盖住的条目仍然出现在它自己那一层里，只是带上一条「被谁覆盖」的问题说明。
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { discoverSkills, discoverSubAgents, discoverUserToolFiles } from "@ai-zen/agents-sdk";
import type { ConfigManager, McpServerConfig } from "@ai-zen/agents-sdk";
import type { LogSink } from "@ai-zen/agents-logger";

import { DEFAULT_LANGUAGE, render, type MessageKey } from "../i18n/index.js";
import { HostError } from "../wire/errors.js";
import type {
  ConfigGetDiscoveryParams,
  ConfigGetDiscoveryResult,
  DiscoveryEntryView,
  DiscoveryKind,
  DiscoveryLayerView,
  DiscoveryView,
  LocalizedText,
  McpEditableScope,
  McpOauthView,
  McpServerEntryInput,
  ProblemFact,
} from "../wire/index.js";
import { isSecretMask, maskSecret } from "./secretMask.js";

// ---------------------------------------------------------------------------
// 目录名（与 SDK 的 `CONFIG_SUB_DIRS` 同口径）
// ---------------------------------------------------------------------------

/** 数据根下的助手定义目录 */
const DIR_AGENTS = "agents";
/** 数据根下的 subagent 定义目录 */
const DIR_SUB_AGENTS = "sub-agents";
/** 数据根下的 Skill 目录 */
const DIR_SKILLS = "skills";
/** 数据根下的用户工具目录 */
const DIR_TOOLS = "tools";
/** MCP 配置文件名（数据根下与各层同名） */
const FILE_MCP = "mcp.json";

/** 项目里 ai-zen 自己的目录（`<cwd>/.ai-zen/`，交接文档也落在这里） */
const PROJECT_AI_ZEN_DIR = ".ai-zen";
/** 项目里跨工具通用的目录（`<cwd>/.agents/`） */
const PROJECT_AGENTS_DIR = ".agents";
/** 用户主目录下跨工具通用的目录（`~/.agents/`） */
const HOME_AGENTS_DIR = ".agents";

/** 一个用户工具文件的两种扩展名（与 SDK 的发现口径一致） */
const TOOL_FILE_EXTENSIONS = [".js", ".mjs"] as const;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一层发现来源：层序、绝对路径、能不能写、属于谁 */
export interface DiscoveryLayerPath {
  /** 层序：0 最靠近项目，数字越大越远（合并时近的优先） */
  depth: number;
  /** 这一层对应的文件或目录的绝对路径 */
  path: string;
  /** 本契约的写方法能不能改这一层（F-G1：MCP 只有 2 层可以） */
  editable: boolean;
  /** 写入时用哪个作用域；不能写时为 `null` */
  scope: McpEditableScope | null;
  /** 这一层归谁：项目、用户数据根、还是别的工具约定的目录 */
  owner: "workspace" | "user" | "other";
}

/**
 * 组装一个 Scope 需要的全部能力路径（R54）。
 *
 * `ScopeRegistry` 的 `createWorkspaceScopeFactory` 就是按这份形状装配
 * `new Scope({ agentsDir, ... })` 与 `allInOne({ skillsPaths, toolsPaths, subAgentsPaths, mcpPaths })`。
 */
export interface ScopeAbilityPaths {
  /** 助手定义目录（SDK 的 `createAgent` 从这里读 `<id>.json`） */
  agentsDir: string;
  /** Skill 目录，近的在前 */
  skillsPaths: string[];
  /** 用户工具目录，近的在前 */
  toolsPaths: string[];
  /** subagent 目录，近的在前 */
  subAgentsPaths: string[];
  /** MCP 配置文件的 5 层链，近的在前（SDK 的 `discoverMcpServers` 按这个顺序先到先得） */
  mcpPaths: string[];
}

/** 按 workspaceId 取工作目录；项目不存在时回 `undefined` */
export type WorkspaceCwdLookup = (
  workspaceId: string,
) => Promise<{ cwd: string } | undefined> | { cwd: string } | undefined;

/** 发现服务的依赖；由单根组装后注入 */
export interface DiscoveryServiceOptions {
  /** 配置唯一入口（SDK）：数据根、`agents/`、`mcp.json` 都从它的 `basePath` 推出 */
  configManager: ConfigManager;
  /** 按 workspaceId 取 cwd；不给时带 `workspaceId` 的调用按「项目不存在」处理 */
  findWorkspace?: WorkspaceCwdLookup;
  /** 用户主目录（`~/.agents/` 那一层），缺省 `os.homedir()`；测试注入临时目录 */
  homeDir?: string;
  /**
   * SDK 发现函数的日志口（可选）：MCP 配置 parse 不了 / subagent 文件读不出来时那几句走它。
   * 不注就沿 SDK 的缺省（不记）—— 接线处给的是宿主自己那份 `withSource("sdk")`。
   */
  logger?: LogSink;
}

/** 一层的读取结果 */
interface LayerReading {
  state: "missing" | "ok" | "broken";
  problem: ProblemFact | null;
  entries: DiscoveryEntryView[];
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

/**
 * 一条给人看的事实（`LocalizedText` 的构造口径与素材层一致：码 = 文案键 + 参数 + 当前语言的句子）。
 *
 * 这里用默认语言渲染：发现结果可能在没人连着的时刻被算出（或某条连接拿到的不是自己那条语言），
 * 客户端要按自己的语言显示时用 `messageKey` + `params` 重新渲染。
 */
function text(messageKey: MessageKey, params: Record<string, unknown> = {}): LocalizedText {
  return {
    code: messageKey,
    messageKey,
    params,
    message: render(DEFAULT_LANGUAGE, messageKey, params),
  };
}

/** 同上，再挂一份结构化事实（哪个文件、什么原因） */
function problem(
  messageKey: MessageKey,
  params: Record<string, unknown> = {},
  detail?: unknown,
): ProblemFact {
  const base = text(messageKey, params);
  return detail === undefined ? base : { ...base, detail };
}

/** 文件系统/SDK 抛上来的东西 → 一句能拼进文案的原因 */
function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown";
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class DiscoveryService {
  private readonly configManager: ConfigManager;
  private readonly findWorkspace?: WorkspaceCwdLookup;
  private readonly homeDir: string;
  /** SDK 发现函数的日志口（不给就不记：SDK 那边缺省就是沉默） */
  private readonly logger?: LogSink;

  constructor(options: DiscoveryServiceOptions) {
    this.configManager = options.configManager;
    this.findWorkspace = options.findWorkspace;
    this.homeDir = options.homeDir ?? homedir();
    this.logger = options.logger;
  }

  /** 数据根（SDK 的 `basePath`：`config.json` 所在目录） */
  get basePath(): string {
    return this.configManager.basePath;
  }

  /** 助手定义目录（`<basePath>/agents/`，一实体一文件，F-G3） */
  get agentsDir(): string {
    return join(this.basePath, DIR_AGENTS);
  }

  // -------------------------------------------------------------------------
  // 路径（R54：组装层要的那一份）
  // -------------------------------------------------------------------------

  /**
   * MCP 的 5 层链（L9）：`<ws>/.mcp.json` → `<ws>/.ai-zen/mcp.json` → `<ws>/.agents/mcp.json`
   * → `<aiZenDir>/mcp.json` → `~/.agents/mcp.json`。
   *
   * `cwd` 为 `null`（还没打开项目）时只给后两层：项目侧那三层的路径得先有项目才算得出来。
   */
  mcpLayers(cwd: string | null): DiscoveryLayerPath[] {
    const editable = this.editableMcpLayers(cwd);
    return withoutNulls([
      projectLayer(cwd, 0, `.${FILE_MCP}`, "other"),
      editable.workspace,
      projectLayer(cwd, 2, join(PROJECT_AGENTS_DIR, FILE_MCP), "other"),
      editable.user,
      {
        depth: 4,
        path: join(this.homeDir, HOME_AGENTS_DIR, FILE_MCP),
        editable: false,
        scope: null,
        owner: "other" as const,
      },
    ]);
  }

  /**
   * 5 层链里那两个可写的层（第 2 层与第 4 层，即 depth 1 与 depth 3）；没有项目时 `workspace`
   * 那层是 `null`。
   *
   * 位置、能不能写、归谁只在这里定一次：读（`mcpLayers`）与写（`writableMcpLayer`）拿的
   * 是同一份定义。
   */
  private editableMcpLayers(cwd: string | null): {
    workspace: DiscoveryLayerPath | null;
    user: DiscoveryLayerPath;
  } {
    return {
      workspace:
        cwd === null
          ? null
          : {
              depth: 1,
              path: join(cwd, PROJECT_AI_ZEN_DIR, FILE_MCP),
              editable: true,
              scope: "workspace",
              owner: "workspace",
            },
      user: {
        depth: 3,
        path: join(this.basePath, FILE_MCP),
        editable: true,
        scope: "user",
        owner: "user",
      },
    };
  }

  /** Skill 的 4 层目录：`<ws>/.ai-zen/skills` → `<ws>/.agents/skills` → `<aiZenDir>/skills` → `~/.agents/skills` */
  skillLayers(cwd: string | null): DiscoveryLayerPath[] {
    return withoutNulls([
      projectLayer(cwd, 0, join(PROJECT_AI_ZEN_DIR, DIR_SKILLS), "workspace"),
      projectLayer(cwd, 1, join(PROJECT_AGENTS_DIR, DIR_SKILLS), "other"),
      {
        depth: 2,
        path: join(this.basePath, DIR_SKILLS),
        editable: false,
        scope: null,
        owner: "user" as const,
      },
      {
        depth: 3,
        path: join(this.homeDir, HOME_AGENTS_DIR, DIR_SKILLS),
        editable: false,
        scope: null,
        owner: "other" as const,
      },
    ]);
  }

  /** 用户工具的 2 层目录：`<ws>/.agents/tools` → `<aiZenDir>/tools` */
  toolLayers(cwd: string | null): DiscoveryLayerPath[] {
    return withoutNulls([
      projectLayer(cwd, 0, join(PROJECT_AGENTS_DIR, DIR_TOOLS), "other"),
      {
        depth: 1,
        path: join(this.basePath, DIR_TOOLS),
        editable: false,
        scope: null,
        owner: "user" as const,
      },
    ]);
  }

  /** subagent 的 2 层目录：`<ws>/.agents/sub-agents` → `<aiZenDir>/sub-agents` */
  subAgentLayers(cwd: string | null): DiscoveryLayerPath[] {
    return withoutNulls([
      projectLayer(cwd, 0, join(PROJECT_AGENTS_DIR, DIR_SUB_AGENTS), "other"),
      {
        depth: 1,
        path: join(this.basePath, DIR_SUB_AGENTS),
        editable: false,
        scope: null,
        owner: "user" as const,
      },
    ]);
  }

  /**
   * 组装一个 Scope 要的全部路径（R54）。
   *
   * `agentsDir` 只有一处（数据根下的 `agents/`）：助手定义是全局配置，与项目无关。
   * 其余四个按「近的在前」排好，直接喂给 SDK 的 `allInOne`。
   */
  scopeAbilityPaths(cwd: string): ScopeAbilityPaths {
    return {
      agentsDir: this.agentsDir,
      skillsPaths: this.skillLayers(cwd).map((layer) => layer.path),
      toolsPaths: this.toolLayers(cwd).map((layer) => layer.path),
      subAgentsPaths: this.subAgentLayers(cwd).map((layer) => layer.path),
      mcpPaths: this.mcpLayers(cwd).map((layer) => layer.path),
    };
  }

  // -------------------------------------------------------------------------
  // 读：一层的状态与条目
  // -------------------------------------------------------------------------

  /**
   * `config.getDiscovery`（F-G1 / F-G2 / F-F6）。
   *
   * 给了 `workspaceId` 就带上项目侧的三层（与项目无关的两层也照常给）；没给就只报「用户级」
   * 与「别的工具约定的」那几层 —— 客户端在没打开项目时也能看 MCP 屏。
   */
  async discover(params: ConfigGetDiscoveryParams = {}): Promise<ConfigGetDiscoveryResult> {
    const cwd = await this.resolveCwd(params.workspaceId);
    const view: DiscoveryView = {
      workspaceId: params.workspaceId ?? null,
      mcps: await this.readMcpLayers(cwd),
      skills: await this.readDirectoryLayers("skills", this.skillLayers(cwd)),
      tools: await this.readDirectoryLayers("tools", this.toolLayers(cwd)),
      subagents: await this.readDirectoryLayers("subagents", this.subAgentLayers(cwd)),
    };
    return { discovery: view };
  }

  /** 只读一层（`config.saveMcp` / `config.deleteMcp` 写回之后回报那一层时也用它） */
  async readMcpLayerView(layer: DiscoveryLayerPath): Promise<DiscoveryLayerView> {
    const reading = await this.readMcpFile(layer.path);
    return {
      kind: "mcps",
      depth: layer.depth,
      path: layer.path,
      editable: layer.editable,
      scope: layer.scope,
      state: reading.state,
      problem: reading.problem,
      entries: reading.entries,
    };
  }

  // -------------------------------------------------------------------------
  // 写：MCP 的两个可编辑作用域（一次只动一条）
  // -------------------------------------------------------------------------

  /**
   * 存一条 MCP 条目（F-G1 / F-F6）：`entry.id` 在这一层里就改那一条，没有就建。
   *
   * 写回的口径（与 `deleteMcpEntry` 共用同一份合并规则）：
   *   - 这个 id 的磁盘原文是底，覆盖入参里明确给了的字段，`extra` 最后叠上去 ——
   *     于是这一版不认识的键与没被提到的 `oauth` 都原样留着（F-F6）；
   *   - `oauth.clientSecret` 跟端点密钥同一套：省略 / 等于当前掩码 → 保留原文，空串才清掉
   *     （见 `mergeOauth`）；
   *   - 层里别的条目一个字节都不动：改一条不会把另一条读不全的字段覆盖掉；
   *   - 文件里 `mcpServers` 之外的顶层键也原样带上。
   */
  async writeMcpEntry(
    scope: McpEditableScope,
    entry: McpServerEntryInput,
    cwd: string | null,
  ): Promise<DiscoveryLayerView> {
    const layer = this.writableMcpLayer(scope, cwd);
    const existing = await this.readRawMcpFile(layer.path);
    const id = entryId(entry);
    const servers = {
      ...existing.servers,
      [id]: applyEntryPatch(existing.servers[id], entry),
    };
    await writeJsonFile(layer.path, { ...existing.rest, mcpServers: servers });
    return await this.readMcpLayerView(layer);
  }

  /**
   * 删一条 MCP 条目（F-F6）。
   *
   * 这个 id 本来就不在这一层里时落盘内容不变，回报 `removed: false`（不是失败）。
   * 文件坏了但用户要清掉一个条目时，`readRawMcpFile` 把读不出来的那份当空 —— 于是这次写入
   * 会用一份合法 JSON 覆盖它，这与「坏文件要能修」（F-F6）是同一个动作。
   */
  async deleteMcpEntry(
    scope: McpEditableScope,
    id: string,
    cwd: string | null,
  ): Promise<{ layer: DiscoveryLayerView; removed: boolean }> {
    const key = id.trim();
    if (key === "") {
      throw new HostError("invalid_params", {
        params: { field: "id" },
        detail: { field: "id", reason: "empty" },
      });
    }
    const layer = this.writableMcpLayer(scope, cwd);
    const existing = await this.readRawMcpFile(layer.path);
    const removed = Object.prototype.hasOwnProperty.call(existing.servers, key);
    if (removed) {
      const { [key]: _gone, ...servers } = existing.servers;
      void _gone;
      await writeJsonFile(layer.path, { ...existing.rest, mcpServers: servers });
    }
    return { layer: await this.readMcpLayerView(layer), removed };
  }

  /** 可写作用域 → 那一层；`workspace` 作用域必须能落到某个项目里（空串也算没给） */
  private writableMcpLayer(scope: McpEditableScope, cwd: string | null): DiscoveryLayerPath {
    const editable = this.editableMcpLayers(cwd);
    if (scope === "user") return editable.user;
    if (editable.workspace === null || (cwd ?? "").trim() === "") {
      throw new HostError("invalid_params", {
        params: { field: "workspaceId" },
        detail: { field: "workspaceId", reason: "workspace_scope_needs_workspace" },
      });
    }
    return editable.workspace;
  }

  // -------------------------------------------------------------------------
  // 内部：MCP
  // -------------------------------------------------------------------------

  private async readMcpLayers(cwd: string | null): Promise<DiscoveryLayerView[]> {
    const layers = this.mcpLayers(cwd);
    const views: DiscoveryLayerView[] = [];
    // 近的层先读：同一 id 被更近的层定义过时，远的这一条要标上「被谁覆盖」
    const takenBy = new Map<string, string>();
    for (const layer of layers) {
      const reading = await this.readMcpFile(layer.path);
      const entries = reading.entries.map((entry) => {
        const winner = takenBy.get(entry.id);
        if (winner === undefined) {
          takenBy.set(entry.id, layer.path);
          return entry;
        }
        return {
          ...entry,
          problem: problem(
            "discovery.shadowed",
            { path: winner },
            {
              id: entry.id,
              reason: "overridden",
              by: winner,
            },
          ),
        };
      });
      views.push({
        kind: "mcps",
        depth: layer.depth,
        path: layer.path,
        editable: layer.editable,
        scope: layer.scope,
        state: reading.state,
        problem: reading.problem,
        entries,
      });
    }
    return views;
  }

  /** 读一个 mcp.json：不存在 / 坏了 / 能读 三种结论分开（F-F6） */
  private async readMcpFile(path: string): Promise<LayerReading> {
    const raw = await this.readRawMcpFile(path);
    if (raw.state !== "ok") return { state: raw.state, problem: raw.problem, entries: [] };

    const entries: DiscoveryEntryView[] = [];
    for (const [id, value] of Object.entries(raw.servers)) {
      entries.push(mcpEntryView(id, value, path));
    }
    return { state: "ok", problem: null, entries: sortEntries(entries) };
  }

  /**
   * 读 mcp.json 的原文。
   *
   * `broken` 与 `missing` 必须分开：`missing` 是「这里没有这一层」（正常），`broken` 是
   * 「文件在，但读不成配置」（用户改了、改坏了，界面要能看见并修）。
   */
  private async readRawMcpFile(path: string): Promise<{
    state: "missing" | "ok" | "broken";
    problem: ProblemFact | null;
    /** `mcpServers` 里的原始条目（保留未知字段） */
    servers: Record<string, unknown>;
    /** 文件里 `mcpServers` 之外的顶层键，写回时原样带上 */
    rest: Record<string, unknown>;
  }> {
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf-8");
    } catch (error) {
      if (isNotFound(error)) {
        return { state: "missing", problem: null, servers: {}, rest: {} };
      }
      return {
        state: "broken",
        problem: problem(
          "config.fileBroken",
          { path, reason: reasonOf(error) },
          {
            path,
            reason: "unreadable",
          },
        ),
        servers: {},
        rest: {},
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        state: "broken",
        problem: problem(
          "config.fileBroken",
          { path, reason: reasonOf(error) },
          {
            path,
            reason: "invalid_json",
          },
        ),
        servers: {},
        rest: {},
      };
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        state: "broken",
        problem: problem(
          "config.fileBroken",
          { path, reason: "not a JSON object" },
          {
            path,
            reason: "not_an_object",
          },
        ),
        servers: {},
        rest: {},
      };
    }

    const record = parsed as Record<string, unknown>;
    const servers = record.mcpServers;
    if (
      servers !== undefined &&
      (typeof servers !== "object" || servers === null || Array.isArray(servers))
    ) {
      return {
        state: "broken",
        problem: problem(
          "config.fileBroken",
          { path, reason: "mcpServers is not an object" },
          {
            path,
            reason: "servers_not_an_object",
          },
        ),
        servers: {},
        rest: {},
      };
    }

    const { mcpServers: _ignored, ...rest } = record;
    void _ignored;
    return {
      state: "ok",
      problem: null,
      servers: (servers as Record<string, unknown> | undefined) ?? {},
      rest,
    };
  }

  // -------------------------------------------------------------------------
  // 内部：目录类（skills / tools / subagents）
  // -------------------------------------------------------------------------

  private async readDirectoryLayers(
    kind: Exclude<DiscoveryKind, "mcps">,
    layers: DiscoveryLayerPath[],
  ): Promise<DiscoveryLayerView[]> {
    const views: DiscoveryLayerView[] = [];
    const takenBy = new Map<string, string>();
    for (const layer of layers) {
      const reading = await this.readDirectory(kind, layer.path);
      const entries = reading.entries.map((entry) => {
        const winner = takenBy.get(entry.id);
        if (winner === undefined) {
          takenBy.set(entry.id, layer.path);
          return entry;
        }
        return {
          ...entry,
          problem: problem(
            "discovery.shadowed",
            { path: winner },
            {
              id: entry.id,
              reason: "overridden",
              by: winner,
            },
          ),
        };
      });
      views.push({
        kind,
        depth: layer.depth,
        path: layer.path,
        editable: layer.editable,
        // 目录类能力（Skill / 工具 / subagent）没有「按作用域写入」这回事（F-G2）
        scope: layer.scope,
        state: reading.state,
        problem: reading.problem,
        entries,
      });
    }
    return views;
  }

  /** 按种类读一个目录；目录不存在就是 `missing`，不是目录或读不了就是 `broken` */
  private async readDirectory(
    kind: Exclude<DiscoveryKind, "mcps">,
    dir: string,
  ): Promise<LayerReading> {
    let info;
    try {
      info = await fs.stat(dir);
    } catch (error) {
      if (isNotFound(error)) return { state: "missing", problem: null, entries: [] };
      return {
        state: "broken",
        problem: problem(
          "config.fileBroken",
          { path: dir, reason: reasonOf(error) },
          {
            path: dir,
            reason: "unreadable",
          },
        ),
        entries: [],
      };
    }
    if (!info.isDirectory()) {
      return {
        state: "broken",
        problem: problem(
          "discovery.notADirectory",
          { path: dir },
          {
            path: dir,
            reason: "not_a_directory",
          },
        ),
        entries: [],
      };
    }

    if (kind === "skills") return await this.readSkillLayer(dir);
    if (kind === "tools") return await this.readToolLayer(dir);
    return await this.readSubAgentLayer(dir);
  }

  /**
   * 一层的 Skill。
   *
   * 有效条目交给 SDK 的 `discoverSkills`（frontmatter 的解析口径只该有一份）；
   * 另外再读一次目录，把「有 SKILL.md 却没被认成 Skill」的那些也报出来 —— 用户手改坏了要看得见。
   */
  private async readSkillLayer(dir: string): Promise<LayerReading> {
    let discovered;
    try {
      discovered = await discoverSkills([dir], { silent: true, logger: this.logger });
    } catch (error) {
      return {
        state: "broken",
        problem: problem(
          "config.fileBroken",
          { path: dir, reason: reasonOf(error) },
          {
            path: dir,
            reason: "discovery_failed",
          },
        ),
        entries: [],
      };
    }

    const entries: DiscoveryEntryView[] = discovered.map((skill) =>
      directoryEntry({
        id: skill.id,
        name: skill.name,
        description: skill.description === "" ? null : skill.description,
        source: skill.dirPath,
        enabled: true,
        problem: null,
      }),
    );

    const known = new Set(entries.map((entry) => entry.id));
    for (const name of await listSubdirectories(dir)) {
      if (known.has(name)) continue;
      if (!(await fileExists(join(dir, name, "SKILL.md")))) continue;
      entries.push(
        directoryEntry({
          id: name,
          name,
          description: null,
          source: join(dir, name),
          enabled: false,
          problem: problem(
            "discovery.skillBroken",
            { name, reason: "no usable frontmatter" },
            {
              path: join(dir, name, "SKILL.md"),
              reason: "invalid_frontmatter",
            },
          ),
        }),
      );
    }
    return { state: "ok", problem: null, entries: sortEntries(entries) };
  }

  /**
   * 一层的用户工具。
   *
   * 以 SDK 的 `discoverUserToolFiles` 为「能不能真的变成一个工具」的判据（它自带 import 护栏与
   * 超时）；没能加载上的 `.js` / `.mjs` 也列出来并说明原因。
   */
  private async readToolLayer(dir: string): Promise<LayerReading> {
    let loaded;
    try {
      loaded = await discoverUserToolFiles([dir], { silent: true, importTimeoutMs: 2_000 });
    } catch (error) {
      return {
        state: "broken",
        problem: problem(
          "config.fileBroken",
          { path: dir, reason: reasonOf(error) },
          {
            path: dir,
            reason: "discovery_failed",
          },
        ),
        entries: [],
      };
    }

    const entries: DiscoveryEntryView[] = loaded.map((tool) =>
      directoryEntry({
        id: tool.name,
        name: tool.name,
        description: null,
        source: tool.path,
        enabled: true,
        problem: null,
      }),
    );

    const known = new Set(entries.map((entry) => entry.id));
    for (const file of await listFiles(dir)) {
      const extension = TOOL_FILE_EXTENSIONS.find((candidate) => file.endsWith(candidate));
      if (extension === undefined) continue;
      const name = file.slice(0, -extension.length);
      if (known.has(name)) continue;
      entries.push(
        directoryEntry({
          id: name,
          name,
          description: null,
          source: join(dir, file),
          enabled: false,
          problem: problem(
            "discovery.toolUnloadable",
            { name, reason: "not a loadable tool" },
            {
              path: join(dir, file),
              reason: "load_failed",
            },
          ),
        }),
      );
    }
    return { state: "ok", problem: null, entries: sortEntries(entries) };
  }

  /**
   * 一层的 subagent。
   *
   * 「什么算 subagent」由 SDK 的 `discoverSubAgents` 说了算（有 `function` 定义的那些）；
   * 这里自己再读一遍文件，是为了拿到每个定义来自哪个文件（`source`）以及读不出来的那几个。
   */
  private async readSubAgentLayer(dir: string): Promise<LayerReading> {
    let discovered;
    try {
      discovered = await discoverSubAgents([dir], { logger: this.logger });
    } catch (error) {
      return {
        state: "broken",
        problem: problem(
          "config.fileBroken",
          { path: dir, reason: reasonOf(error) },
          {
            path: dir,
            reason: "discovery_failed",
          },
        ),
        entries: [],
      };
    }

    const entries: DiscoveryEntryView[] = [];
    for (const definition of discovered) {
      entries.push(
        directoryEntry({
          id: definition.id,
          name: definition.name,
          description: definition.function?.description ?? definition.description ?? null,
          source: join(dir, `${definition.id}.json`),
          enabled: true,
          problem: null,
        }),
      );
    }

    const known = new Set(discovered.map((definition) => definition.id));
    for (const file of await listFiles(dir)) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -".json".length);
      // 已经被认成 subagent 的那些跳过；其余文件要么读不出来，要么不是 subagent 定义
      if (known.has(id)) continue;
      const path = join(dir, file);
      const parsed = await readJsonOrNull(path);
      const usable = parsed !== null && typeof parsed === "object" && "function" in parsed;
      if (usable) continue;
      entries.push(
        directoryEntry({
          id,
          name: id,
          description: null,
          source: path,
          enabled: false,
          problem: problem(
            "discovery.subAgentBroken",
            {
              name: id,
              reason: parsed === null ? "not readable as JSON" : "no function definition",
            },
            { path, reason: parsed === null ? "invalid_json" : "missing_function" },
          ),
        }),
      );
    }
    return { state: "ok", problem: null, entries: sortEntries(entries) };
  }

  // -------------------------------------------------------------------------
  // 内部：workspace
  // -------------------------------------------------------------------------

  /** 入参的 workspaceId → cwd；没给就是 `null`（只报与项目无关的那几层） */
  private async resolveCwd(workspaceId: string | undefined): Promise<string | null> {
    if (workspaceId === undefined || workspaceId.trim() === "") return null;
    const found = this.findWorkspace ? await this.findWorkspace(workspaceId) : undefined;
    if (!found) {
      throw new HostError("not_found", {
        params: { entity: "workspace" },
        detail: {
          workspaceId,
          reason: this.findWorkspace ? "workspace_not_found" : "workspace_lookup_not_configured",
        },
      });
    }
    return found.cwd;
  }
}

// ---------------------------------------------------------------------------
// MCP 条目：原文 → 视图、入参 → 原文
// ---------------------------------------------------------------------------

/** 一条项目侧的层路径；没有 cwd（还没打开项目）时为 `null` */
function projectLayer(
  cwd: string | null,
  depth: number,
  relative: string,
  owner: "workspace" | "other",
): DiscoveryLayerPath | null {
  if (cwd === null) return null;
  return {
    depth,
    path: join(cwd, relative),
    editable: false,
    scope: null,
    owner,
  };
}

/** 去掉「这个场景下不存在的那几层」 */
function withoutNulls(layers: (DiscoveryLayerPath | null)[]): DiscoveryLayerPath[] {
  return layers.filter((layer): layer is DiscoveryLayerPath => layer !== null);
}

/**
 * 目录类条目（Skill / 工具 / subagent）。
 *
 * 它们的传输、命令、地址这些字段不存在（F-G2 那几类不靠传输启动），`extra` 也没有写回的路。
 * 空值在这里一次填好，免得每个构造点各写一遍。
 */
function directoryEntry(
  base: Pick<DiscoveryEntryView, "id" | "name" | "description" | "source" | "enabled" | "problem">,
): DiscoveryEntryView {
  return {
    ...base,
    transport: null,
    command: null,
    args: null,
    env: null,
    url: null,
    headers: null,
    oauth: null,
    extra: {},
  };
}

/** 传输方式在磁盘上的几种写法（SDK 优先取 `type`，兼容后两个别名） */
const TRANSPORT_KEYS = ["type", "transport", "transportType"] as const;

/**
 * 条目的已知键：不在这份清单里的才进 `extra`。
 *
 * 与入参对齐（`McpServerEntryInput` 的字段 + 传输方式的三个写法）；`disabled` 是磁盘上的开关，
 * 视图里折成 `enabled`。
 */
const KNOWN_ENTRY_KEYS: readonly string[] = [
  ...TRANSPORT_KEYS,
  "description",
  "disabled",
  "command",
  "args",
  "env",
  "url",
  "headers",
  "oauth",
];

/**
 * 把一个原始条目变成视图。
 *
 * 已知字段按 SDK 的 `McpServerConfig` 摊开（F-F6：客户端要能看见这条服务器是怎么起的）；
 * 这一版不认识的键归 `extra`，写回时逐字带回。
 */
function mcpEntryView(id: string, value: unknown, source: string): DiscoveryEntryView {
  const raw = asRecord(value);
  if (raw === null) {
    return {
      id,
      name: id,
      description: null,
      source,
      enabled: false,
      problem: problem(
        "discovery.mcpEntryInvalid",
        { name: id },
        {
          path: source,
          reason: "entry_not_an_object",
        },
      ),
      transport: null,
      command: null,
      args: null,
      env: null,
      url: null,
      headers: null,
      oauth: null,
      extra: {},
    };
  }

  const declared = raw.type ?? raw.transport ?? raw.transportType;
  const inferred =
    typeof raw.command === "string" ? "stdio" : typeof raw.url === "string" ? "http" : null;
  const resolved = typeof declared === "string" ? declared : inferred;

  return {
    id,
    name: id,
    description: typeof raw.description === "string" ? raw.description : null,
    source,
    enabled: raw.disabled !== true,
    problem:
      resolved === null || !isKnownTransport(resolved)
        ? problem(
            "discovery.mcpEntryInvalid",
            { name: id },
            {
              path: source,
              reason: declared === undefined ? "missing_transport" : "unknown_transport",
              transport: declared,
            },
          )
        : null,
    transport: resolved !== null && isKnownTransport(resolved) ? resolved : null,
    command: typeof raw.command === "string" ? raw.command : null,
    args: stringList(raw.args),
    env: stringMap(raw.env),
    url: typeof raw.url === "string" ? raw.url : null,
    headers: stringMap(raw.headers),
    oauth: oauthOf(raw.oauth),
    extra: extraOf(raw),
  };
}

function isKnownTransport(value: string): value is McpServerConfig["transport"] {
  return value === "stdio" || value === "http" || value === "sse";
}

/** 字符串数组；形状不对按「没有」报，原值仍然留在磁盘上（写回时省略这一项即不动它） */
function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item): item is string => typeof item === "string") ? [...value] : null;
}

/** 字符串到字符串的表（`env` / `headers`）；形状不对按「没有」报，理由同上 */
function stringMap(value: unknown): Record<string, string> | null {
  const record = asRecord(value);
  if (record === null) return null;
  const entries = Object.entries(record);
  if (!entries.every(([, item]) => typeof item === "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * oauth 的四个必填项 + 两个可选项；形状不对（改坏了）按「没有」报。
 *
 * 密钥在这里就换掩码（F-F2：明文不出网）：返回的是 `McpOauthView`，只有
 * `clientSecretMasked` / `clientSecretSet`，明文连视图对象都进不去。
 */
function oauthOf(value: unknown): McpOauthView | null {
  const record = asRecord(value);
  if (record === null) return null;
  const { authorizationUrl, tokenUrl, clientId, clientSecret, scope } = record;
  if (typeof authorizationUrl !== "string") return null;
  if (typeof tokenUrl !== "string") return null;
  if (typeof clientId !== "string") return null;
  const secret = typeof clientSecret === "string" ? clientSecret : "";
  return {
    authorizationUrl,
    tokenUrl,
    clientId,
    clientSecretMasked: maskSecret(secret),
    clientSecretSet: secret.trim() !== "",
    ...(typeof scope === "string" ? { scope } : {}),
  };
}

/** 这一版不认识的键（原样，不做归并与解释） */
function extraOf(raw: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_ENTRY_KEYS.includes(key)) extra[key] = value;
  }
  return extra;
}

/** 取写入条目的 id 并盯住传输方式（空 id / 不认识的传输方式没地方落地，当场拒） */
function entryId(entry: McpServerEntryInput): string {
  const id = typeof entry?.id === "string" ? entry.id.trim() : "";
  if (id === "") {
    throw new HostError("invalid_params", {
      params: { field: "entry.id" },
      detail: { field: "entry.id", reason: "empty" },
    });
  }
  if (typeof entry.transport !== "string" || !isKnownTransport(entry.transport)) {
    throw new HostError("invalid_params", {
      params: { field: "entry.transport" },
      detail: {
        field: "entry.transport",
        reason: "unknown_transport",
        value: entry.transport,
        allowed: ["stdio", "http", "sse"],
      },
    });
  }
  return id;
}

/** 传输方式写到哪个键上：沿用磁盘里已有的那个写法，没有就写 `type` */
function transportKeyOf(previous: Record<string, unknown>): string {
  return TRANSPORT_KEYS.find((key) => key in previous) ?? "type";
}

/**
 * 一条入参 → 磁盘上这个 id 的原文。
 *
 * 以磁盘原文为底：`extra` 先叠上，入参里明确给了的已知字段最后覆盖 —— `undefined` 表示
 * 「这次不改它」，于是磁盘上那个值留着。这样一次只改一条的写入不会把这一版不认识的键、
 * 没被提到的 `oauth`、或客户端看不全的字段弄丢（F-F6）。
 */
function applyEntryPatch(previous: unknown, entry: McpServerEntryInput): Record<string, unknown> {
  const base = asRecord(previous) ?? {};
  const next: Record<string, unknown> = { ...base, ...(entry.extra ?? {}) };

  next[transportKeyOf(base)] = entry.transport;
  assign(next, "description", entry.description);
  assign(next, "disabled", entry.disabled);
  assign(next, "command", entry.command);
  assign(next, "args", entry.args);
  assign(next, "env", entry.env);
  assign(next, "url", entry.url);
  assign(next, "headers", entry.headers);
  mergeOauth(next, base, entry.oauth);
  return next;
}

/**
 * oauth 的合并（F-F2 的密钥口径在 MCP 这边落地的地方）。
 *
 * `oauth` 本身仍是「给了就换」，但里面的 `clientSecret` 跟端点密钥同一套规则：
 *   - 省略 → 保留磁盘原值；
 *   - 等于当前掩码（客户端把读到的整行原样写回来）→ 同样保留原值；
 *   - 空串 → 清掉这一项；
 *   - 其余 → 用新值。
 * 于是「客户端把掩码当密钥写回去」不会落盘。
 */
function mergeOauth(
  next: Record<string, unknown>,
  base: Record<string, unknown>,
  incoming: McpServerEntryInput["oauth"],
): void {
  if (incoming === undefined) return;
  const previous = asRecord(base.oauth);
  const current = typeof previous?.clientSecret === "string" ? previous.clientSecret : "";
  const { clientSecret, ...rest } = incoming;

  const merged: Record<string, unknown> = { ...previous, ...rest };
  const secret =
    clientSecret === undefined || isSecretMask(clientSecret, current)
      ? current
      : clientSecret.trim();
  if (secret !== "") merged.clientSecret = secret;
  else delete merged.clientSecret;

  next.oauth = merged;
}

/** 只在入参真的给了这个字段时覆盖（`undefined` 表示「这次不改它」） */
function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 文件系统小工具
// ---------------------------------------------------------------------------

/** 原子写一个 JSON 文件（先写 `.tmp` 再 rename，避免留下半截文件） */
async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, path);
}

/** `ENOENT` 之类的「这里什么都没有」 */
function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code === "ENOENT" ||
        (error as { code?: unknown }).code === "ENOTDIR"
    : false;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await fs.stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function readJsonOrNull(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // 走到这里只剩两种情形：调用前 `stat` 过了、目录刚被删掉，或没有读权限 ——
    // 两种都按「这一层没有条目」报（层本身的 broken 已经由 `readDirectory` 报过）
    return [];
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // 同 `listSubdirectories`：目录在 `stat` 之后刚被删、或没有读权限，按空报
    return [];
  }
}

/** 条目排序：能用的在前、同组按名字，保证同一份磁盘状态每次给同一个顺序 */
function sortEntries(entries: DiscoveryEntryView[]): DiscoveryEntryView[] {
  return [...entries].sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}
