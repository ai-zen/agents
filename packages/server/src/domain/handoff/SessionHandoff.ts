/**
 * 会话交接 —— `/handoff`（只写文档）与 `/migrate`（交接 + 开新会话）的服务端版本。
 *
 * ## 为什么服务端只包一层，业务全在 SDK
 *
 * 「停工 → 读 Skill → 写文档 → 校验 → self 失败降级 summary → 按策略处置历史（`prune`
 * 剔除 / `omit` 标记）→ 注入交接断点」这一整套在 SDK 的 `HandoffService` 里，是**与产品
 * 无关**的流程。CLI 时代这一层补的是
 * 产品侧副作用（进度提示、旧会话存档、新会话落盘），本文件同样是这个角色，只是副作用
 * 换成了服务端的三件事：
 *
 *   - 进度**只发通知**（`code + params`），文案由客户端查自己的 i18n 表 —— 一个服务端
 *     同时接中文终端和英文浏览器时，只能挑一种语言撒谎；
 *   - 存档与换 id 是**会话层**的事（谁持有活会话注册表谁做），不塞进钩子：交接的钩子
 *     被 SDK 的 `safeHook` 包着，钩子里抛错只会被记一条日志然后照常往下跑 —— 存档失败
 *     却继续 prune，等于把旧历史真丢了。所以会话管理器把「先存档、再交接、最后换 id」
 *     写成三条顺序语句，各自的失败都冒泡给调用方。
 *   - 交接文档落在 `<工作区>/.ai-zen/handoffs/`：随项目走，便于评审与随仓库共享。
 *
 * ## 一个实例 = 一段会话
 *
 * `HandoffService` 自带 `busy` 与取消句柄（`session.cancel` 要能掐断正在写文档的那一轮），
 * 所以实例按会话持有，不按调用新建。它同时也被 `agent.use()` 注册过一个守卫插件，
 * 复用实例避免插件数组无限增长。
 */

import { join } from "node:path";
import {
  HandoffAbortedError,
  HandoffService,
  type SdkAgent,
  type HandoffContext,
} from "@ai-zen/agents-sdk";
import type { HandoffMode, MigrationStrategy, NoticePayload } from "../../protocol/index.js";
import { DEFAULT_MIGRATION_STRATEGY } from "../../wire/sessions.js";
import { agentPaths } from "../agent/agentPaths.js";

/**
 * 交接需要的 Agent 面（结构类型）。
 *
 * SDK 的入参声明是 `SdkAgent`（类类型），而会话管理器只持有 `AgentLike`。这里列出
 * `HandoffService` 真正会碰的东西，真件（SDK 的 `SdkAgent`）天然满足它，测试里的假件
 * 也能满足 —— 于是「假件能不能跑交接」是一条显式契约，而不是隐式约定。
 */
export interface HandoffAgentLike {
  /** 当前消息。**读写**：`migrate()` 会把它整体换成「模板 + 交接断点」 */
  messages: unknown[];
  /** 剔除历史时保留的模板（系统提示等） */
  definition: { messages?: unknown[] };
  /** 有没有 `write` 工具决定 `self` 可用性 */
  tools?: Array<{ function?: { name?: string } }>;
  /** `summary` 模式回退用的模型名与参数、客户端 */
  model?: string;
  modelConfig?: Record<string, unknown>;
  client?: unknown;
  /** `self` 模式的交接回合 */
  send(input: string): Promise<unknown>;
  abort(): void;
  /** 注册交接守卫（`Agent.use()` 无移除 API，SDK 侧按 agent 只注册一次） */
  use(plugin: unknown): void;
  /** 交接回合的守卫要放行的目录（`scope.cwd`） */
  scope?: { cwd?: string };
}

/** 一次交接的结果（`handoff` 与 `migrate` 同形：差别只在会话 id 由谁换） */
export interface HandoffOutcome {
  handoffPath: string;
  /** **实际**执行者：请求 `self` 但降级时会不是 `self` */
  mode: HandoffMode;
}

export interface SessionHandoffOptions {
  /** 配置根（`~/.ai-zen`）：`handoff` Skill 的全局候选目录在这里面 */
  aiZenDir: string;
  /** 用户主目录（业界通用 `~/.agents` 的位置） */
  homeDir: string;
  /** 工作区路径：文档落 `<path>/.ai-zen/handoffs`，Skill 也先在项目里找 */
  workspacePath: string;
  /** 发一条对话内通知（会话层转成 `session-notice`；本层不产文案） */
  notice: (notice: NoticePayload) => void;
}

export class SessionHandoff {
  private readonly service: HandoffService;

  constructor(options: SessionHandoffOptions) {
    const { aiZenDir, homeDir, workspacePath, notice } = options;
    const paths = agentPaths({ aiZenDir, workspacePath, homeDir });

    this.service = new HandoffService({
      // 交接文档跟着项目走（与 CLI 的 `<cwd>/.ai-zen/handoffs` 是同一个位置）
      handoffDir: join(workspacePath, ".ai-zen", "handoffs"),
      // 不在这里写 `strategy`：历史怎么处置由**调用方**决定（`migrate()` 的第三个参数），
      // 因为它与「换不换 sessionId」是同一件事（见协议里的 `MigrationStrategy`）。写在这
      // 里就是第二份缺省值，而它曾把 `omit` 路径静默地变成了 `prune`。
      // 交接模板的唯一真相源是磁盘上的 `handoff` Skill（可被项目级覆盖）。
      // 不预先筛存在性：`HandoffService` 拿 `readSkill()` 逐目录试读，读不到就落兜底模板，
      // 而那条 warn 会列出真实路径 —— 预筛只会让日志变成「none configured」，更难排查。
      skillDirs: paths.skillsDirs,
      onBeforeHandoff: (ctx: HandoffContext) => {
        // 自动迁移（用量超阈值触发）与手动 `/handoff` 是两种语义：前者的「何时」不是用户
        // 决定的，得让它知道「上下文快满了，正在交接」，否则只会看到会话自己换了话题
        const { promptTokens, handoffTokens } = ctx;
        if (promptTokens != null && handoffTokens != null) {
          notice({
            level: "info",
            code: "handoffAutoDetected",
            params: { used: promptTokens, limit: handoffTokens, mode: ctx.requestedMode },
          });
          return;
        }
        notice({
          level: "info",
          code: "handoffWriting",
          params: { mode: ctx.requestedMode },
        });
      },
      onHandoff: (ctx: HandoffContext) => {
        // 请求 self 却降级到 summary：用户得知道文档质量是打折的
        if (ctx.mode !== ctx.requestedMode) {
          notice({
            level: "warn",
            code: "migrationDegraded",
            params: { requested: ctx.requestedMode, mode: ctx.mode },
          });
        }
        notice({
          level: "info",
          code: "handoffPath",
          params: { path: ctx.handoffPath },
        });
      },
      /**
       * 迁移落地（新会话已经换好 id、历史已剔除）。
       *
       * 两条通知：一条「迁移完成（共 n 条消息）」+ 一条「新助手会先读交接文档」。
       * 为什么走通知而不是文本：服务端不产文案 —— 句子由客户端按 `code` 查自己的词典。
       */
      onMigrated: (ctx: HandoffContext) => {
        const count = (ctx.agent as { messages?: unknown[] } | undefined)?.messages?.length ?? 0;
        notice({
          level: "info",
          code: "handoffMigrated",
          params: { n: count },
        });
        notice({ level: "info", code: "handoffMigratedHint" });
      },
    });
  }

  /** 是否正在交接（`session.cancel` 与将来的自动迁移让行都看它） */
  get busy(): boolean {
    return this.service.busy;
  }

  /** 取消进行中的交接（用户按 Ctrl+C）：服务负责停下并回到交接前，不再重试、不降级 */
  abort(): void {
    this.service.abort();
  }

  /** 只产出交接文档：不换 id、不剔历史（交接回合留在会话里，用户可继续打磨） */
  async handoff(agent: HandoffAgentLike, mode?: HandoffMode): Promise<HandoffOutcome> {
    const ctx = await this.service.handoff({ agent: asSdkAgent(agent), mode });
    return { handoffPath: ctx.handoffPath, mode: ctx.mode };
  }

  /**
   * 交接 + 按 `strategy` 处置历史。换不换 id 由会话层接着做（见本文件头的「为什么」）。
   *
   * `strategy` **必须**由调用方递下去：SDK 的默认值是 `omit`，而服务端的缺省是 `prune`
   * （分家之前的行为，见协议里的 `DEFAULT_MIGRATION_STRATEGY`）。中间这一跳丢了它，用户传的
   * `omit` 就会静默变成 SDK 的默认值，而两条路对「这段会话还叫不叫这个名字」的结论完全相反。
   */
  async migrate(
    agent: HandoffAgentLike,
    mode?: HandoffMode,
    strategy: MigrationStrategy = DEFAULT_MIGRATION_STRATEGY,
  ): Promise<HandoffOutcome> {
    const ctx = await this.service.migrate({ agent: asSdkAgent(agent), mode, strategy });
    return { handoffPath: ctx.handoffPath, mode: ctx.mode };
  }
}

/** 错误是否来自「用户取消」：取消不是失败，调用方该静默收尾而不是报错 */
export function isHandoffAborted(error: unknown): boolean {
  return error instanceof HandoffAbortedError;
}

/**
 * 结构类型 → SDK 类类型的那一次转换。
 *
 * 断言收在这一处：散在调用点会让「假件也能跑交接」变成隐式约定。真件就是 SDK 的
 * `SdkAgent`（会话由 SDK 的 `createAgent` 装配），所以运行时没有转换，只有类型上的收口。
 */
function asSdkAgent(agent: HandoffAgentLike): SdkAgent {
  return agent as unknown as SdkAgent;
}
