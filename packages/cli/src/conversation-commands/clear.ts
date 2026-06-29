import chalk from "chalk";
import { Agent } from "@ai-zen/agents-core";
import { ConversationContext } from "../types.js";

export async function handleClear(agent: Agent, ctx: ConversationContext): Promise<void> {
  console.clear();
  console.log(chalk.blue.bold("\n" + "=".repeat(60)));
  console.log(chalk.blue.bold("  屏幕已清空"));
  console.log(chalk.blue.bold("=".repeat(60) + "\n"));
}
