import chalk from "chalk";
import inquirer from "inquirer";
import { Agent, AgentNS } from "@ai-zen/agents-core";
import { saveConversation } from "./conversations.js";

// ==================== 类型定义 ====================

interface ConversationContext {
  input: string;
  currentName: string;
  modelId: string;
  currentId: string | undefined;
  agentId: string | undefined;
  running: boolean;
}

interface ToolCallPrint {
  name: string;
  arguments: string;
  namePrinted: boolean;
  argsPrinted: boolean;
  completed: boolean;
}

interface RenderContext {
  reasoningPrinted: boolean;
  contentPrinted: boolean;
  toolPrints: Record<number, ToolCallPrint>;
}

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

// ==================== 工具调用渲染 ====================

function printToolCallChunk(
  delta: AgentNS.Delta,
  finishReason: AgentNS.FinishReason | null,
  prints: Record<number, ToolCallPrint>,
): void {
  if (!delta.tool_calls || delta.tool_calls.length === 0) return;

  const isFirstToolCall =
    Object.keys(prints).length === 0 &&
    delta.tool_calls.some((tc) => tc.function?.name || tc.function?.arguments);

  if (isFirstToolCall)
    process.stdout.write(chalk.blue.bold("\n\n💭 工具调用中..."));

  for (const tc of delta.tool_calls) {
    const index = tc.index ?? 0;
    const func = tc.function;

    if (!prints[index]) {
      prints[index] = {
        name: "",
        arguments: "",
        namePrinted: false,
        argsPrinted: false,
        completed: false,
      };
    }

    const p = prints[index];

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
    for (const idx of Object.keys(prints).map(Number)) {
      const p = prints[idx];
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

// ==================== 命令处理 ====================

async function handleExit(
  agent: Agent,
  ctx: ConversationContext,
): Promise<void> {
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
        const id = saveConversation(
          ctx.currentName,
          agent.messages,
          ctx.modelId,
          ctx.currentId,
          ctx.agentId,
        );
        console.log(
          chalk.green(`\n✅ 对话已保存: ${ctx.currentName} (ID: ${id})\n`),
        );
      } catch (error) {
        console.error(chalk.red(`\n❌ 保存失败: ${error}\n`));
      }
    }
  }
  ctx.running = false;
}

async function handleSave(
  agent: Agent,
  ctx: ConversationContext,
): Promise<void> {
  const { name } = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "对话名称:",
      default: ctx.currentName,
    },
  ]);

  try {
    const id = saveConversation(
      name,
      agent.messages,
      ctx.modelId,
      ctx.currentId,
      ctx.agentId,
    );
    console.log(chalk.green(`\n✅ 对话已保存: ${name} (ID: ${id})\n`));
    ctx.currentName = name;
    ctx.currentId = id;
  } catch (error) {
    console.error(chalk.red(`\n❌ 保存失败: ${error}\n`));
  }
}

function handleClear(): void {
  console.clear();
  console.log(chalk.blue.bold("\n" + "=".repeat(60)));
  console.log(chalk.blue.bold("  屏幕已清空"));
  console.log(chalk.blue.bold("=".repeat(60) + "\n"));
}

// ==================== back 撤回 ====================

async function handleBack(
  agent: Agent,
  ctx: ConversationContext,
): Promise<void> {
  const userMessages: { index: number; content: string }[] = [];
  for (let i = 0; i < agent.messages.length; i++) {
    if (agent.messages[i].role === AgentNS.Role.User) {
      userMessages.push({
        index: i,
        content: getMessageText(agent.messages[i]),
      });
    }
  }

  if (userMessages.length === 0) {
    console.log(chalk.red("\n❌ 还没有用户消息可以撤回\n"));
    ctx.input = "";
    return;
  }

  console.log(chalk.yellow.bold("\n📋 选择要撤回到哪条用户消息:"));
  console.log(chalk.gray("将删除所选消息及其之后的所有消息\n"));

  const choices = [...userMessages].reverse().map((msg) => ({
    name: `${msg.content.substring(0, 80)}${msg.content.length > 80 ? "..." : ""}`,
    value: msg.index,
  }));

  const { selectedIndex } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedIndex",
      message: "撤回到:",
      choices: [{ name: "↩️  取消操作", value: -1 }, ...choices],
    },
  ]);

  if (selectedIndex === -1) {
    console.log(chalk.gray("已取消操作\n"));
    ctx.input = "";
    return;
  }

  const originalText = getMessageText(agent.messages[selectedIndex]);

  console.log(
    chalk.gray(
      `原内容: ${originalText.substring(0, 200)}${originalText.length > 200 ? "..." : ""}`,
    ),
  );
  console.log();

  const { editChoice } = await inquirer.prompt([
    {
      type: "list",
      name: "editChoice",
      message: "请选择:",
      choices: [
        { name: "✏️  修改后重新发送", value: "edit" },
        { name: "🔄 直接重新发送（不修改内容）", value: "resend" },
        { name: "↩️  取消操作", value: "cancel" },
      ],
    },
  ]);

  if (editChoice === "cancel") {
    console.log(chalk.gray("已取消操作\n"));
    ctx.input = "";
    return;
  }

  agent.messages = agent.messages.slice(0, selectedIndex);

  if (editChoice === "edit") {
    const { editedContent } = await inquirer.prompt([
      {
        type: "input",
        name: "editedContent",
        message: chalk.cyan("修改消息:"),
        prefix: "✏️",
        default: originalText,
      },
    ]);
    const trimmed = editedContent.trim();
    if (!trimmed) {
      console.log(chalk.red("\n❌ 消息内容不能为空\n"));
      ctx.input = "";
      return;
    }
    ctx.input = trimmed;
  } else {
    ctx.input = originalText;
  }
}

// ==================== 发送消息 ====================

async function sendAndStream(
  agent: Agent,
  ctx: ConversationContext,
): Promise<void> {
  console.log(chalk.green.bold("\n🤖 AI:"));

  try {
    const messages = await agent.send(ctx.input);
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
          agent.messages,
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

// ==================== 对话主循环 ====================

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
      "  对话已开始 (输入 'exit' 退出, 'save' 保存, 'clear' 清屏, 'back' 撤回)",
    ),
  );
  console.log(chalk.blue.bold("=".repeat(60) + "\n"));

  const ctx: ConversationContext = {
    input: "",
    currentName: conversationName || `对话_${new Date().toISOString()}`,
    currentId: conversationId,
    modelId,
    agentId,
    running: true,
  };

  // ============ 流式事件 ============

  const renderCtx: RenderContext = {
    reasoningPrinted: false,
    contentPrinted: false,
    toolPrints: {},
  };

  const onRun = () => {
    renderCtx.reasoningPrinted = false;
    renderCtx.contentPrinted = false;
    for (const k in renderCtx.toolPrints) delete renderCtx.toolPrints[k];
  };

  const onChunk = (chunk: AgentNS.StreamResponseData) => {
    if (!chunk?.choices?.[0]?.delta) return;
    const delta = chunk.choices[0].delta;
    const fr = chunk.choices[0].finish_reason ?? null;

    if (delta.tool_calls) printToolCallChunk(delta, fr, renderCtx.toolPrints);

    if (delta.reasoning_content) {
      if (!renderCtx.reasoningPrinted) {
        process.stdout.write(chalk.blue.bold("\n\n💭 思考中...\n"));
        renderCtx.reasoningPrinted = true;
      }
      process.stdout.write(chalk.blue(delta.reasoning_content));
    }

    if (delta.content) {
      if (!renderCtx.contentPrinted) {
        process.stdout.write(chalk.blue.bold("\n\n💭 回答中...\n"));
        renderCtx.contentPrinted = true;
      }
      if (typeof delta.content === "string")
        process.stdout.write(delta.content);
      else if (Array.isArray(delta.content)) {
        for (const s of delta.content) {
          if (s.type === "text" && s.text) process.stdout.write(s.text);
        }
      }
    }
  };

  const onError = (error: any) => {
    process.stdout.write(
      chalk.red(`\n❌ 通过onError捕获到错误: ${error?.message || error}\n`),
    );
  };

  agent.events.on("run", onRun);
  agent.events.on("chunk", onChunk);
  agent.events.on("error", onError);

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

    const lower = ctx.input.toLowerCase();

    switch (lower) {
      case "exit":
      case "quit":
        await handleExit(agent, ctx);
        continue;

      case "save":
        await handleSave(agent, ctx);
        continue;

      case "clear":
        handleClear();
        continue;

      case "back":
        await handleBack(agent, ctx);
        break;
    }

    if (!ctx.input) continue;
    await sendAndStream(agent, ctx);
  }

  agent.events.off("run", onRun);
  agent.events.off("chunk", onChunk);
  agent.events.off("error", onError);

  console.log(chalk.blue.bold("\n👋 再见！\n"));
}
