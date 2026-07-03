import chalk from "chalk";
import inquirer from "inquirer";
import { Agent, AgentNS } from "@ai-zen/agents-core";
import { ConversationContext } from "../types.js";

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

interface BackTarget {
  index: number;
  role: AgentNS.Role;
  label: string;
  toolName?: string;
  preview: string;
}

export async function handleBack(agent: Agent, ctx: ConversationContext): Promise<void> {
  // 收集可撤回的目标消息：用户消息 和 工具/函数调用结果消息
  const targets: BackTarget[] = [];
  for (let i = 0; i < agent.messages.length; i++) {
    const msg = agent.messages[i];
    if (msg.role === AgentNS.Role.User) {
      const text = getMessageText(msg);
      targets.push({
        index: i,
        role: msg.role,
        label: chalk.green("👤 用户"),
        preview: text.substring(0, 60) + (text.length > 60 ? "..." : ""),
      });
    } else if (msg.role === AgentNS.Role.Tool || msg.role === AgentNS.Role.Function) {
      const text = getMessageText(msg);
      const toolName = msg.name ? ` [${msg.name}]` : "";
      targets.push({
        index: i,
        role: msg.role,
        label: chalk.cyan(`🔧 工具${toolName}`),
        preview: text.substring(0, 60) + (text.length > 60 ? "..." : ""),
      });
    }
  }

  if (targets.length === 0) {
    console.log(chalk.red("\n❌ 还没有消息可以撤回\n"));
    ctx.input = "";
    return;
  }

  console.log(chalk.yellow.bold("\n📋 选择要撤回到哪条消息:"));
  console.log(chalk.gray("将删除所选消息及其之后的所有内容\n"));

  const choices = [...targets].reverse().map((target) => ({
    name: `${target.label} ${chalk.gray(target.preview)}`,
    value: target.index,
  }));

  const { selectedIndex } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedIndex",
      message: "撤回到:",
      pageSize: 15,
      choices: [{ name: "↩️  取消操作", value: -1 }, ...choices],
    },
  ]);

  if (selectedIndex === -1) {
    console.log(chalk.gray("已取消操作\n"));
    ctx.input = "";
    return;
  }

  const selectedMsg = agent.messages[selectedIndex];
  const isUserMsg = selectedMsg.role === AgentNS.Role.User;
  const originalText = getMessageText(selectedMsg);

  // 截断消息
  const sliceEnd = isUserMsg ? selectedIndex : selectedIndex + 1;
  agent.messages = agent.messages.slice(0, sliceEnd);

  if (isUserMsg) {
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
      ctx.shouldSend = true;
    } else {
      ctx.input = originalText;
      ctx.shouldSend = true;
    }
  } else {
    console.log(
      chalk.gray(
        `原工具结果: ${originalText.substring(0, 200)}${originalText.length > 200 ? "..." : ""}`,
      ),
    );
    console.log(
      chalk.yellow("💡 请输入一条新消息，将插入到工具调用结果之后继续对话"),
    );
    console.log();

    const { newMessage } = await inquirer.prompt([
      {
        type: "input",
        name: "newMessage",
        message: chalk.cyan("新消息:"),
        prefix: "💬",
      },
    ]);

    const trimmed = newMessage.trim();
    if (!trimmed) {
      console.log(chalk.red("\n❌ 消息内容不能为空\n"));
      ctx.input = "";
      return;
    }

    ctx.input = trimmed;
    ctx.shouldSend = true;
  }
}
