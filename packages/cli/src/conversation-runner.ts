import chalk from "chalk";
import inquirer from "inquirer";
import { Agent, AgentNS } from "@ai-zen/agents-core";
import { saveConversation } from "./conversations.js";

// ==================== 工具调用状态管理 ====================

interface ToolCallState {
  name: string;
  arguments: string;
  namePrinted: boolean; // 名称是否已显示
  argsPrinted: boolean; // 参数首行标题是否已显示
  completed: boolean;
}

type ToolCallStates = Record<number, ToolCallState>;

function handleToolCallChunk(
  delta: AgentNS.Delta,
  finishReason: AgentNS.FinishReason | null,
  states: ToolCallStates,
): void {
  if (!delta.tool_calls || delta.tool_calls.length === 0) return;

  // 标记是否首次有工具调用（用来打印总标题）
  const isFirstToolCall =
    Object.keys(states).length === 0 &&
    delta.tool_calls.some((tc) => tc.function?.name || tc.function?.arguments);

  if (isFirstToolCall) {
    process.stdout.write(chalk.blue.bold("\n\n💭 工具调用中..."));
  }

  for (const tc of delta.tool_calls) {
    const index = tc.index ?? 0;
    const func = tc.function;

    // 初始化状态
    if (!states[index]) {
      states[index] = {
        name: "",
        arguments: "",
        namePrinted: false,
        argsPrinted: false,
        completed: false,
      };
    }

    const state = states[index];

    // 累加名称
    if (func?.name) {
      state.name += func.name;
    }

    // 累加参数
    if (func?.arguments) {
      state.arguments += func.arguments;
    }

    // 打印工具名称（首次出现时）
    if (state.name && !state.namePrinted) {
      process.stdout.write(chalk.magenta.bold(`\n🔧 ${index} ${state.name}\n`));
      state.namePrinted = true;
    }

    // 打印参数首行标题（首次有参数时）
    if (state.arguments && !state.argsPrinted && state.namePrinted) {
      // process.stdout.write(chalk.gray(`\n参数: `));
      state.argsPrinted = true;
    }

    // 流式打印参数增量
    if (func?.arguments && state.argsPrinted) {
      process.stdout.write(chalk.gray(func.arguments));
    }

    // 检测是否完成
    if (finishReason === AgentNS.FinishReason.ToolCalls) {
      state.completed = true;
    }
  }

  // 工具调用结束时，换行并在完成后格式化输出
  if (finishReason === AgentNS.FinishReason.ToolCalls) {
    for (const idx of Object.keys(states).map(Number)) {
      const state = states[idx];
      if (state.completed && state.arguments) {
        // 换到新行，打印格式化的参数
        process.stdout.write("\n");
        try {
          const parsed = JSON.parse(state.arguments);
          process.stdout.write(
            chalk.gray(`    ${JSON.stringify(parsed, null, 4)}\n`),
          );
        } catch {
          // JSON 解析失败（可能被截断），直接输出原始内容
          process.stdout.write(chalk.gray(`    ${state.arguments}\n`));
        }
      }
    }
  }
}

// ==================== 对话交互 ====================

export async function runConversation(
  agent: Agent,
  modelId: string,
  conversationId?: string,
  conversationName?: string,
  agentId?: string,
): Promise<void> {
  console.log(chalk.blue.bold("\n" + "=".repeat(60)));
  console.log(
    chalk.blue.bold(
      "  对话已开始 (输入 'exit' 退出, 'save' 保存, 'clear' 清屏)",
    ),
  );
  console.log(chalk.blue.bold("=".repeat(60) + "\n"));

  let shouldContinue = true;
  let currentName =
    conversationName || `对话_${new Date().toLocaleDateString()}`;
  let currentId = conversationId;

  // ============ 流式输出事件监听（一次性注册，避免每轮重复创建函数导致内存泄漏） ============

  // 每轮对话的状态（在 send 前更新）
  let streamingState: {
    reasoningHeaderPrinted: boolean;
    contentHeaderPrinted: boolean;
    toolCallStates: ToolCallStates;
  } = {
    reasoningHeaderPrinted: false,
    contentHeaderPrinted: false,
    toolCallStates: {},
  };

  const onRun = async () => {
    // 重置本轮流式状态
    streamingState = {
      reasoningHeaderPrinted: false,
      contentHeaderPrinted: false,
      toolCallStates: {},
    };
  };

  const onChunk = (chunk: AgentNS.StreamResponseData) => {
    if (chunk?.choices?.[0]?.delta) {
      const delta = chunk.choices[0].delta;
      const finishReason = chunk.choices[0].finish_reason ?? null;

      // 检测并处理 tool_calls
      if (delta.tool_calls) {
        handleToolCallChunk(delta, finishReason, streamingState.toolCallStates);
      }

      // 流式输出 reasoning_content（思考过程）
      if (delta.reasoning_content) {
        if (!streamingState.reasoningHeaderPrinted) {
          process.stdout.write(chalk.blue.bold("\n\n💭 思考中...\n"));
          streamingState.reasoningHeaderPrinted = true;
        }

        process.stdout.write(chalk.blue(delta.reasoning_content));
      }

      // 流式输出 content（文本增量）
      if (delta.content) {
        if (!streamingState.contentHeaderPrinted) {
          process.stdout.write(chalk.blue.bold("\n\n💭 回答中...\n"));
          streamingState.contentHeaderPrinted = true;
        }

        if (typeof delta.content === "string") {
          process.stdout.write(delta.content);
        } else if (Array.isArray(delta.content)) {
          for (const section of delta.content) {
            if (section.type === "text" && section.text) {
              process.stdout.write(section.text);
            }
          }
        }
      }
    }
  };

  const onError = (error: any) => {
    process.stdout.write(
      chalk.red(`\n❌ 通过onError捕获到错误: ${error?.message || error}\n`),
    );
  };

  // 一次性注册事件（整个对话生命周期）
  agent.events.on("run", onRun);
  agent.events.on("chunk", onChunk);
  agent.events.on("error", onError);

  while (shouldContinue) {
    const { question } = await inquirer.prompt([
      {
        type: "input",
        name: "question",
        message: chalk.cyan("你:"),
        prefix: "💬",
      },
    ]);

    const trimmedQuestion = question.trim();

    // 处理命令
    if (
      trimmedQuestion.toLowerCase() === "exit" ||
      trimmedQuestion.toLowerCase() === "quit"
    ) {
      // 询问是否保存
      if (agent.messages.length > 1) {
        const { saveBeforeExit } = await inquirer.prompt([
          {
            type: "confirm",
            name: "saveBeforeExit",
            message: "退出前是否保存当前对话?",
            default: true,
          },
        ]);

        if (saveBeforeExit) {
          try {
            currentId = saveConversation(
              currentName,
              agent.messages,
              modelId,
              currentId,
              agentId,
            );
            console.log(
              chalk.green(
                `\n✅ 对话已保存: ${currentName} (ID: ${currentId})\n`,
              ),
            );
          } catch (error) {
            console.error(chalk.red(`\n❌ 保存失败: ${error}\n`));
          }
        }
      }
      shouldContinue = false;
      break;
    }

    if (trimmedQuestion.toLowerCase() === "save") {
      const { name } = await inquirer.prompt([
        {
          type: "input",
          name: "name",
          message: "对话名称:",
          default: currentName,
        },
      ]);

      try {
        currentName = name;
        currentId = saveConversation(
          currentName,
          agent.messages,
          modelId,
          currentId,
          agentId,
        );
        console.log(
          chalk.green(`\n✅ 对话已保存: ${currentName} (ID: ${currentId})\n`),
        );
      } catch (error) {
        console.error(chalk.red(`\n❌ 保存失败: ${error}\n`));
      }
      continue;
    }

    if (trimmedQuestion.toLowerCase() === "clear") {
      console.clear();
      console.log(chalk.blue.bold("\n" + "=".repeat(60)));
      console.log(chalk.blue.bold("  屏幕已清空"));
      console.log(chalk.blue.bold("=".repeat(60) + "\n"));
      continue;
    }

    if (trimmedQuestion.toLowerCase() === "history") {
      console.log(chalk.yellow.bold("\n📋 对话历史:"));
      for (let i = 0; i < agent.messages.length; i++) {
        const msg = agent.messages[i];
        if (msg.role === AgentNS.Role.User) {
          console.log(chalk.cyan(`👤 你: ${msg.content}`));
        } else if (msg.role === AgentNS.Role.Assistant) {
          const textContent = getMessagePreviewContent(msg);
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            const toolNames = msg.tool_calls
              .map((tc) => tc.function?.name)
              .filter(Boolean)
              .join(", ");
            console.log(chalk.green(`🤖 AI: ${textContent}`));
            console.log(chalk.magenta(`   🔧 调用了工具: ${toolNames}`));
          } else {
            console.log(chalk.green(`🤖 AI: ${textContent}`));
          }
        }
      }
      console.log();
      continue;
    }

    if (!trimmedQuestion) continue;

    // ============ 流式输出对话 ============

    console.log(chalk.green.bold("\n🤖 AI:"));

    try {
      const messages = await agent.send(trimmedQuestion);
      // 流式输出完成后，换行
      process.stdout.write("\n\n");

      const lastMessage = messages.at(-1);

      if (lastMessage?.status === "error") {
        console.error(
          chalk.red(
            `\n❌ 发生错误时最后一条消息: ${JSON.stringify(lastMessage)}\n`,
          ),
        );

        // 发生错误时自动保存当前对话
        try {
          currentId = saveConversation(
            currentName,
            agent.messages,
            modelId,
            currentId,
            agentId,
          );
          console.log(
            chalk.yellow(
              `💾 错误时对话已自动保存: ${currentName} (ID: ${currentId})\n`,
            ),
          );
        } catch (saveError) {
          console.error(chalk.red(`❌ 自动保存失败: ${saveError}\n`));
        }

        return;
      }

      // 如果有多模态内容（如图片），在流式输出后补充显示
      if (
        lastMessage?.role === AgentNS.Role.Assistant &&
        Array.isArray(lastMessage.content)
      ) {
        for (const section of lastMessage.content) {
          if (section.type === "image_url") {
            console.log(chalk.yellow(`[图片: ${section.image_url.url}]`));
          }
        }
      }

      console.log();
    } catch (error: any) {
      process.stdout.write(
        chalk.red(`\n❌ 请求错误: ${error?.message || error}\n`),
      );

      // 如果是 API Key 的问题，提示用户设置
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

  // 对话结束，取消事件监听
  agent.events.off("chunk", onChunk);
  agent.events.off("error", onError);

  console.log(chalk.blue.bold("\n👋 再见！\n"));
}

/**
 * 获取消息的文本预览内容（用于 history 命令显示）
 */
function getMessagePreviewContent(msg: AgentNS.Message): string {
  if (typeof msg.content === "string") {
    return (
      msg.content.substring(0, 100) + (msg.content.length > 100 ? "..." : "")
    );
  }
  if (Array.isArray(msg.content)) {
    const textParts = msg.content
      .filter((s) => s.type === "text")
      .map((s) => s.text);
    const preview = textParts.join("").substring(0, 100);
    return preview + (preview.length >= 100 ? "..." : "");
  }
  return "[复杂内容]";
}
