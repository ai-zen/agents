import { CallbackTool } from "@ai-zen/agents-core";
import { GetTaskPayloadResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Task } from "@modelcontextprotocol/sdk/types.js";
import { fileToContentSection, resolveModelAndEndpoint } from "../../../shared/content-blocks.js";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { createDisclosureParam } from "../../disclosure.js";
import { DEFAULT_MAX_TOOL_OUTPUT, guardOutput, headTailPreview } from "../builtin/outputGuard.js";
import { SILENT_LOG, type LogSink } from "../../../shared/logger.js";
import type { McpConnectionManager } from "./McpConnectionManager.js";
import { CANCEL_MCP_TASK_TOOL, GET_MCP_TASK_RESULT_TOOL } from "./mcpTaskNotice.js";
import type {
  Endpoint,
  McpServerConfig,
  McpServerManifest,
  Model,
  ToolEnv,
  ToolEnvDeps,
} from "../../../types/index.js";

const EMPTY_HINT = "(No MCP servers available, ask the user to add one)";

/**
 * 创建 load_mcp 工具。
 * server 枚举由 filteredMcps （完整 McpServerConfig[]）自动推导，
 * 查找配置也直接使用 filteredMcps，与枚举来源一致。
 *
 * @param logger 日志口（可选）：报「连上了、清单多大」那两句走它；不注入就不记（库缺省沉默）
 */
export function createLoadMcpTool(
  mcpManager: McpConnectionManager,
  filteredMcps: McpServerConfig[],
  logger: LogSink = SILENT_LOG,
): CallbackTool {
  // 构建 id→config 查找表
  const configMap = new Map<string, McpServerConfig>();
  for (const s of filteredMcps) {
    configMap.set(s.id, s);
  }

  const ids = filteredMcps.map((s) => s.id);
  const param = createDisclosureParam(ids, "MCP server name", EMPTY_HINT);

  // 拼接各 MCP 服务器的描述供 LLM 参考（对齐 load_skill 的处理方式）
  const mcpDescriptions = filteredMcps
    .map((s) => `  - ${s.id}: ${s.description || "No description"}`)
    .join("\n");
  const serverIdDescription = `${param.description}\n\nAvailable MCP servers:\n${mcpDescriptions || "  No MCP servers available"}`;

  return new CallbackTool({
    function: {
      name: "load_mcp",
      description:
        "Connect to the specified MCP server and get the list of tools and resources it exposes. Pass include_manifest=false to only establish the connection without returning the manifest (useful when the manifest is already in context).",
      parameters: {
        type: "object",
        properties: {
          server: {
            type: "string",
            description: serverIdDescription,
            ...(param.enum ? { enum: param.enum } : {}),
          },
          include_manifest: {
            type: "boolean",
            description:
              "Whether to return the server's full capability manifest (tools and resources). Optional, defaults to true. If the manifest is already in your context (for example it was loaded earlier in this session but the connection was dropped after a process restart), set it to false to only establish the connection and return a summary, saving context tokens",
            default: true,
          },
        },
        required: ["server"],
        additionalProperties: false,
      },
    },
    callback: async (input): Promise<string> => {
      const serverName = input.server as string;
      const config = configMap.get(serverName);
      if (!config) {
        return `❌ MCP server "${serverName}" is not configured`;
      }

      // 披露开关：默认返回完整清单；显式传 false 时仅建立连接、只返回摘要
      const includeManifest = input.include_manifest !== false;

      // 获取清单：已连接 → 复用缓存（touch 续期）；未连接 → 建连并发现
      let manifest: McpServerManifest;
      const existingManifest = mcpManager.getManifest(serverName);
      if (existingManifest && mcpManager.getState(serverName) === "connected") {
        mcpManager.touch(serverName);
        manifest = existingManifest;
      } else {
        try {
          manifest = await mcpManager.connect(serverName, config);
        } catch (error: any) {
          return `Failed to connect to "${serverName}": ${error?.message ?? error}`;
        }
      }

      // 静默模式：只回吐摘要（清单仍留在管理器内，供 call_mcp_tool 使用）
      if (!includeManifest) {
        logger.info(
          `[load_mcp] ${serverName}: connected (manifest not disclosed: ${manifest.tools.length} tools, ${manifest.resources.length} resources)`,
        );
        return JSON.stringify({
          server: serverName,
          connected: true,
          tools: manifest.tools.length,
          resources: manifest.resources.length,
        });
      }

      logger.info(`[load_mcp] ${serverName}:\n${JSON.stringify(manifest, null, 2)}`);
      return JSON.stringify({ tools: manifest.tools, resources: manifest.resources });
    },
  });
}

/** call_mcp_tool 的输出保护入参 */
interface McpCallOutput {
  /** 按 MCP content 原始顺序映射后的内容块（文本与媒体的相对位置完整保留） */
  sections: AgentNS.MessageContentSection[];
  /** 全部文本块拼接结果，仅用于落盘与头尾预览 */
  fullText: string;
  /** 文本总字符数（不含媒体） */
  chars: number;
  /** MCP 是否以 isError 应答 */
  isError: boolean;
}

/** 媒体转换所需的上下文：端点决定能否上传，模型决定是否看得见图 */
interface MediaContext {
  endpoint?: Endpoint | null;
  model?: Model | null;
  signal?: AbortSignal;
  /** 出网动作的注入点（缺省走真实 OpenAI SDK） */
  deps?: ToolEnvDeps;
}

/** 当前这次调用该按哪个端点、哪个模型处理媒体（模型名从执行体上现读） */
function mediaContextOf(env: ToolEnv, ctx?: ToolCallContext): MediaContext {
  const { model, endpoint } = resolveModelAndEndpoint(env.config, ctx?.agent?.model);
  return { endpoint, model, signal: ctx?.signal, deps: env.deps };
}

/** MIME → 文件名后缀（仅用于上传时给文件一个好名字） */
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "application/pdf": "pdf",
};

/**
 * MCP 媒体（base64 字符串）→ SDK 内容块。
 *
 * 统一交给 `fileToContentSection()` 决定传输方式：端点声明 Files API 能力就上传
 * （`file` 块 + `file_id`，请求体小、不随历史反复膨胀），否则保持 base64 内联。
 * 转换失败**不丢块**——退化为一条文本说明，避免整个工具调用因媒体问题失败。
 */
async function mediaSection(
  data: string,
  mime: string,
  media: MediaContext,
): Promise<AgentNS.MessageContentSection> {
  const ext = EXT_BY_MIME[mime] ?? "bin";
  try {
    const { section } = await fileToContentSection({
      source: {
        base64: data,
        mime,
        filename: `mcp-media-${Date.now()}.${ext}`,
      },
      endpoint: media.endpoint,
      model: media.model,
      signal: media.signal,
      deps: media.deps,
    });
    return section;
  } catch (error: any) {
    return {
      type: "text",
      text: `[media] Failed to convert (${mime}): ${error?.message ?? error}`,
    };
  }
}

/**
 * `read_mcp_resource` 的 resource contents → SDK 内容块。
 *
 * 注意形状差异：`callTool` 的 content 块带 `type` 判别字段，而 `readResource` 的
 * contents 是 `{ uri, mimeType?, text }` 或 `{ uri, mimeType?, blob }`——**没有 type**。
 * 若直接复用 `toMessageSection`，文本资源会掉进 default 分支被 JSON 化（实测踩过）。
 */
async function resourceToMessageSection(
  item: any,
  media: MediaContext,
): Promise<AgentNS.MessageContentSection> {
  if (typeof item?.text === "string") return { type: "text", text: item.text };
  if (typeof item?.blob === "string") {
    return mediaSection(item.blob, item.mimeType ?? "application/octet-stream", media);
  }
  return { type: "text", text: JSON.stringify(item) };
}

/**
 * MCP content 块 → SDK 内容块。
 *
 * 文本类（text / resource.text / resource_link / 未知类型）归一为 `text` 块，
 * 由调用方拼接成正文后进入输出保护；
 * 媒体类（image / audio / resource.blob）经 `mediaSection()` → `fileToContentSection()`：
 * 端点支持 Files API 时上传为 `file` 块，否则 base64 内联——图片不进字符闸门，也不丢弃。
 */
async function toMessageSection(
  block: any,
  media: MediaContext,
): Promise<AgentNS.MessageContentSection> {
  switch (block?.type) {
    case "image":
      return await mediaSection(block.data, block.mimeType ?? "image/png", media);

    case "audio":
      // AgentNS 无独立音频块，以 `file` 块承载（支持上传的端点 → file_id，否则 file_data 内联）
      return await mediaSection(block.data, block.mimeType ?? "audio/wav", media);

    case "resource": {
      const r = block.resource ?? {};
      // 内嵌文本资源：本质是纯文本，并入正文（同样受输出保护）
      if (typeof r.text === "string") return { type: "text", text: r.text };
      // 内嵌二进制资源：按 mimeType 选块类型，不丢弃
      if (typeof r.blob === "string") {
        const mime = r.mimeType ?? "application/octet-stream";
        return await mediaSection(r.blob, mime, media);
      }
      return { type: "text", text: `[resource] ${r.uri ?? "(unknown URI)"}` };
    }

    case "resource_link": {
      const parts = [block.name, block.uri, block.mimeType].filter(Boolean);
      return { type: "text", text: `[resource_link] ${parts.join(" · ")}` };
    }

    case "text":
      return { type: "text", text: block.text ?? "" };

    default:
      // 未知类型（如 tool_use）退化为 JSON 文本，仍受输出保护
      return { type: "text", text: JSON.stringify(block) };
  }
}

/**
 * 文本输出保护（保序）：
 *
 * - **未超限**：原样返回映射后的块数组，不重排、不合并、不丢块；
 *   纯文本时退化为单个字符串。
 * - **超限**：全部文本落盘为 result.txt，只保留**一个**警告文本块占据
 *   原首个文本块的位置，其余文本块丢弃（内容已落盘），媒体块原位不动。
 *   这样即使文本夹在中间，媒体与位置的对应关系也不会被打乱。
 *
 * 判定用全部文本的字符总数——不能逐块判，否则 N 段各 3 万字符都不超限、合起来却能灌爆。
 * 落盘只写文本正文，不写原始结果——后者可能含 image 的 base64，
 * 落盘等于把几 MB 二进制再抄一遍磁盘。
 */
async function protectCallOutput(
  output: McpCallOutput,
  env: ToolEnv,
): Promise<AgentNS.MessageContent> {
  const limit = env.config.maxToolOutput ?? DEFAULT_MAX_TOOL_OUTPUT;
  const { sections, fullText, chars, isError } = output;

  const guarded = await guardOutput({
    tool: "call_mcp_tool",
    content: output,
    isOverLimit: (o) => o.chars > limit,
    dump: (_dir, o) => [{ name: "result.txt", content: o.fullText }],
    buildWarning: (ctx) => {
      const preview = headTailPreview(fullText);
      return JSON.stringify({
        outputTooLarge: true,
        isError: isError || undefined,
        warning:
          `Text output too large: ${chars} characters, exceeding the limit of ${limit} characters. ` +
          `The full text has been written to disk (result.txt); use read to page through it.`,
        files: ctx.files,
        chars,
        ...preview,
      });
    },
  });

  // 超限：警告占据首个文本块的位置，其余文本块合并到它身上（内容已落盘），媒体原位
  if (typeof guarded === "string") {
    const collapsed: AgentNS.MessageContentSection[] = [];
    let placed = false;
    for (const section of sections) {
      if (section.type === "text") {
        if (!placed) {
          collapsed.push({ type: "text", text: guarded });
          placed = true;
        }
        continue;
      }
      collapsed.push(section);
    }
    // 仅一个文本块（无媒体）：退化为字符串
    return collapsed.length === 1 ? (collapsed[0] as AgentNS.TextContentSection).text : collapsed;
  }

  // 未超限：无媒体 → 纯字符串；有媒体 → 原序块数组
  const hasMedia = sections.some((s) => s.type !== "text");
  if (!hasMedia) return isError ? `❌ Tool execution failed:\n${fullText}` : fullText;
  return isError ? [{ type: "text", text: "❌ Tool execution failed:" }, ...sections] : sections;
}

/**
 * 一次工具调用的结果（`CallToolResult` 那一格）→ 回给模型的内容。
 *
 * 两处共用这一份：同步调用的结果与任务结果的形状是同一个 —— 规范里 `tasks/result` 的载荷就是
 * 原请求的结果类型，各写一遍只会让其中一处漏掉后来的修改。
 */
async function callResultToContent(
  raw: unknown,
  env: ToolEnv,
  media: MediaContext,
): Promise<AgentNS.MessageContent> {
  const result = (raw ?? {}) as { content?: any[]; isError?: boolean };

  // 按 MCP content 原始顺序映射，文本与媒体的相对位置完整保留
  const contents: any[] = result.content ?? [];
  const isError = Boolean(result.isError);

  // 没有 content 时退回原始 JSON（既有兜底）
  if (contents.length === 0) {
    const json = JSON.stringify(raw);
    return await protectCallOutput(
      {
        sections: [{ type: "text", text: json }],
        fullText: json,
        chars: json.length,
        isError,
      },
      env,
    );
  }

  // Promise.all 保序：文本与媒体的相对位置不变
  const sections = await Promise.all(contents.map((block) => toMessageSection(block, media)));
  const textSections = sections.filter((s): s is AgentNS.TextContentSection => s.type === "text");
  const fullText = textSections.map((s) => s.text).join("\n");
  const chars = textSections.reduce((n, s) => n + s.text.length, 0);

  return await protectCallOutput({ sections, fullText, chars, isError }, env);
}

/**
 * 拿到句柄时回给模型的那段话。
 *
 * 三件事要一次说全，缺一件模型就会在这里等一个不会自己回来的结果：这是个任务而不是结果、任务
 * id 是什么、结果要自己拿哪一条工具去取（带齐两个参数的形状）。最后一句说清状态到了会有话过来，
 * 那正是「不用在这儿等」的理由。
 */
function taskHandleText(server: string, task: Task): string {
  return JSON.stringify({
    task: true,
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage === undefined ? {} : { statusMessage: task.statusMessage }),
    hint:
      `This is a TASK, not a result: the server accepted the call and is working on it. ` +
      `Nothing comes back through this call. Get the result with ${GET_MCP_TASK_RESULT_TOOL} ` +
      `and the arguments {"server":"${server}","task_id":"${task.taskId}"}; ` +
      `give it up with ${CANCEL_MCP_TASK_TOOL} and the same two. ` +
      `When the task ends (completed / failed / cancelled) a message about it arrives in this ` +
      `session, so there is no need to poll it.`,
  });
}

/**
 * 创建 call_mcp_tool 工具。
 * 通过官方 Client.callTool() API 调用 MCP 服务器上的工具。
 *
 * 返回形态：
 *   - 仅文本 → 纯字符串；
 *   - 含媒体 → 内容块数组，按 MCP content 的原始顺序（文本块可能夹在中间）；
 *   - 任务是任务时 → 一段带任务 id 的 JSON，结果不在这条路上回来（见 {@link taskHandleText}）。
 *
 * env 仅用于读取 maxToolOutput（文本输出保护上限），与内置工具口径一致。
 */
export function createCallMcpTool(
  mcpManager: McpConnectionManager,
  env: ToolEnv,
  filteredMcps: string[],
): CallbackTool {
  // 权限白名单：`filteredMcps` 是本 Scope 允许的 server。
  // 连接管理器是全局共享的，只按"是否 connected"判断会让任一 Agent 连上的 server 对其他 Scope 敞开。
  const allowed = new Set(filteredMcps);
  const allowList = filteredMcps.join(", ") || "(none)";

  return new CallbackTool({
    function: {
      name: "call_mcp_tool",
      description:
        "Call a tool exposed by a connected MCP server. Connect the server with load_mcp first. " +
        "Large text output is written to disk and only a head/tail preview is returned; images, " +
        "audio and other media are preserved: uploaded and referenced by file_id when the " +
        "endpoint supports the Files API, otherwise inlined as base64. " +
        `Pass task=true to run a long call as a task: the call then returns a task id instead of ` +
        `a result, and the result is fetched later with ${GET_MCP_TASK_RESULT_TOOL}. Tools that ` +
        "require a task always run as one, tools that forbid it never do.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name" },
          tool: { type: "string", description: "Tool name" },
          arguments: { type: "object", description: "Tool arguments" },
          task: {
            type: "boolean",
            description:
              "Run this call as a task (optional). The call returns a task id at once and the " +
              "result has to be fetched by that id; when the task ends a message about it arrives " +
              "in this session. Only tools that allow task execution can do it — for the others " +
              "this flag makes no difference.",
          },
        },
        required: ["server", "tool", "arguments"],
        additionalProperties: false,
      },
    },
    callback: async (input, ctx): Promise<AgentNS.MessageContent> => {
      const serverName = input.server as string;
      if (!allowed.has(serverName)) {
        return `❌ MCP server "${serverName}" is not available here. Available servers: ${allowList}`;
      }

      const state = mcpManager.getState(serverName);
      if (state !== "connected") {
        return `Call load_mcp to connect "${serverName}" first`;
      }

      const client = mcpManager.getClient(serverName);
      if (!client) {
        return `MCP server "${serverName}" client is not available`;
      }

      const toolName = input.tool as string;
      const callArgs = {
        name: toolName,
        arguments: input.arguments as Record<string, unknown>,
      };

      // 三档怎么走：required 一定带任务参数（不带服务器会拒），optional 听调用方那一句，
      // forbidden 与没声明这一格的忽略它
      const support = mcpManager.taskSupportOf(serverName, toolName);
      const asTask = support === "required" || (support === "optional" && input.task === true);

      try {
        mcpManager.touch(serverName);
        const media = mediaContextOf(env, ctx);

        if (!asTask) {
          const result = await client.callTool(callArgs, undefined, { signal: ctx?.signal });
          return await callResultToContent(result, env, media);
        }

        // 任务增强：这条流的第一条就是句柄（`taskCreated`），拿到它就返回 —— 不等任务跑完，
        // 结果也不从这条路上回来
        const stream = client.experimental.tasks.callToolStream(callArgs, undefined, {
          task: {},
          signal: ctx?.signal,
        });
        for await (const message of stream) {
          switch (message.type) {
            case "taskCreated":
              // 记下这个任务是谁发起的：终态通知到了要投回这段会话
              mcpManager.rememberTask(serverName, message.task.taskId, ctx.agent);
              return taskHandleText(serverName, message.task);
            case "result":
              // 服务器没把它当任务（`optional` 档上它自己跑完了），结果就在这里
              return await callResultToContent(message.result, env, media);
            case "error":
              return `❌ Failed to call "${toolName}": ${message.error.message}`;
            default:
              // taskStatus：句柄已经交出去了才会来，这一次调用已经不需要它
              continue;
          }
        }
        return `❌ Failed to call "${toolName}": the task stream ended without a task or a result`;
      } catch (error: any) {
        return `❌ Failed to call "${input.tool}": ${error?.message ?? error}`;
      }
    },
  });
}

/**
 * 创建 read_mcp_resource 工具。
 */
export function createReadMcpResourceTool(
  mcpManager: McpConnectionManager,
  env: ToolEnv,
  filteredMcps: string[],
): CallbackTool {
  // 与 call_mcp_tool 同一白名单口径（见该工具的说明）
  const allowed = new Set(filteredMcps);
  const allowList = filteredMcps.join(", ") || "(none)";

  return new CallbackTool({
    function: {
      name: "read_mcp_resource",
      description:
        "Read a resource (document, data, image, etc.) from a connected MCP server. Text is returned as-is; images and other media are uploaded (file_id) or inlined as base64 depending on endpoint capabilities, and are never dropped.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name" },
          uri: { type: "string", description: "Resource URI" },
        },
        required: ["server", "uri"],
        additionalProperties: false,
      },
    },
    callback: async (input, ctx): Promise<AgentNS.MessageContent> => {
      const serverName = input.server as string;
      if (!allowed.has(serverName)) {
        return `❌ MCP server "${serverName}" is not available here. Available servers: ${allowList}`;
      }

      const state = mcpManager.getState(serverName);
      if (state !== "connected") {
        return `Call load_mcp to connect "${serverName}" first`;
      }

      const client = mcpManager.getClient(serverName);
      if (!client) {
        return `MCP server "${serverName}" client is not available`;
      }

      try {
        mcpManager.touch(serverName);
        const result = await client.readResource(
          { uri: input.uri as string },
          { signal: ctx?.signal },
        );

        const contents: any[] = result?.contents ?? [];
        const { model, endpoint } = resolveModelAndEndpoint(env.config, ctx?.agent?.model);
        const mediaContext: MediaContext = {
          endpoint,
          model,
          signal: ctx?.signal,
          deps: env.deps,
        };
        // 与 call_mcp_tool 同一套映射：文本归一为 text 块，媒体按端点能力上传或内联
        const sections = await Promise.all(
          contents.map((content) => resourceToMessageSection(content, mediaContext)),
        );

        // 没有 contents 时退回原始 JSON（与 call_mcp_tool 同一兜底）
        if (sections.length === 0) {
          const json = JSON.stringify(result);
          return await protectCallOutput(
            {
              sections: [{ type: "text", text: json }],
              fullText: json,
              chars: json.length,
              isError: false,
            },
            env,
          );
        }

        const textSections = sections.filter(
          (section): section is AgentNS.TextContentSection => section.type === "text",
        );
        const fullText = textSections.map((section) => section.text).join("\n");
        const chars = textSections.reduce((n, section) => n + section.text.length, 0);
        return await protectCallOutput({ sections, fullText, chars, isError: false }, env);
      } catch (error: any) {
        return `❌ Failed to read resource "${input.uri}": ${error?.message ?? error}`;
      }
    },
  });
}

/**
 * 创建 get_mcp_task_result 工具：按任务 id 去服务器取回结果。
 *
 * 结果原样交给模型：服务器存下来的就是一次工具调用的结果，与 `call_mcp_tool` 走同一套媒体映射
 * 与输出保护（见 {@link callResultToContent}）。
 */
export function createGetMcpTaskResultTool(
  mcpManager: McpConnectionManager,
  env: ToolEnv,
  filteredMcps: string[],
): CallbackTool {
  // 与 call_mcp_tool 同一白名单口径（见该工具的说明）
  const allowed = new Set(filteredMcps);
  const allowList = filteredMcps.join(", ") || "(none)";

  return new CallbackTool({
    function: {
      name: GET_MCP_TASK_RESULT_TOOL,
      description:
        "Get the result of a task started by call_mcp_tool with a task id. The result is handed " +
        "back as it is (text and media, same output protection as call_mcp_tool). Use it when " +
        "the session was told that the task ended; if the task has not finished yet the server " +
        "may hold the call until it does.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name" },
          task_id: { type: "string", description: "Task id returned when the task was started" },
        },
        required: ["server", "task_id"],
        additionalProperties: false,
      },
    },
    callback: async (input, ctx): Promise<AgentNS.MessageContent> => {
      const serverName = input.server as string;
      if (!allowed.has(serverName)) {
        return `❌ MCP server "${serverName}" is not available here. Available servers: ${allowList}`;
      }

      if (mcpManager.getState(serverName) !== "connected") {
        return `Call load_mcp to connect "${serverName}" first`;
      }

      const client = mcpManager.getClient(serverName);
      if (!client) {
        return `MCP server "${serverName}" client is not available`;
      }

      const taskId = String(input.task_id ?? "");
      try {
        mcpManager.touch(serverName);
        // 载荷的形状由原请求决定（`tasks/result` 返回的就是它的结果类型），所以取宽松的那一格：
        // 具体怎么解释由 `callResultToContent` 按 content / isError 做
        const payload = await client.experimental.tasks.getTaskResult(
          taskId,
          GetTaskPayloadResultSchema,
          { signal: ctx?.signal },
        );
        return await callResultToContent(payload, env, mediaContextOf(env, ctx));
      } catch (error: any) {
        return `❌ Failed to get the result of task "${taskId}" on "${serverName}": ${error?.message ?? error}`;
      }
    },
  });
}

/**
 * 创建 cancel_mcp_task 工具：让服务器停掉一个已经发起的任务。
 *
 * 回给模型的是任务此刻那一格（`tasks/cancel` 的应答就是这个形状）。终态通知照旧会来：
 * 取消也是终态，到了就把那条状态搁进 inbox。
 */
export function createCancelMcpTaskTool(
  mcpManager: McpConnectionManager,
  filteredMcps: string[],
): CallbackTool {
  // 与 call_mcp_tool 同一白名单口径（见该工具的说明）
  const allowed = new Set(filteredMcps);
  const allowList = filteredMcps.join(", ") || "(none)";

  return new CallbackTool({
    function: {
      name: CANCEL_MCP_TASK_TOOL,
      description:
        "Cancel a task started by call_mcp_tool. The server stops working on it; a task that " +
        "already ended cannot be cancelled and the call fails with the reason it gives.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name" },
          task_id: { type: "string", description: "Task id returned when the task was started" },
        },
        required: ["server", "task_id"],
        additionalProperties: false,
      },
    },
    callback: async (input, ctx): Promise<AgentNS.MessageContent> => {
      const serverName = input.server as string;
      if (!allowed.has(serverName)) {
        return `❌ MCP server "${serverName}" is not available here. Available servers: ${allowList}`;
      }

      if (mcpManager.getState(serverName) !== "connected") {
        return `Call load_mcp to connect "${serverName}" first`;
      }

      const client = mcpManager.getClient(serverName);
      if (!client) {
        return `MCP server "${serverName}" client is not available`;
      }

      const taskId = String(input.task_id ?? "");
      try {
        mcpManager.touch(serverName);
        const task = await client.experimental.tasks.cancelTask(taskId, { signal: ctx?.signal });
        return JSON.stringify({
          taskId: task.taskId,
          status: task.status,
          ...(task.statusMessage === undefined ? {} : { statusMessage: task.statusMessage }),
        });
      } catch (error: any) {
        return `❌ Failed to cancel task "${taskId}" on "${serverName}": ${error?.message ?? error}`;
      }
    },
  });
}
