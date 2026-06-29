import chalk from "chalk";
import { Agent } from "@ai-zen/agents-core";
import { ConversationContext } from "./types.js";

export function handleClear(agent: Agent, ctx: ConversationContext): void {
  console.clear();
  console.log(chalk.blue.bold("\n" + "=".repeat(60)));
  console.log(chalk.blue.bold("  屏幕已清空"));
  console.log(chalk.blue.bold("=".repeat(60) + "\n"));
}
