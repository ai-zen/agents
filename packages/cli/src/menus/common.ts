import chalk from "chalk";
import inquirer from "inquirer";

// ==================== 工具函数 ====================

/**
 * 对 API Key 做脱敏显示
 */
export function maskApiKey(apiKey: string | undefined): string {
  if (!apiKey) return chalk.red("未设置");
  if (apiKey.length <= 12)
    return apiKey.substring(0, 4) + "..." + apiKey.substring(apiKey.length - 4);
  return apiKey.substring(0, 8) + "..." + apiKey.substring(apiKey.length - 4);
}

/**
 * 从列表中选一项（含空判断），支持取消/返回
 * @returns 选中项的值，或 null（取消/返回时）
 */
export async function selectFromList<T>(
  items: T[],
  options: {
    message: string;
    getName: (item: T) => string;
    getValue: (item: T) => string;
    emptyMessage?: string;
    withBack?: boolean; // 是否添加"返回"选项
    backLabel?: string; // 自定义返回按钮文字
  },
): Promise<string | null> {
  if (items.length === 0) {
    console.log(
      chalk.yellow(`\n${options.emptyMessage || "⚠️  没有可用项"}\n`),
    );
    return null;
  }

  const choices = items.map((item) => ({
    name: options.getName(item),
    value: options.getValue(item),
  }));

  // 默认添加"返回"选项
  const shouldAddBack = options.withBack !== false;
  if (shouldAddBack) {
    choices.push({
      name: options.backLabel || "🔙 返回",
      value: "__back__",
    });
  }

  const { selected } = await inquirer.prompt([
    {
      type: "list",
      name: "selected",
      message: options.message,
      choices,
    },
  ]);

  if (selected === "__back__") return null;
  return selected;
}

/**
 * 从列表中选择一项，之后选择对其执行的操作
 * 返回 { item, action } 或 null（无数据或取消时）
 */
export async function selectItemAndAction<T>(
  items: T[],
  options: {
    getName: (item: T) => string;
    getValue: (item: T) => string;
    getDetails: (item: T) => string[];
    actions: Array<{ name: string; value: string }>;
    emptyMessage: string;
    selectMessage?: string; // 自定义选择提示文字
  },
): Promise<{ item: T; action: string } | null> {
  if (items.length === 0) {
    console.log(chalk.yellow(`\n${options.emptyMessage}\n`));
    return null;
  }

  // 第一步：选一个条目（带"返回"选项）
  const itemValue = await selectFromList(items, {
    message: options.selectMessage || "请选择:",
    getName: options.getName,
    getValue: options.getValue,
    emptyMessage: options.emptyMessage,
  });
  if (!itemValue) return null; // 用户选择返回

  const item = items.find((i) => options.getValue(i) === itemValue)!;

  // 显示详情
  const details = options.getDetails(item);
  if (details.length > 0) {
    for (const line of details) {
      console.log(line);
    }
  }

  // 第二步：选择操作
  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: `对 "${options.getName(item)}" 执行操作:`,
      choices: [
        ...options.actions,
        { name: "🔙 返回", value: "__back__" },
        ...(options.actions.length > 0 ? [{ name: "🔚 退出管理", value: "__exit__" } as const] : []),
      ],
    },
  ]);

  if (action === "__back__") return null;
  if (action === "__exit__") return { item, action: "__exit__" };
  return { item, action };
}

/**
 * 确认操作
 */
export async function confirmAction(
  message: string,
  defaultVal: boolean = false,
): Promise<boolean> {
  const { confirm } = await inquirer.prompt([
    { type: "confirm", name: "confirm", message, default: defaultVal },
  ]);
  return confirm;
}

// ==================== 分隔线 ====================

export const SEPARATOR = chalk.gray("─".repeat(60));
export const SEPARATOR_LONG = chalk.gray("─".repeat(80));
