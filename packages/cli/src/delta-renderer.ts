import chalk from "chalk";
import { AgentNS } from "@ai-zen/agents-core";

// ==================== 工具调用打印状态 ====================

interface ToolCallPrint {
  name: string;
  arguments: string;
  namePrinted: boolean;
  argsPrinted: boolean;
  completed: boolean;
}

// ==================== 渲染器选项 ====================

export interface DeltaRendererOptions {
  /** 首次 reasoning 时打印的头部 */
  reasoningHeader?: string;
  /** 首次 content 时打印的头部 */
  contentHeader?: string;
  /** reasoning 文本的样式 */
  reasoningStyle?: any;
  /** content 文本的样式 */
  contentStyle?: any;
  /** 每行前的缩进 */
  indent?: string;
}

// ==================== 流式渲染器 ====================

/**
 * 流式 Delta 渲染器，管理 reasoning/content/tool_calls 的状态和输出
 */
export class DeltaRenderer {
  private reasoningPrinted = false;
  private contentPrinted = false;
  private toolPrints: Record<number, ToolCallPrint> = {};
  private opts: Required<DeltaRendererOptions>;

  constructor(opts: DeltaRendererOptions = {}) {
    this.opts = {
      reasoningHeader: opts.reasoningHeader ?? "",
      contentHeader: opts.contentHeader ?? "",
      reasoningStyle: opts.reasoningStyle ?? chalk.blue,
      contentStyle: opts.contentStyle ?? chalk.white,
      indent: opts.indent ?? "",
    };
  }

  /**
   * 渲染一个 delta，同时处理 content、reasoning_content 和 tool_calls
   * @param delta - 流式 delta
   * @param finishReason - 当前 choice 的 finish_reason（用于 tool_calls 完成标记）
   */
  render(delta: AgentNS.Delta, finishReason: AgentNS.FinishReason | null = null): void {
    // 1. 渲染工具调用
    if (delta.tool_calls) {
      this.renderToolCalls(delta, finishReason);
    }

    // 2. 渲染 reasoning
    if (delta.reasoning_content) {
      if (!this.reasoningPrinted && this.opts.reasoningHeader) {
        process.stdout.write(this.opts.indent + this.opts.reasoningHeader);
        this.reasoningPrinted = true;
      }
      process.stdout.write(this.opts.reasoningStyle(delta.reasoning_content));
    }

    // 3. 渲染 content
    if (delta.content) {
      if (!this.contentPrinted && this.opts.contentHeader) {
        process.stdout.write(this.opts.indent + this.opts.contentHeader);
        this.contentPrinted = true;
      }
      if (typeof delta.content === "string") {
        process.stdout.write(this.opts.contentStyle(delta.content));
      } else if (Array.isArray(delta.content)) {
        for (const s of delta.content) {
          if (s.type === "text" && s.text) {
            process.stdout.write(this.opts.contentStyle(s.text));
          }
        }
      }
    }
  }

  /** 重置状态（新一轮对话时调用） */
  reset(): void {
    this.reasoningPrinted = false;
    this.contentPrinted = false;
    for (const k in this.toolPrints) delete this.toolPrints[k];
  }

  // ==================== 工具调用渲染 ====================

  private renderToolCalls(delta: AgentNS.Delta, finishReason: AgentNS.FinishReason | null): void {
    if (!delta.tool_calls || delta.tool_calls.length === 0) return;

    const isFirstToolCall =
      Object.keys(this.toolPrints).length === 0 &&
      delta.tool_calls.some((tc) => tc.function?.name || tc.function?.arguments);

    if (isFirstToolCall)
      process.stdout.write(chalk.blue.bold("\n\n💭 工具调用中..."));

    for (const tc of delta.tool_calls) {
      const index = tc.index ?? 0;
      const func = tc.function;

      if (!this.toolPrints[index]) {
        this.toolPrints[index] = {
          name: "",
          arguments: "",
          namePrinted: false,
          argsPrinted: false,
          completed: false,
        };
      }

      const p = this.toolPrints[index];

      if (func?.name) p.name += func.name;
      if (func?.arguments) p.arguments += func.arguments;

      if (p.name && !p.namePrinted) {
        process.stdout.write(chalk.magenta.bold(`\n🔧 ${index} ${p.name}\n`));
        p.namePrinted = true;
      }

      if (p.arguments && !p.argsPrinted && p.namePrinted) p.argsPrinted = true;
      if (func?.arguments && p.argsPrinted)
        process.stdout.write(chalk.gray(func.arguments));

      if (finishReason === AgentNS.FinishReason.ToolCalls) p.completed = true;
    }

    if (finishReason === AgentNS.FinishReason.ToolCalls) {
      for (const idx of Object.keys(this.toolPrints).map(Number)) {
        const p = this.toolPrints[idx];
        if (p.completed && p.arguments) {
          process.stdout.write("\n");
          try {
            const parsed = JSON.parse(p.arguments);
            process.stdout.write(
              chalk.gray(`    ${JSON.stringify(parsed, null, 4)}\n`),
            );
          } catch {
            process.stdout.write(chalk.gray(`    ${p.arguments}\n`));
          }
        }
      }
    }
  }
}


