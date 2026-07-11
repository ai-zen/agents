import chalk from "chalk";
import inquirer from "inquirer";
import { Agent, AgentNS, Message } from "@ai-zen/agents-core";
import { saveConversation } from "./conversations.js";
import { saveDraft, clearDraft } from "./draft.js";
import { DeltaRenderer } from "./delta-renderer.js";
import { shouldMigrate, generateMigrationDoc, calcTotalChars } from "./task-migration-agent.js";
import { getModel } from "./models.js";
import { createAgent } from "./agent-creator.js";
import { ConversationContext } from "./types.js";
import { formatShortTime } from "./format-time.js";
import { dispatchCommand, getCommandNames } from "./conversation-commands/index.js";

// ==================== 工具函数 ====================

function getMessageText(msg: AgentNS.Message): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((s) => s.type === "text")
      .map((s) => s.text)
      .join("");
  }
  return "";
}

/** 从消息列表中提取系统提示词（不含用户消息和其他角色消息） */
function extractSystemMessages(messages: AgentNS.Message[]): AgentNS.Message[] {
  return messages.filter((msg) => msg.role === AgentNS.Role.System);
}

// ==================== 发送消息 ====================

async function sendAndStream(ctx: ConversationContext): Promise<void> {
  console.log(chalk.green.bold("\n🤖 AI:"));

  try {
    const messages = await ctx.agent.send(ctx.input);
    process.stdout.write("\n\n");

    const lastMessage = messages.at(-1);

    if (lastMessage?.status === "error") {
      console.error(
        chalk.red(
          `\n❌ 发生错误时最后一条消息: ${JSON.stringify(lastMessage)}\n`,
        ),
      );
      try {
        saveConversation(
          ctx.currentName,
          ctx.agent.messages,
          ctx.modelId,
          ctx.currentId,
          ctx.agentId,
        );
        console.log(
          chalk.yellow(`💾 错误时对话已自动保存: ${ctx.currentName}\n`),
        );
      } catch (saveError) {
        console.error(chalk.red(`❌ 自动保存失败: ${saveError}\n`));
      }
      return;
    }

    if (
      lastMessage?.role === AgentNS.Role.Assistant &&
      Array.isArray(lastMessage.content)
    ) {
      for (const section of lastMessage.content) {
        if (section.type === "image_url")
          console.log(chalk.yellow(`[图片: ${section.image_url.url}]`));
      }
    }

    console.log();
  } catch (error: any) {
    process.stdout.write(
      chalk.red(`\n❌ 请求错误: ${error?.message || error}\n`),
    );
    if (
      error.message?.includes("API Key") ||
      error.message?.includes("401") ||
      error.message?.includes("403")
    ) {
      console.log(
        chalk.yellow(
          "💡 提示: 请使用 'aiz config set-key' 设置正确的 API Key\n",
        ),
      );
    }
  }
}

// ==================== 任务迁移 ====================

/**
 * 执行任务迁移
 * 1. 保存当前会话
 * 2. 使用摘要 Agent 生成交接文档
 * 3. 创建新会话，将交接文档作为第一条用户消息
 * 4. 更新 ctx.agent 为新 Agent
 */
async function performMigration(ctx: ConversationContext): Promise<string | null> {
  console.log(
    chalk.yellow.bold("\n📋 上下文已接近最大长度，正在生成交接文档...\n"),
  );

  try {
    // 1. 先保存当前会话
    const savedId = saveConversation(
      ctx.currentName,
      ctx.agent.messages,
      ctx.modelId,
      ctx.currentId,
      ctx.agentId,
    );
    console.log(
      chalk.gray(`  ✅ 原对话已保存: ${ctx.currentName} (ID: ${savedId})`),
    );

    // 2. 生成交接文档
    console.log(chalk.gray("  📝 正在分析对话历史，筛选关键信息..."));
    const summary = await generateMigrationDoc(ctx.agent.formatHistory());
    console.log(chalk.gray("  ✅ 交接文档已生成"));

    // 3. 计算当前上下文大小，给用户参考
    const totalChars = calcTotalChars(ctx.agent.messages);
    console.log(
      chalk.gray(`  📊 原上下文: ${totalChars.toLocaleString()} 字符`),
    );

    // 4. 创建新 Agent（使用相同的模型和系统提示词）
    const newAgent = await createAgent(ctx.modelId, ctx.systemMessages);

    // 5. 将交接文档作为第一条用户消息注入到新 Agent
    newAgent.messages.push(Message.User(summary));

    // 6. 切换 ctx.agent 到新 Agent
    ctx.agent = newAgent;

    // 更新上下文
    ctx.currentName = `对话_${formatShortTime(new Date().toISOString())}`;
    ctx.currentId = undefined; // 新会话，新 ID

    return summary;
  } catch (error: any) {
    console.error(
      chalk.red(`\n❌ 任务迁移失败: ${error.message}\n`),
    );
    console.log(
      chalk.yellow("⚠️  继续使用当前会话，请考虑手动保存后重新开始\n"),
    );
    return null;
  }
}

// ==================== 对话主循环 ====================

export async function runConversation(
  agent: Agent,
  modelId: string,
  conversationId?: string,
  conversationName?: string,
  agentId?: string,
  initialMessage?: string,
): Promise<void> {
  // 提取系统提示词，用于后续重建新会话
  const systemMessages = extractSystemMessages(agent.messages);

  const cmdList = getCommandNames().map((c) => `/${c}`).join(", ");
  console.log(
    chalk.blue.bold(
      `💬 对话已开始 (输入 ${cmdList} 查看和操作)\n`,
    ),
  );

  const ctx: ConversationContext = {
    agent,
    input: "",
    currentName: conversationName || `对话_${formatShortTime(new Date().toISOString())}`,
    currentId: conversationId,
    modelId,
    agentId,
    running: true,
    systemMessages,
  };

  // ============ 流式渲染 ============

  const mainRenderer = new DeltaRenderer({
    reasoningHeader: "\n\n💭 思考中...\n",
    contentHeader: "\n\n💭 回答中...\n",
    reasoningStyle: chalk.blue,
    contentStyle: chalk.white,
  });

  const onRun = () => {
    mainRenderer.reset();
  };

  const onChunk = (chunk: AgentNS.StreamResponseData) => {
    if (!chunk?.choices?.[0]?.delta) return;
    const delta = chunk.choices[0].delta;
    const fr = chunk.choices[0].finish_reason ?? null;
    mainRenderer.render(delta, fr);
  };

  const onError = (error: any) => {
    process.stdout.write(chalk.red(`\n❌ 错误: ${error?.message || error}\n`));
  };

  // ============ 子 Agent 渲染 ============

  const onSubAgent = ({
    agent: subAgent,
    ctx: subCtx,
  }: {
    agent: Agent;
    ctx: any;
  }) => {
    const toolName = subCtx.function_call?.name || "子任务";

    const renderer = new DeltaRenderer({
      reasoningHeader: "💭 ",
      contentHeader: "",
      reasoningStyle: chalk.blue,
      contentStyle: chalk.white,
      indent: "    ",
    });

    let namePrinted = false;

    subAgent.events.on("run", () => {
      renderer.reset();
    });

    subAgent.events.on("chunk", (chunk: AgentNS.StreamResponseData) => {
      if (!namePrinted) {
        process.stdout.write(chalk.yellow.bold(`\n  🧩 ${toolName}:\n`));
        namePrinted = true;
      }
      const delta = chunk?.choices?.[0]?.delta;
      if (!delta) return;

      const fr = chunk?.choices?.[0]?.finish_reason ?? null;
      renderer.render(delta, fr);
    });

    subAgent.events.on("error", (error: any) => {
      renderer.reset();
      process.stdout.write(
        chalk.red(`\n    ❌ ${toolName} 错误: ${error?.message || error}\n`),
      );
    });
  };

  // ============ 子 Agent 结束事件 ============

  // ============ 每次 run 完成后保存草稿 ==========

  const onRunEnd = () => {
    saveDraft(ctx.agent.messages, ctx.modelId, ctx.agentId);
  };

  const onSubAgentEnd = ({
    ctx: subCtx,
  }: {
    agent: Agent;
    ctx: any;
  }) => {
    const toolName = subCtx.function_call?.name || "子任务";
    process.stdout.write(chalk.gray(`\n    ✅ ${toolName} 完成\n`));
  };

  // ============ 注册事件 ============

  ctx.agent.events.on("run-end", onRunEnd);
  ctx.agent.events.on("run", onRun);
  ctx.agent.events.on("chunk", onChunk);
  ctx.agent.events.on("error", onError);
  ctx.agent.events.on("sub-agent", onSubAgent);
  ctx.agent.events.on("sub-agent-end", onSubAgentEnd);

  // ============ 如果有初始消息，先发送 ============

  if (initialMessage) {
    ctx.input = initialMessage;
    console.log(chalk.cyan("💬 你: ") + initialMessage + "\n");
    await sendAndStream(ctx);
  }

  // ============ 主循环 ============

  while (ctx.running) {
    const { question } = await inquirer.prompt([
      {
        type: "input",
        name: "question",
        message: chalk.cyan("你:"),
        prefix: "💬",
      },
    ]);

    ctx.input = question.trim();

    if (!ctx.input) continue;

    // 先尝试分发命令（以 / 开头）
    const handled = await dispatchCommand(ctx);
    if (handled) {
      // 命令处理完后默认跳过发送（continue），等待用户下一次输入。
      // 但某些命令（如 /back 撤回后重发）设置了 ctx.input 和 shouldSend 标记，
      // 希望主循环继续发送消息，此时不应跳过。
      if (ctx.shouldSend) {
        ctx.shouldSend = false;
        console.log(chalk.cyan("💬 你: ") + ctx.input + "\n");
      } else {
        continue;
      }
    }

    if (!ctx.input) continue;

    // 发送消息并等待 AI 回复完成
    await sendAndStream(ctx);

    // 如果会话还在继续（没有退出），检测是否需要任务迁移
    if (ctx.running) {
      const modelConfig = getModel(ctx.modelId);
      const maxContextChars = modelConfig?.maxContextChars;

      if (shouldMigrate(ctx.agent.messages, maxContextChars)) {
        console.log(
          chalk.cyan.bold("\n🔄 检测到上下文已接近最大长度，准备任务迁移...\n"),
        );

        // 解绑旧 Agent 的事件
        ctx.agent.events.off("run", onRun);
        ctx.agent.events.off("chunk", onChunk);
        ctx.agent.events.off("error", onError);
        ctx.agent.events.off("sub-agent", onSubAgent);
        ctx.agent.events.off("sub-agent-end", onSubAgentEnd);
        ctx.agent.events.off("run-end", onRunEnd);

        const summary = await performMigration(ctx);

        if (summary) {
          // 绑定新 Agent 的事件（ctx.agent 已在 performMigration 中被替换）
          ctx.agent.events.on("run", onRun);
          ctx.agent.events.on("chunk", onChunk);
          ctx.agent.events.on("error", onError);
          ctx.agent.events.on("sub-agent", onSubAgent);
          ctx.agent.events.on("sub-agent-end", onSubAgentEnd);
          ctx.agent.events.on("run-end", onRunEnd);

          // 迁移后保存新会话的草稿
          saveDraft(ctx.agent.messages, ctx.modelId, ctx.agentId);

          console.log(
            chalk.green.bold(
              "\n🚀 任务迁移完成！新会话已就绪，交接文档已作为上下文注入。\n",
            ),
          );
          console.log(
            chalk.gray("💡 你可以继续提问，新助手已经了解之前的全部工作。\n"),
          );
        } else {
          // 迁移失败，重新绑定旧 Agent 的事件
          ctx.agent.events.on("run", onRun);
          ctx.agent.events.on("chunk", onChunk);
          ctx.agent.events.on("error", onError);
          ctx.agent.events.on("sub-agent", onSubAgent);
          ctx.agent.events.on("sub-agent-end", onSubAgentEnd);
          ctx.agent.events.on("run-end", onRunEnd);
        }
      }
    }
  }

  ctx.agent.events.off("run", onRun);
  ctx.agent.events.off("chunk", onChunk);
  ctx.agent.events.off("error", onError);
  ctx.agent.events.off("sub-agent", onSubAgent);
  ctx.agent.events.off("sub-agent-end", onSubAgentEnd);
  ctx.agent.events.off("run-end", onRunEnd);

  console.log(chalk.blue.bold("\n👋 再见！\n"));
}
