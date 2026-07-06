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
import { readConfig } from "./config.js";
import { buildModel } from "./agent-creator.js";

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

/**
 * 计算消息列表的总字符数（直接序列化后算长度）
 */
export function calcTotalChars(messages: AgentNS.Message[]): number {
  return JSON.stringify(messages).length;
}

/**
 * 判断是否需要进行任务迁移
 * 当消息总字符数超过模型 maxContextChars 的 2/3 时返回 true
 */
export function shouldMigrate(
  messages: AgentNS.Message[],
  maxContextChars: number | undefined,
): boolean {
  if (!maxContextChars || maxContextChars <= 0) return false;
  const totalChars = calcTotalChars(messages);
  const threshold = Math.floor(maxContextChars * (2 / 3));
  return totalChars >= threshold;
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
 * 使用迁移 Agent 生成交接文档
 * @param historyMessages 原始会话的完整消息列表
 * @returns 交接文档的 Markdown 文本
 */
export async function generateMigrationDoc(
  historyMessages: AgentNS.Message[],
): Promise<string> {
  const migrationAgent = await createMigrationAgent();

  // 构造用户消息：将完整对话历史（JSON 格式）作为上下文提供给迁移 Agent
  // 使用 JSON.stringify 保留所有结构化信息（tool_calls、function_call、多模态内容等）
  const historyJson = JSON.stringify(historyMessages);

  const userContent = `请分析以下对话历史（JSON 格式）并生成交接文档。

这是 AI 助手与用户的完整对话记录，每条消息包含 role（角色）和 content（内容）字段。
你可以使用 shell 工具读取文件、查看项目结构来验证对话中提到的信息。

\`\`\`json
${historyJson}
\`\`\``;

  // 发送消息给迁移 Agent
  const messages = await migrationAgent.send(userContent);

  // 提取 AI 回复内容：从后往前找第一个非 error 的 assistant 消息
  let lastMessage = messages
    .slice()
    .reverse()
    .find((m) => m.role === AgentNS.Role.Assistant && m.status !== "error");

  if (!lastMessage) {
    // 所有 assistant 消息都是 error，取最后一条获取具体错误信息
    lastMessage = messages.at(-1);
    const errMsg = typeof lastMessage?.content === "string"
      ? lastMessage.content
      : "未知错误";
    throw new Error(`任务迁移失败: AI 回复出错 - ${errMsg}`);
  }

  let doc = "";
  if (typeof lastMessage.content === "string") {
    doc = lastMessage.content;
  } else if (Array.isArray(lastMessage.content)) {
    doc = lastMessage.content
      .filter((s) => s.type === "text")
      .map((s) => s.text)
      .join("");
  }

  // 如果内容为空，报错
  if (!doc.trim()) {
    throw new Error("任务迁移失败: AI 返回了空内容");
  }

  return doc;
}
