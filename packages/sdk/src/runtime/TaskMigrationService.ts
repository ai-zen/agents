import { AgentNS } from "@ai-zen/agents-core";
import type OpenAI from "openai";
import { getLogger, type Logger } from "../shared/logger.js";
import type { SdkAgent } from "./SdkAgent.js";

/**
 * 迁移上下文 — 贯穿「迁移前 → 生成交接文档 → 迁移后」的结构化数据。
 *
 * 供 `TaskMigrationService.migrate` 与钩子（`onBeforeMigrate` / `onMigrated`）使用。
 * 手动迁移与自动迁移共用同一上下文结构，保证上层（CLI）行为一致。
 */
export interface MigrationContext {
  /** 当前对话 Agent（引用不变，仅替换消息列表） */
  agent: SdkAgent;
  /** 生成交接文档所用模型名 */
  model: string;
  /** 当前 prompt token 用量（自动迁移时由 AutoMigratePlugin 提供；手动迁移可省略） */
  promptTokens?: number;
  /** 上下文阈值（自动迁移时由 AutoMigratePlugin 提供；手动迁移可省略） */
  maxTokens?: number;
  /** 序列化后的完整对话历史（迁移输入） */
  historyText: string;
  /** 迁移前消息总数 */
  messageCountBefore: number;
  /** 生成的交接文档（迁移完成后填充） */
  handoffDoc?: string;
}

/**
 * 任务迁移服务构造参数。
 */
export interface TaskMigrationServiceOptions {
  /** 生成交接文档所用客户端（可选；未传则 migrate 时回退到 agent.client） */
  client?: OpenAI;
  /** 生成交接文档所用模型名（可选；未传则 migrate 时回退到 agent.model） */
  model?: string;
  /** 生成交接文档所用模型参数（可选；未传则 migrate 时回退到 agent.modelConfig） */
  modelConfig?: Record<string, unknown>;
  /** 迁移前钩子（服务持有）。迁移开始前触发，此时 agent.messages 仍为完整旧历史 */
  onBeforeMigrate?: (ctx: MigrationContext) => void | Promise<void>;
  /** 迁移后钩子（服务持有）。迁移完成后触发，交接文档已注入 agent.messages */
  onMigrated?: (ctx: MigrationContext) => void | Promise<void>;
  /** 可注入日志（可选，默认使用全局单例） */
  logger?: Logger;
}

/**
 * 任务迁移服务。
 *
 * 一个服务实例对应一次迁移上下文。它**不持有**任何模型调用——生成交接文档时
 * 默认复用传入 `agent`（`SdkAgent`）自身的 `client` / `model` / `modelConfig`，
 * 因此无需 Provider、无需独立「迁移 Agent」对象，也无需自建 OpenAI 客户端。
 * 如需用不同模型生成交接文档，可在构造时显式传入 `client` / `model` / `modelConfig`，
 * 未传则 migrate 时回退到 agent 自带的配置。
 *
 * 职责：
 *   1. 生成交接文档的提示词 / 注入格式（静态纯工具，供上层使用）
 *   2. 执行完整迁移（串行化 → 模型生成 → 标记历史 omit + 追加对话断点），并暴露迁移前后钩子（实例方法）
 *
 * 设计上，`AutoMigratePlugin` 只负责「何时触发」（检测 token 超限），
 * 实际迁移逻辑统一收敛到本服务，从而让手动迁移与自动迁移复用同一条链路。
 */
export class TaskMigrationService {
  static readonly HANDOFF_SECTIONS = {
    breakpoint: "## 💬 对话断点",
    completed: "## ✅ 已完成的任务",
    pending: "## 📋 未完成的任务",
    memory: "## 🧠 重要记忆",
    files: "## 📁 文件索引",
    instructions: "## 🔔 接手指令",
  } as const;

  private onBeforeMigrate?: (ctx: MigrationContext) => void | Promise<void>;
  private onMigrated?: (ctx: MigrationContext) => void | Promise<void>;
  private client?: OpenAI;
  private model?: string;
  private modelConfig?: Record<string, unknown>;
  private logger: Logger;

  constructor(options: TaskMigrationServiceOptions = {}) {
    const { onBeforeMigrate, onMigrated, logger, client, model, modelConfig } = options;
    this.onBeforeMigrate = onBeforeMigrate;
    this.onMigrated = onMigrated;
    this.client = client;
    this.model = model;
    this.modelConfig = modelConfig;
    this.logger = logger ?? getLogger();
  }

  static createPrompt(): string {
    return [
      "根据以下对话历史，生成一篇结构化交接文档。不要做任何解释，只输出交接文档。",
      "",
      `文档必须包含以下章节：`,
      `${TaskMigrationService.HANDOFF_SECTIONS.breakpoint}`,
      `- 用户最后说了什么，AI 最后回复了什么`,
      "",
      `${TaskMigrationService.HANDOFF_SECTIONS.completed}`,
      `- 列出已完成的每项任务及其关键产出`,
      "",
      `${TaskMigrationService.HANDOFF_SECTIONS.pending}`,
      `- 按优先级列出未完成的任务、当前进度、下一步`,
      "",
      `${TaskMigrationService.HANDOFF_SECTIONS.memory}`,
      `- 需要新 Agent 记住的关键信息（设计决策、偏好、约定等）`,
      "",
      `${TaskMigrationService.HANDOFF_SECTIONS.files}`,
      `- 涉及的文件及其用途`,
      "",
      `${TaskMigrationService.HANDOFF_SECTIONS.instructions}`,
      `- 接手后建议的操作步骤`,
    ].join("\n");
  }

  /**
   * 生成迁移后追加的「对话断点」消息（role=user）：交接文档 + 接手指令。
   * 该消息是 omit 迁移方案中新上下文的起点，模型看到的序列为
   * `[definition.messages, 断点消息]`（历史消息已被标记 omit，不再发送）。
   */
  static createPostMessages(handoffDoc: string): AgentNS.Message[] {
    const content = [
      "这是上一轮对话的任务交接文档。请先阅读交接文档，理解上下文后再继续协助用户完成任务。",
      "",
      "---",
      "",
      handoffDoc,
      "",
      "---",
      "",
      "请确认你已理解以上内容，然后询问用户接下来需要什么帮助。",
    ].join("\n");

    return [{ role: AgentNS.Role.User, content }];
  }

  /**
   * 序列化消息为 `[role]: content` 文本，供模型理解完整对话历史。
   */
  static serializeMessages(messages: AgentNS.Message[]): string {
    return messages
      .map((m) => {
        const role = m.role ?? "unknown";
        const content =
          typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `[${role}]: ${content}`;
      })
      .join("\n\n");
  }

  /**
   * 生成交接文档：使用指定的 client / model / modelConfig 带交接 prompt 生成结构化文档。
   */
  private async generateHandoff(
    client: OpenAI,
    model: string,
    modelConfig: Record<string, unknown>,
    historyText: string,
  ): Promise<string> {
    const response = await client.chat.completions.create({
      model,
      ...(modelConfig ?? {}),
      messages: [
        { role: "system", content: TaskMigrationService.createPrompt() },
        { role: "user", content: historyText },
      ],
    });

    const handoffDoc = response.choices[0]?.message?.content;
    if (!handoffDoc) {
      throw new Error("未能生成任务交接文档");
    }
    return handoffDoc;
  }

  /**
   * 执行完整迁移：序列化历史 → 模型生成交接文档 → 标记历史消息 omit 并追加对话断点 → 触发钩子。
   *
   * 存储策略（omit 方案，保留历史可审计）：
   *   - `agent.definition.messages`（系统提示等模板消息）保留、不省略；
   *   - 其余既有历史消息统一标记 `omit: true`（仍存于 `agent.messages`，可审计/回放，但不再发送给模型）；
   *   - 追加一条「对话断点」消息（交接文档 + 接手指令，role=user）作为新上下文的起点。
   *   因此 `formatHistory()` 发送给模型的是 `[definition.messages, 断点消息]`，
   *   历史被压缩但并不删除，符合「消息状态唯一由 agent.messages 持有」的设计。
   *
   * 设计约束：
   *   - 不重建 Agent，保留所有引用与插件绑定（仅重建消息列表）
   *   - 钩子（onBeforeMigrate / onMigrated）抛错会被捕获并记录，**不中断**迁移流程
   *   - 生成失败 / 未取到交接文档时抛错，此时 `agent.messages` 保持原样（不会被部分修改）
   *
   * @param params.agent        当前对话 Agent
   * @param params.promptTokens 当前 prompt token 用量（可选）
   * @param params.maxTokens    上下文阈值（可选）
   * @returns 完整的迁移上下文（含生成的交接文档）
   */
  async migrate(params: {
    agent: SdkAgent;
    promptTokens?: number;
    maxTokens?: number;
  }): Promise<MigrationContext> {
    const { agent, promptTokens, maxTokens } = params;
    // 序列化有效上下文：过滤已标记 omit 的历史，避免重复迁移时把旧省略历史再次喂给模型。
    // historyText 供模型生成交接文档，而 messageCountBefore 仍记录本次迁移前的消息总数。
    const historyText = TaskMigrationService.serializeMessages(
      agent.messages.filter((m) => !m.omit),
    );
    const messageCountBefore = agent.messages.length;

    // 生成交接文档所用模型调用：优先使用构造时传入的 client/model/modelConfig，
    // 未传则回退到 agent 自带的（无需 Provider / 独立迁移 Agent）。
    const client = this.client ?? agent.client;
    const model = this.model ?? agent.model;
    const modelConfig = this.modelConfig ?? agent.modelConfig;

    // 迁移前上下文（不含 handoffDoc，独立对象，语义固定）
    const beforeCtx: MigrationContext = {
      agent,
      model,
      maxTokens,
      promptTokens,
      historyText,
      messageCountBefore,
    };

    // 迁移前钩子（容错，不中断）
    if (this.onBeforeMigrate) {
      try {
        await this.onBeforeMigrate(beforeCtx);
      } catch (err: any) {
        this.logger.error(`[migrate] onBeforeMigrate 回调失败: ${err?.message ?? err}`);
      }
    }

    // 生成交接文档
    const handoffDoc = await this.generateHandoff(
      client,
      model,
      modelConfig,
      historyText,
    );

    // 标记历史消息 omit（保留可审计），并追加对话断点。
    // 以 definition.messages 的长度为界：模板消息保持不省略，其余历史消息统一标记 omit。
    // 注意：用浅拷贝重建数组，避免直接修改 definition.messages 引用的对象（防止污染模板）。
    const preserveCount = Math.min(
      agent.definition.messages.length,
      agent.messages.length,
    );
    const nextMessages: AgentNS.Message[] = agent.messages.map((m, i) => ({
      ...m,
      omit: i >= preserveCount ? true : m.omit,
    }));

    // 追加「对话断点」消息（交接文档 + 接手指令），作为新上下文起点
    nextMessages.push(...TaskMigrationService.createPostMessages(handoffDoc));

    agent.messages = nextMessages;

    // 迁移后上下文（含 handoffDoc，与迁移前上下文独立）
    const afterCtx: MigrationContext = {
      agent,
      model,
      maxTokens,
      promptTokens,
      historyText,
      messageCountBefore,
      handoffDoc,
    };

    // 迁移后钩子（容错，不中断；此时交接文档已注入）
    if (this.onMigrated) {
      try {
        await this.onMigrated(afterCtx);
      } catch (err: any) {
        this.logger.error(`[migrate] onMigrated 回调失败: ${err?.message ?? err}`);
      }
    }

    return afterCtx;
  }
}
