/**
 * 自动标题 —— 给「还没有名字」的会话让模型起一个名字。
 *
 * ## 为什么在服务端做
 *
 * 前后端分离之后，客户端只剩「渲染 + 输入」：它没有配置（不知道端点与 Key，也不知道
 * `defaultMigrationModel` 是谁），更不该自己去发请求。而「这段会话该叫什么」是**服务端**
 * 的事 —— 会话与它的消息历史都在服务端，客户端拿到一条 `session-title-changed` 就够了。
 *
 * ## 为什么是「一次性小请求」而不是 Agent 回合
 *
 * 起名不是对话：没有工具、不需要历史延续、结果用完即弃。走 Agent 回合会把这一次请求写进
 * `agent.messages`，于是用户会看到一段莫名其妙的「请给这段对话起名」历史，下一轮还要
 * 把它再发一遍（花的是真钱）。所以用 SDK 的 `completeOnce`（与交接的 `summary` 模式同一条
 * 路），**消息历史一个字不碰**。
 *
 * ## 三种「跳过」都是静默的
 *
 * 配置里关了（`autoTitle === false`）、拿不到模型、调用失败（无 Key / 网络 / 超时）——
 * 一律回 `null` 或让异常冒到调用方（`SessionManager` 在那里吞掉）。理由：用户从没要求
 * 「起名」这件事，它失败就该像没发生过；弹一条「起名失败」的通知只会让人以为出了故障。
 *
 * ## 这个模块不认识会话
 *
 * 入参是「模型 + 消息 + 取消信号」，返回一个名字。触发时机（只第一轮）、不覆盖手改名、
 * 超时、落盘、发事件全在 `SessionManager` 手里 —— 那里才有会话对象。这样本模块可以拿
 * 一份假配置直接测，不需要造会话。
 */

import {
  ConfigManager,
  completeOnce,
  createModelFromConfig,
  type AppConfig,
} from "@ai-zen/agents-sdk";

/** 起名请求的输入（由会话层给：它才知道这一段用什么模型、聊了什么） */
export interface AutoTitleRequest {
  /** 这一段会话**生效的**模型 id（三级解析的结果）；只在没配辅助模型时才用到它 */
  modelId: string;
  /** 待起名的对话（拷贝；本模块只读，绝不改） */
  messages: unknown[];
  /** 超时 / 会话被关时的取消信号：请求要真的断掉，而不是跑完之后再假装没发生 */
  signal?: AbortSignal;
}

/** 生成一个标题；`null` = 这一次不生成（配置关了 / 没模型 / 模型给了空名字） */
export type AutoTitleFn = (request: AutoTitleRequest) => Promise<string | null>;

export interface AutoTitleOptions {
  /** `<配置根>/config.json`（组装根解析成绝对路径后传进来，本模块不读全局路径） */
  configFile: string;
  /** 注入：读配置；默认 SDK 的 `ConfigManager`（读到即迁移） */
  loadConfig?: (configFile: string) => Promise<AppConfig>;
}

/**
 * 提示词：要的是「名字」，不是「总结」。
 *
 * 三句约束都是踩过的形态：标题会进侧栏（一行、窄），所以不能是句子；模型爱加引号
 * （`"修 bug"`），所以明说不要；语言跟随用户 —— 中文会话里冒出一个英文标题，
 * 侧栏一眼就是机器味。
 */
const TITLE_SYSTEM_PROMPT = [
  "Name this conversation.",
  "Reply with the name only: no quotes, no trailing punctuation, no explanation.",
  "At most 12 words, or 20 characters if the conversation is in Chinese, Japanese or Korean.",
  "Write the name in the same language as the user.",
].join("\n");

/**
 * 送给模型的历史长度上限（字符）。
 *
 * 标题看的是「这段在聊什么」，开头几轮足够了；不设上限的话，一段聊了 200 轮、上下文
 * 几十万字的会话会为了一个名字把整段历史发一遍 —— 那笔钱比标题本身贵得多。
 */
const MAX_TRANSCRIPT_CHARS = 4_000;

/** 标题自身的长度上限（与提示词的 20 字对齐；模型偶尔不听话，这里兜一道硬边界） */
const MAX_TITLE_CHARS = 60;

/** 造一个「生成标题」的函数（服务端在组装根里接给会话层） */
export function createAutoTitle(options: AutoTitleOptions): AutoTitleFn {
  const loadConfig = options.loadConfig ?? defaultLoadConfig;

  return async (request) => {
    const config = await loadConfig(options.configFile);

    // 「缺省视为开启」的唯一判定：只有明确写了 `false` 才算关。老配置里没有这个字段，
    // 用户的意图显然是「按出厂的样子跑」（出厂写的是 `true`）——
    // 所以也**不做**配置迁移补齐：补了就有两处定义默认值。
    if (config.autoTitle === false) return null;

    // 用哪个模型：`defaultMigrationModel` 是「辅助小请求」的模型（摘要 / 起名这类），
    // 配了就用它。没配才用这一段会话生效的模型 —— 否则每段会话开头都多花一次**主**
    // 模型的调用，而主模型往往是又贵又慢的那个。
    const modelId = config.defaultMigrationModel || request.modelId;
    if (!modelId) return null; // 两个都空：没模型可用，跳过（静默）

    // 模型不在清单里 / 端点没配 Key：`createModelFromConfig` 会抛。不在这里 catch——
    // 「生成失败一律静默」是**调用方**那条路径上的唯一一处判定（SessionManager.autoTitle），
    // 在这里再吞一次就是第二份口径。
    const { client, model, modelConfig } = createModelFromConfig(config, modelId);

    const text = await completeOnce({
      client,
      model,
      modelConfig,
      system: TITLE_SYSTEM_PROMPT,
      user: transcriptOf(request.messages),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    return normalizeTitle(text);
  };
}

/** 默认读配置：与配置中心同一个入口（缺失时回出厂默认，旧字段在读到时就迁掉） */
async function defaultLoadConfig(configFile: string): Promise<AppConfig> {
  return await new ConfigManager(configFile).read();
}

/**
 * 把消息历史拼成一段纯文本给模型看。
 *
 * 两条取舍：
 *   - **跳过 `omit: true` 的消息**：那是迁移之前那一段的历史（`omit` 策略的产物），
 *     它讲的已经不是这段会话现在在聊的事。与交接 `summary` 模式同一个过滤口径。
 *   - 只取 user / assistant 的**字符串**正文：system 是给 Agent 的指令（不是对话内容），
 *     内容块（图片 / 文件）对起名没有帮助、还会把请求撑大。
 */
function transcriptOf(messages: unknown[]): string {
  const lines: string[] = [];
  for (const message of messages as Array<{ role?: unknown; content?: unknown; omit?: unknown }>) {
    if (message?.omit === true) continue;
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    if (typeof message.content !== "string" || !message.content.trim()) continue;
    lines.push(`[${message.role}]: ${message.content}`);
  }
  const transcript = lines.join("\n\n");
  return transcript.slice(0, MAX_TRANSCRIPT_CHARS);
}

/**
 * 模型给的正文 → 一个名字。
 *
 * 取第一行、剥掉包着的引号、截到上限：三件都是「模型不太听话」的常态（它会解释、会加
 * 引号、会把标题写长），而侧栏只能显示一行。收完为空就回 `null`（宁可没有名字，
 * 也不要一个空标题 —— 空标题会让客户端停止用首条消息兑底）。
 */
function normalizeTitle(text: string): string | null {
  const first = (text.trim().split("\n")[0] ?? "").trim();
  const unquoted = first.replace(/^["'“”「」『』《》]+|["'“”「」『』《》]+$/g, "").trim();
  if (!unquoted) return null;
  return unquoted.slice(0, MAX_TITLE_CHARS);
}
