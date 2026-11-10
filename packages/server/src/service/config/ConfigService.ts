/**
 * 配置与 Agent 定义的服务端封装 —— TUI 配置中心那整套本地读写搬到这里。
 *
 * ## 为什么这一层存在
 *
 * 配置中心此前在**客户端**直接读写本地磁盘（`/model`、`/think`、`/mcp`、Agent 编辑屏
 * 全是）。两端在同一台机器时看不出问题；一旦客户端跑在笔记本上、服务端跑在开发机上，
 * 「我在笔记本上改的配置」和「服务端 Agent 实际用的配置」就是两份互不相干的事实 ——
 * 而且错得很安静：界面显示成功，跑起来还是旧模型。现在所有落盘都在服务端，客户端
 * 只负责渲染。
 *
 * ## 为什么所有路径都由构造参数注入
 *
 * 本包纪律：`service/` 不读进程级全局路径（否则「局部可实例化」和「一个进程服务多个
 * 工作区」两个前提同时破产）。配置根由组装根解析成绝对路径再传进来，这里只做拼接。
 *
 * ## 业务不在这里重写
 *
 * 读配置要「读到即迁移」、写要「原子换名」、Agent 定义是「一实体一 JSON 文件」，
 * 这些都在 SDK 里（`ConfigManager` / `AgentRepository`），本文件只做**一层的业务封装**：
 * 把「作用域 / kind」这类产品概念翻译成路径与仓储，再加两处产品语义（见下面两个
 * 「产品语义」注释）。自己另写一套读写，等于让两个地方各有一份迁移规则，迟早漂移。
 *
 * ## 一处刻意的例外：不做 bootstrap
 *
 * CLI 的 `saveConfig` 会先 `ensureConfigDir()`（内含 `bootstrap()`）再写。这里不做：
 * 目录与出厂默认文件的初始化是**组装根**的职责（服务端启动时做一次，`SessionAgentFactory`
 * 已经这么干了）。读写路径上再 bootstrap 一次，会让「客户端保存一份配置」顺带把
 * 出厂 Agent / Skill / 策略表也释放一遍 —— 那是另一个动作，不该藏在写配置里。
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import {
  AgentRepository,
  ConfigManager,
  type AgentDefinition,
  type AppConfig,
} from "@ai-zen/agents-sdk";
import { readWorkspace } from "../workspace/workspace.js";
import type {
  AgentGetResult,
  AgentKind,
  AgentListResult,
  AgentRemoveResult,
  AgentSaveResult,
  ConfigGetResult,
  ConfigMcpGetResult,
  ConfigMcpSaveResult,
  ConfigReasoningPresetsResult,
  ConfigSaveResult,
  ConfigSetDefaultAgentResult,
  ConfigSetDefaultModelResult,
  McpScope,
} from "@ai-zen/agents-protocol";
import { ERROR_CODES, codedError } from "@ai-zen/agents-protocol";

export interface ConfigServiceOptions {
  /** `<配置根>/config.json` */
  configFile: string;
  /** `<配置根>/agents`（顶层 Agent 定义目录） */
  agentsDir: string;
  /** `<配置根>/sub-agents`（子 Agent 定义目录） */
  subAgentsDir: string;
  /** `<配置根>/mcp.json`（全局 MCP 配置） */
  globalMcpFile: string;
  /** `<配置根>/workspaces`（project 作用域要靠它找回工作区路径） */
  workspacesRoot: string;
  /**
   * 配置写盘后通知装配方「你手里的 Scope 过期了」（不注入则什么都不做）。
   *
   * ## 为什么必须在这里调，而不是让客户端改完配置自己 reload
   *
   * `Scope` 里存着一份配置快照（端点、模型清单、`defaultModel`……），而它是**按工作区缓存**
   * 的。写完配置不丢它，那个工作区接下来的所有会话就都在用旧快照 —— 典型症状是两个：
   * 「刚改的端点 Key 不生效」与「刚配的全局兜底模型还是报没模型」。而且缓存是按工作区的：
   * 客户端只会 reload 它手上那一段会话所在的工作区，**别的工作区照样是旧的** ——
   * 那就变成「谁记得 reload 谁对」，正好是分离要治的那种错。
   *
   * 回调的语义是「全部失效」：配置是全局的，不存在“只影响一个工作区”的配置写入。
   */
  onConfigChanged?: () => void | Promise<void>;
}

export class ConfigService {
  private readonly options: ConfigServiceOptions;

  constructor(options: ConfigServiceOptions) {
    this.options = options;
  }

  // ==================================================================
  // 初始化
  // ==================================================================

  /**
   * 释放配置根：目录、出厂配置、默认 Agent / 子 Agent、出厂策略表、MCP 空配置、技能。
   *
   * 为什么这件事在**服务端启动**时做，而不是在读写路径上顺手做：
   *
   *   - 客户端已经不碰本机配置目录（它在另一台机器上），“首次启动就有默认 Agent”
   *     这件事只能由持有配置的一侧保证；否则新机器上第一个 `agent.list` 拿到空列表，
   *     TUI 连启动都过不去（`app.noAgents`）；
   *   - 也不能挂在 `config.get` / `agent.list` 上“首次读时释放”：那会让一个只读操作
   *     带有写副作用（两客户端并发首次读时还会互相盖）。启动时做一次，之后所有 RPC
   *     看到的是同一份稳定状态。
   *
   * `bootstrap()` 自身幂等（已存在就不动），所以 SessionAgentFactory 里那份按配置文件
   * 只跑一次的初始化与它重得也无害。
   */
  async bootstrap(): Promise<void> {
    await new ConfigManager(this.options.configFile).bootstrap();
  }

  // ==================================================================
  // 全局配置
  // ==================================================================

  /** 读全局配置（缺失时 SDK 回出厂默认；旧字段在读取时就被迁移掉） */
  async get(): Promise<ConfigGetResult> {
    const config = await new ConfigManager(this.options.configFile).read();
    return { config, path: this.options.configFile };
  }

  /**
   * 整份写回全局配置。
   *
   * 用 `ConfigManager.write()` 的**原生行为**（先写 `.tmp` 再 `rename`，中途崩不会留下
   * 半份配置）。刻意不在外面再套一层「出厂托管字段同步」：那是 `bootstrap()` /
   * `ensureDefaultConfig()` 的活儿，写路径上再同步一次，会把用户刚保存的模型清单
   * 立刻改回去。
   */
  async save(config: AppConfig): Promise<ConfigSaveResult> {
    await new ConfigManager(this.options.configFile).write(config);
    await this.notifyChanged();
    return { saved: true };
  }

  /**
   * 写盘之后的唯一收尾动作：告诉装配方「旧配置快照作废」。
   *
   * 集中一处调：每条写路径各自记得调一次，就会漏掉下一条新加的方法。
   */
  private async notifyChanged(): Promise<void> {
    await this.options.onConfigChanged?.();
  }

  /**
   * 换「默认 Agent」—— **只写 `defaultAgent` 一个字段**。
   *
   * 为什么不是让客户端「读出整份 → 改一个字段 → 整份写回」：终端与桌面端并存时，两边
   * 各持有自己的快照，后保存的那个会把对方刚改的字段抹掉。`agent.model.set` 早就按这个
   * 理由做成了窄方法，这条同理。
   *
   * 只写一个字段也意味着**不校验** `agentId` 是否存在：那是客户端切换前的链路校验
   * （Agent 存在 → 绑了模型 → 模型在 → 端点有 Key）的职责，服务端再查一遍就是第二份会
   * 漂的规则。这里只保证配置里那个字段被原样改掉。
   */
  async setDefaultAgent(agentId: string): Promise<ConfigSetDefaultAgentResult> {
    const manager = new ConfigManager(this.options.configFile);
    const config = await manager.read();
    await manager.write({ ...config, defaultAgent: agentId });
    await this.notifyChanged();
    return { agentId };
  }

  /** 读思考策略表（文件缺失或损坏时 SDK 回落出厂种子，不写盘） */
  async reasoningPresets(): Promise<ConfigReasoningPresetsResult> {
    const presets = await new ConfigManager(this.options.configFile).readReasoningPresets();
    return { presets };
  }

  /**
   * 换「全局兜底模型」—— **只写 `defaultModel` 一个字段**（三级解析的最后一级）。
   *
   * 与 `setDefaultAgent` 逐条同理由：不是让客户端「读整份 → 改一个字段 → 整份写回」
   * （多客户端并存时后保存的那个会抹掉对方刚改的字段），而且只写这一位就不会碰到
   * 模型清单 / 端点 / 其他默认值。
   *
   * 同样**不校验** `modelId` 在不在模型清单里：那是客户端切换前的链路校验
   * （模型存在 → 端点有 Key）的事，服务端再查一遍就是第二份会漂的规则；真要写错了，
   * `createAgent` 会在用的时候报 `Model "x" not found`，用户看得见自己写了什么。
   */
  async setDefaultModel(modelId: string): Promise<ConfigSetDefaultModelResult> {
    const manager = new ConfigManager(this.options.configFile);
    const config = await manager.read();
    await manager.write({ ...config, defaultModel: modelId });
    await this.notifyChanged();
    return { modelId };
  }

  // ==================================================================
  // MCP 配置
  // ==================================================================

  /**
   * 读某个作用域的 MCP 配置。
   *
   * **产品语义一**：读不到 / 解析不了的文件返回 `{ ok: false, error }`，不是抛错。
   * 编辑屏必须能显示「这个文件坏了，原因是 X」，并让用户自己决定要不要覆盖；
   * 若在这里抛错，客户端只能看到一个笼统的调用失败，退回「当成空配置」的旧行为 ——
   * 那正是静默丢数据的老路。
   *
   * 「文件不存在」不走这条路：那是正常的空配置（`ok: true` + 空 `mcpServers`）。
   */
  async mcpGet(input: { scope: McpScope; workspaceId?: string }): Promise<ConfigMcpGetResult> {
    // 路径解析的失败（缺 workspaceId、工作区不存在）是真错误，照旧抛出去
    const path = await this.mcpPath(input);

    let raw: string;
    try {
      raw = await fs.readFile(path, "utf-8");
    } catch (cause: unknown) {
      if (fsCodeOf(cause) === "ENOENT") return { ok: true, config: { mcpServers: {} }, path };
      // 权限、是个目录……这些不是「文件坏了」，但也只是把原因交给编辑屏
      return { ok: false, error: messageOf(cause), path };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause: unknown) {
      return { ok: false, error: messageOf(cause), path };
    }

    // 顶层不是对象（`null` / 数组 / 数字）就没法当配置编辑，如实报成坏文件
    if (!isRecord(parsed)) {
      return { ok: false, error: "top-level JSON value is not an object", path };
    }
    // 缺 `mcpServers` 与「空配置」在产品上是同一件事：编辑屏按它遍历服务器列表
    return {
      ok: true,
      config: { mcpServers: isRecord(parsed.mcpServers) ? parsed.mcpServers : {} },
      path,
    };
  }

  /** 整份写回某个作用域的 MCP 配置（原子写；父目录按需创建） */
  async mcpSave(input: {
    scope: McpScope;
    workspaceId?: string;
    config: unknown;
  }): Promise<ConfigMcpSaveResult> {
    const path = await this.mcpPath(input);
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    // 尾换行照 SDK 的写法：项目级 `.ai-zen/mcp.json` 常被提交进仓库，缺尾换行会让
    // 每次保存都多出一行 diff 噪音
    await fs.writeFile(tmp, `${JSON.stringify(input.config, null, 2)}\n`, "utf-8");
    await fs.rename(tmp, path);
    return { saved: true };
  }

  // ==================================================================
  // Agent 定义
  // ==================================================================

  /** 两路定义一起给：配置中心是「顶层 Agent / 子 Agent」两栏，一次拿全少一次往返 */
  async listAgents(): Promise<AgentListResult> {
    return {
      agents: await this.agents().list(),
      subAgents: await this.subAgents().list(),
    };
  }

  /**
   * 按 id 取一份定义。
   *
   * **为什么这里要 `kind`**：`agents/`（顶层）与 `sub-agents/`（子 Agent）里出现同名 id
   * 是常态（都叫 `default` 属于默认情形）。只给 `id` 时无法区分两处，客户端两栏配置中心里
   * 点中子 Agent 的那个 `default`，会拿到顶层那一份 —— 界面显示的名字、导出后改的东西全都
   * 是另一个 Agent 的。所以带了 `kind` 就只查那一个池子。
   *
   * **为什么 `kind` 是可选的**：「只想按 id 看一眼」的老调用还得能写。不指定时的顺序是
   * **顶层优先、其次子 Agent**，写死在这里，客户端不必知道；两栏界面必须显式带 `kind`。
   */
  async getAgent(input: { id: string; kind?: AgentKind }): Promise<AgentGetResult> {
    // 指定了池子就只查那一个：跨池回落会把「子 Agent 里没有这个 id」悄悄变成顶层那份
    if (input.kind) return { agent: await this.repositoryFor(input.kind).read(input.id) };

    const agent = await this.agents().read(input.id);
    if (agent) return { agent };
    return { agent: await this.subAgents().read(input.id) };
  }

  /** 整份写入一份定义（`kind` 决定落到 `agents/` 还是 `sub-agents/`） */
  async saveAgent(kind: AgentKind, definition: AgentDefinition): Promise<AgentSaveResult> {
    await this.repositoryFor(kind).write(definition);
    return { saved: true };
  }

  /**
   * 删一份定义。
   *
   * 先读一次再删，只为把「本来就不存在」如实报成 `removed: false`：仓储的 `delete()`
   * 对不存在的文件静默成功（它不知道调用方要不要区分），而客户端删完要刷新列表，
   * 拿一个恒 `true` 的回答会让它误以为删掉了别的东西。这不是兜底，是产品答案。
   */
  async removeAgent(kind: AgentKind, id: string): Promise<AgentRemoveResult> {
    const repository = this.repositoryFor(kind);
    const existing = await repository.read(id);
    if (!existing) return { removed: false };
    await repository.delete(id);
    return { removed: true };
  }

  // ==================================================================
  // 内部
  // ==================================================================

  private agents(): AgentRepository {
    return new AgentRepository(this.options.agentsDir);
  }

  private subAgents(): AgentRepository {
    return new AgentRepository(this.options.subAgentsDir);
  }

  /** `kind` 就是「哪个目录」，别在调用点各写一份三元表达式 */
  private repositoryFor(kind: AgentKind): AgentRepository {
    return kind === "agent" ? this.agents() : this.subAgents();
  }

  /**
   * 作用域 → mcp.json 的绝对路径。
   *
   *   global  → 注入的 `globalMcpFile`
   *   project → `<工作区路径>/.ai-zen/mcp.json`（与 CLI 的 `/mcp` 项目作用域同一个位置）
   */
  private async mcpPath(input: { scope: McpScope; workspaceId?: string }): Promise<string> {
    if (input.scope === "global") return this.options.globalMcpFile;
    const workspaceId = input.workspaceId;
    if (!workspaceId) {
      // 缺参数是**调用方**的错，且可判别（与 `bad-params` 分开：那个是协议层形状错）
      throw codedError(ERROR_CODES.workspaceRequired, "project scope needs a workspaceId");
    }
    // 工作区路径只能反查：id 是哈希派生的，光看 id 推不回目录（也不该在协议里给路径）
    const workspace = await readWorkspace({
      workspacesRoot: this.options.workspacesRoot,
      id: workspaceId,
    });
    // `null` 涵盖「没这个工作区」「记录坏了」「id 想逃出 workspaces 根」三种
    if (!workspace)
      throw codedError(ERROR_CODES.unknownWorkspace, `unknown workspace: ${workspaceId}`);
    return join(workspace.path, ".ai-zen", "mcp.json");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 取系统错误的 `code`（`ENOENT` / `EACCES` 这类）。
 *
 * 名字不叫 `codeOf`：协议包导出的 `codeOf` 读的是**本项目的错误码表**（`ERROR_CODES`，
 * 也就是帧里那个 `code`），这里读的是 Node 的 errno 字符串 —— 两个概念同名会让人以为
 * 能互换。
 */
function fsCodeOf(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
