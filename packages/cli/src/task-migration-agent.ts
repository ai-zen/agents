/**
 * 任务迁移 Agent
 *
 * 当会话上下文达到阈值时，由迁移 Agent 读取完整对话历史，
 * 筛选出对后续工作有用的信息，生成结构化的 Markdown 交接文档。
 *
 * 交接文档将作为新会话的第一条用户消息，让新 Agent 了解任务背景。
 *
 * 迁移 Agent 是专用的、无状态的，不注册任何工具，用完即弃。
 */

import { Agent, AgentNS, Message } from "@ai-zen/agents-core";
import { getDefaultModel } from "./models.js";
import { readConfig, CONFIG_DIR } from "./config.js";
import { buildModel } from "./agent-creator.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * 任务迁移 Agent 的系统提示词
 *
 * 核心原则：不是压缩对话，而是筛选出对未来工作有用的信息。
 * 可以丢弃的内容：已完成的细节、无关的闲聊、重复的讨论。
 * 必须保留的内容：未完成的任务、重要决策、用户偏好、关键文件位置。
 */
const MIGRATION_SYSTEM_PROMPT = `你是一个专业的任务交接分析师。你的任务是阅读一段完整的AI助手与用户的对话历史，筛选出对后续工作有用的关键信息，生成一份结构清晰的交接文档。

这份交接文档将作为新会话的第一条用户消息，让新的AI助手了解任务背景并继续工作。

请按以下模板生成 Markdown 格式的文档：

## 💬 对话断点
记录迁移前最后一段对话的原文，让接手者能无缝衔接。
**请直接引用，不要概括或改写**，除非原文过长（超过200字）可适当摘要。

- **用户最后说：**
  > （原文引用用户最后一条消息）
- **AI 最后回复：**
  > （原文引用或摘要AI最后一条回复）
- **当前状态：** 等待用户输入 / AI 正在执行 / 等待用户确认 / 其他（请如实描述）

---

## ✅ 已完成的任务
列出已经完成的任务及其产出物（文件路径、代码片段位置等）。
如果没有已完成的任务，保留此标题并注明"无"。
注意：只记录任务标题和产出路径，不需要描述完成过程的细节。

## 📋 未完成的任务
列出所有待继续完成的任务，包含：
- 任务描述
- 当前进度
- 下一步需要做什么
- 相关的文件路径
- 优先级（如果对话中提到过）

## 🧠 重要记忆
记录所有对后续工作有影响的信息，包括但不限于：
- 用户的技术偏好和约定
- 踩过的坑和教训
- 项目特定的架构决策
- 任何对后续工作有指导意义的信息

## 📁 文件索引
按用途分类列出对话中涉及的重要文件路径，方便新 Agent 按需阅读。
**请对每个文件注明其用途或作用**，让接手者能快速判断哪些文件需要优先阅读。

## 🔔 接手指令
接手后请按以下步骤操作：
1. **读文件** — 使用 shell 工具（cat、grep、find 等）读取「文件索引」中列出的关键文件，以实际代码为准，不要依赖训练数据或过往经验
2. **对状态** — 确认代码中的关键常量、函数签名、配置等是否与文档描述一致
3. **再行动** — 确认无误后再继续未完成任务，做任何改动前先跟用户商量

---

注意事项：
1. 只包含确定的信息，不要猜测或补充对话中没有的内容
2. 已完成的任务只需列出任务标题和产出路径，不要罗列完成过程的每一步
3. 如果某个部分没有需要记录的内容，标注"无"即可
4. 语言风格与原始对话一致（中文）
`;

// ==================== 文本渲染 ====================

/**
 * 将单条消息渲染为纯文本格式
 *
 * 渲染规则：
 * - 每种 role 用特定前缀标识，一目了然
 * - content 为字符串的直接输出
 * - content 为数组的（多模态），text 部分拼接输出，image_url 标注 [图片]
 * - tool_calls 保留 call_id、函数名和参数
 * - function_call 保留函数名和参数
 * - tool 消息保留 tool_call_id
 * - 隐藏/omit 消息跳过
 *
 * 注意：当前仅处理 type="function" 的工具调用（ToolCall.function），
 *       忽略 ToolCall.type 和 ToolCall.index 字段。
 *       如果未来引入非 function 类型的工具调用（如 code_interpreter、file_search 等），
 *       此处需要补充对应的渲染逻辑。
 */
export function formatMessageToText(msg: AgentNS.Message): string | null {
  // 跳过隐藏或省略的消息
  if (msg.hidden || msg.omit) return null;

  const parts: string[] = [];

  // ---- 角色前缀 ----
  switch (msg.role) {
    case AgentNS.Role.System:
      parts.push("[system]");
      break;
    case AgentNS.Role.User:
      parts.push("[user]");
      break;
    case AgentNS.Role.Assistant:
      parts.push("[assistant]");
      break;
    case AgentNS.Role.Tool:
      parts.push("[tool]");
      break;
    case AgentNS.Role.Function:
      parts.push("[function]");
      break;
    default:
      parts.push(`[${msg.role}]`);
  }

  // ---- content 渲染 ----
  const contentLines: string[] = [];

  if (typeof msg.content === "string") {
    if (msg.content) contentLines.push(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const section of msg.content) {
      if (section.type === "text" && section.text) {
        contentLines.push(section.text);
      } else if (section.type === "image_url") {
        contentLines.push(`[图片: ${section.image_url.url}]`);
      }
    }
  }

  // ---- tool_calls 渲染（保留 id） ----
  // 注：当前约定所有 tool_calls 均为 function 类型（ToolCall.type === "function"），
  //     因此只输出 function.name 和 function.arguments，忽略 ToolCall.type 和 ToolCall.index。
  //     如果未来引入其他类型（如 type: "code_interpreter"、type: "file_search" 等），
  //     需要在此处补充类型判断和对应渲染。
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      const callId = tc.id ? ` (${tc.id})` : "";
      const funcName = tc.function?.name || "unknown";
      const funcArgs = tc.function?.arguments || "{}";
      contentLines.push(`[tool_call] ${funcName}${callId}: ${funcArgs}`);
    }
  }

  // ---- function_call 渲染 ----
  if (msg.function_call) {
    const name = msg.function_call.name || "unknown";
    const args = msg.function_call.arguments || "{}";
    contentLines.push(`[function_call] ${name}: ${args}`);
  }

  // ---- tool_call_id 标注（tool 角色消息） ----
  if (msg.tool_call_id) {
    // 在 tool 结果前标注对应的 call_id，放在同一行
    const prefix = `[回应 ${msg.tool_call_id}]`;
    if (contentLines.length > 0) {
      contentLines[0] = `${prefix} ${contentLines[0]}`;
    } else {
      contentLines.push(prefix);
    }
  }

  // ---- 拼接 ----
  if (contentLines.length > 0) {
    parts.push(contentLines.join("\n  "));
  } else if (!msg.tool_calls && !msg.function_call) {
    // 完全没有内容的消息，标记为空
    parts.push("(空)");
  }

  return parts.join(" ");
}

/**
 * 将消息列表渲染为纯文本对话记录
 *
 * 相比 JSON.stringify 的优势：
 * - 去掉冗余的字段名，大幅缩减体积
 * - 更易读，迁移 Agent 可以直接理解
 * - 保留 tool_call_id 等关键关联信息
 *
 * @example 输出格式：
 * ```
 * [system] 你是一个AI助手...
 * [user] 帮我看看项目结构
 * [assistant] [tool_call] readFile (call_0): {"path":"package.json"}
 * [tool] [回应 call_0] {"name":"readProject","content":"..."}
 * [assistant] 已查看项目结构
 * ```
 */
export function formatHistoryToText(messages: AgentNS.Message[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    const line = formatMessageToText(msg);
    if (line !== null) {
      lines.push(line);
    }
  }

  return lines.join("\n");
}

/**
 * 计算消息列表的总字符数（JSON 序列化后的大小）
 */
export function calcTotalChars(messages: AgentNS.Message[]): number {
  return JSON.stringify(messages).length;
}

/**
 * 判断是否需要进行任务迁移
 * 当消息内容总字符数超过模型 maxContextChars 时返回 true
 */
export function shouldMigrate(
  messages: AgentNS.Message[],
  maxContextChars: number | undefined,
): boolean {
  if (!maxContextChars || maxContextChars <= 0) return false;
  const totalChars = calcTotalChars(messages);
  return totalChars >= maxContextChars;
}

/**
 * 创建任务迁移 Agent
 * 用于生成交接文档，不注册任何工具
 */
export async function createMigrationAgent(): Promise<Agent> {
  const config = readConfig();

  // 确定使用的模型：优先使用 defaultMigrationModel，否则用 defaultModel
  let modelId = config.defaultMigrationModel || config.defaultModel;
  if (!modelId) {
    const defaultModel = getDefaultModel();
    modelId = defaultModel?.id;
  }
  if (!modelId) {
    throw new Error("没有可用的模型来创建任务迁移 Agent，请先配置默认模型");
  }

  const model = await buildModel(modelId);

  const agent = new Agent({
    model,
    messages: [
      Message.System(MIGRATION_SYSTEM_PROMPT),
    ],
    tools: [], // 迁移 Agent 不需要任何工具
  });

  return agent;
}

/**
 * 记录迁移错误日志
 * 存储最原始的信息：原始聊天记录 + 迁移 Agent 的完整消息列表 + 错误信息
 */
export function logMigrationError(
  historyMessages: AgentNS.Message[],
  error: Error,
  migrationAgentMessages?: AgentNS.Message[],
  options?: {
    userPrompt?: string;
  },
): string {
  const logsDir = join(CONFIG_DIR, "logs");
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(logsDir, `migration-error-${timestamp}.json`);

  const logData: Record<string, any> = {
    timestamp: new Date().toISOString(),
    error: {
      message: error.message,
      stack: error.stack,
    },
    // 原始聊天记录
    historyMessages,
    // 迁移 Agent 的完整消息列表
    migrationAgentMessages,
  };

  // 迁移 Agent 收到的完整 prompt 另存为独立文件
  if (options?.userPrompt) {
    try {
      const promptFile = join(logsDir, `migration-prompt-${timestamp}.txt`);
      writeFileSync(promptFile, options.userPrompt, "utf-8");
      logData.userPromptFile = promptFile;
    } catch {
      // 静默
    }
  }

  try {
    writeFileSync(logFile, JSON.stringify(logData, null, 2), "utf-8");
  } catch {
    // 静默
  }

  return logFile;
}

// ==================== 伪造工具调用 ====================

/**
 * 伪造一轮工具调用，返回一对消息：assistant（含 tool_calls）+ tool（含返回结果）。
 *
 * ## 设计缘由
 *
 * 任务迁移需要将对话历史传给独立的迁移 Agent 分析。序列化历史有两种选择：
 *
 * 1. **JSON 格式** — 结构化，Agent 能准确区分每条消息的角色和字段，不会混淆。
 *    但体积巨大（每条消息重复出现 role/content/tool_calls 等字段名），
 *    在长对话场景下可能比纯文本大 3-5 倍，严重挤占迁移 Agent 的上下文窗口。
 *
 * 2. **纯文本格式**（formatHistoryToText）— 紧凑，体积小，保留关键信息。
 *    但如果直接作为 user 消息传给迁移 Agent，Agent 看到一大段纯文本对话记录，
 *    会分不清这是"需要分析的历史数据"还是"当前正在发生的对话"，导致分析偏差
 *    （如把历史中的用户消息当成当前用户指令、忽略工具调用的关联关系等）。
 *
 * 本函数的解决方案：将纯文本历史包装为一轮伪造的 `readFile` 工具调用。
 * 迁移 Agent 看到的是：用户请求读文件 → assistant 调用了 readFile → tool 返回了文件内容。
 * 这样 Agent 能借助工具调用的语义边界，清晰区分：
 * - "工具返回的内容" = 需要分析的历史数据
 * - "用户的消息" = 当前任务指令
 *
 * 既享受了纯文本的小体积优势，又避免了直接注入导致的混淆。
 */
export function forgeToolCallRound(options: {
  toolName: string;
  toolArgs: Record<string, any>;
  toolResult: string;
  callId?: string;
}): [Message, Message] {
  const callId = options.callId || `forge_${Date.now()}`;

  const toolCall: AgentNS.ToolCall = {
    id: callId,
    type: "function",
    function: {
      name: options.toolName,
      arguments: JSON.stringify(options.toolArgs),
    },
  };

  const assistantMsg = new Message({
    role: AgentNS.Role.Assistant,
    content: "",
    tool_calls: [toolCall],
    status: AgentNS.MessageStatus.Completed,
  });

  const toolMsg = Message.Tool(toolCall, options.toolResult);
  toolMsg.status = AgentNS.MessageStatus.Completed;

  return [assistantMsg, toolMsg];
}

// ==================== 交接文档生成 ====================

/**
 * 使用迁移 Agent 生成交接文档
 * @param historyMessages 原始会话的完整消息列表
 * @returns 交接文档的 Markdown 文本
 */
export async function generateMigrationDoc(
  historyMessages: AgentNS.Message[],
): Promise<string> {
  const migrationAgent = await createMigrationAgent();
  const historyText = formatHistoryToText(historyMessages);

  const [forgeAssistant, forgeTool] = forgeToolCallRound({
    toolName: "readFile",
    toolArgs: { path: "conversation-history.md" },
    toolResult: historyText,
  });

  migrationAgent.messages.push(
    Message.User("请你帮我读取历史记录文件"),
    forgeAssistant,
    forgeTool,
    Message.User("请你根据这些内容生成交接文档"),
  );
  migrationAgent.append(Message.Assistant());

  try {
    const messages = await migrationAgent.run();

    const lastMessage = messages
      .slice()
      .reverse()
      .find((m) => m.role === AgentNS.Role.Assistant && m.status !== "error");

    if (!lastMessage) throw new Error("AI 回复出错");

    const doc =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : Array.isArray(lastMessage.content)
          ? lastMessage.content
              .filter((s: any) => s.type === "text")
              .map((s: any) => s.text)
              .join("")
          : "";

    if (!doc.trim()) throw new Error("AI 返回了空内容");

    return doc;
  } catch (error: any) {
    logMigrationError(historyMessages, error, migrationAgent.messages);
    throw error;
  }
}
