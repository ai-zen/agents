import { CallbackTool } from "@ai-zen/agents-core";
import type { ToolDeclaration } from "@modelcontextprotocol/ext-tasks/client";
import { fileToContentSection, resolveModelAndEndpoint } from "../../../shared/content-blocks.js";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { createDisclosureParam } from "../../disclosure.js";
import { DEFAULT_MAX_TOOL_OUTPUT, guardOutput, headTailPreview } from "../builtin/outputGuard.js";
import { SILENT_LOG, type LogSink } from "../../../shared/logger.js";
import { elicitationOwnerOf, withElicitationOwner } from "./elicitation.js";
import type { McpConnectionManager } from "./McpConnectionManager.js";
import { CANCEL_MCP_TASK_TOOL, GET_MCP_TASK_RESULT_TOOL } from "./mcpTaskNotice.js";
import type {
  EndpointDefinition,
  McpServerDefinition,
  McpServerManifest,
  ModelDefinition,
  ToolEnv,
  ToolEnvDeps,
} from "../../../types/index.js";

const EMPTY_HINT = "(No MCP servers available, ask the user to add one)";

/**
 * 创建 load_mcp 工具。
 * server 枚举由 filteredMcps （完整 McpServerDefinition[]）自动推导，
 * 查找配置也直接使用 filteredMcps，与枚举来源一致。
 *
 * @param logger 日志口（可选）：报「连上了、清单多大」那两句走它；不注入就不记（库缺省沉默）
 */
export function createLoadMcpTool(
  mcpManager: McpConnectionManager,
  filteredMcps: McpServerDefinition[],
  logger: LogSink = SILENT_LOG,
): CallbackTool {
  // 构建 id→config 查找表
  const configMap = new Map<string, McpServerDefinition>();
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
        "Connect to the specified MCP server and get the list of tools, resources and skills it exposes. Pass include_manifest=false to only establish the connection without returning the manifest (useful when the manifest is already in context).",
      parameters: {
        type: "object",
        properties: {
          server: {
            type: "string",
            description: serverIdDescription,
            ...(param.enum ? { enum: param.enum } : {}),
          },
          include_manifest: {
            type: ["boolean", "null"],
            description:
              "Whether to return the server's full capability manifest (tools and resources). null means true. If the manifest is already in your context (for example it was loaded earlier in this session but the connection was dropped after a process restart), set it to false to only establish the connection and return a summary, saving context tokens",
            default: true,
          },
        },
        required: ["server", "include_manifest"],
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
          `[load_mcp] ${serverName}: connected (manifest not disclosed: ${manifest.tools.length} tools, ${manifest.resources.length} resources, ${manifest.skills?.length ?? 0} skills)`,
        );
        return JSON.stringify({
          server: serverName,
          connected: true,
          tools: manifest.tools.length,
          resources: manifest.resources.length,
          skills: manifest.skills?.length ?? 0,
        });
      }

      logger.info(`[load_mcp] ${serverName}:\n${JSON.stringify(manifest, null, 2)}`);
      return JSON.stringify({
        tools: manifest.tools,
        resources: manifest.resources,
        // 没声明技能的服务器就不占地儿（它们在清单里没意思，只会让模型多读一行空数组）
        ...(manifest.skills?.length ? { skills: manifest.skills } : {}),
      });
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
  endpoint?: EndpointDefinition | null;
  model?: ModelDefinition | null;
  signal?: AbortSignal;
  /** 出网动作的注入点（缺省走真实 OpenAI SDK） */
  deps?: ToolEnvDeps;
}

/** 当前这次调用该按哪个端点、哪个模型处理媒体（模型名从 Agent 上现读） */
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
 * 端点支持 Files API 时上传为 `file` 块，否则 base64 内联——图片不进字符开关门，也不丢弃。
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
 * 模型给的 `arguments` → 交出去的参数对象。
 *
 * 严格模式里没法声明「任意键的对象」（每一层对象都要求 `additionalProperties: false`），
 * 所以 MCP 这套参数的入口是一串 JSON 文本，这里把它解开。解不开就把原因交回给模型，
 * 而不是把坏 JSON 或空对象转给服务器 —— 后者会让模型以为工具真的收不到参数。
 */
function parseToolArguments(raw: unknown): Record<string, unknown> | string {
  if (raw === undefined || raw === null || raw === "") return {};
  // 兼容旧形状：早期是对象，用户自己拼出来的历史里可能还留着
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") {
    return `❌ call_mcp_tool: arguments must be a JSON object string, got: ${JSON.stringify(raw)}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: any) {
    return (
      `❌ call_mcp_tool: arguments is not valid JSON (${error?.message ?? error}); ` +
      `expected a JSON object string such as {"key":"value"}`
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return `❌ call_mcp_tool: arguments must be a JSON object string, got: ${raw}`;
  }
  return parsed as Record<string, unknown>;
}

/**
 * 创建 call_mcp_tool 工具。
 * 通过官方 Client.callTool() API 调用 MCP 服务器上的工具。
 *
 * 返回形态：
 *   - 仅文本 → 纯字符串；
 *   - 含媒体 → 内容块数组，按 MCP content 的原始顺序（文本块可能夹在中间）。
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
        "Call a tool exposed by a connected MCP server. " +
        "Large text output is written to disk and only a head/tail preview is returned; images, " +
        "audio and other media are preserved: uploaded and referenced by file_id when the " +
        "endpoint supports the Files API, otherwise inlined as base64.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name" },
          tool: { type: "string", description: "Tool name" },
          arguments: {
            type: "string",
            description:
              'Tool arguments as a JSON object string, e.g. "{\\"path\\":\\"/tmp\\"}". ' +
              'Pass "{}" when the tool takes no arguments.',
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
      const bridge = mcpManager.getTaskBridge(serverName);
      if (!client || !bridge) {
        return `MCP server "${serverName}" client is not available`;
      }

      const toolName = input.tool as string;

      const args = parseToolArguments(input.arguments);
      if (typeof args === "string") return args;

      try {
        mcpManager.touch(serverName);
        const media = mediaContextOf(env, ctx);
        // 用不用任务不在这里说：我们只按工具声明的那一档提个偏好，最终由服务器在应答里定
        //
        // 这一趟包在「谁在问」里：服务器中途可能发 `elicitation/create` 回来，那一刻得知道该把
        // 题挂到哪一段会话上（见 `elicitation.ts` 的文件头）。
        const call = await withElicitationOwner(
          mcpManager.getClient(serverName),
          elicitationOwnerOf(ctx?.agent),
          () =>
            bridge.call({
              tool: toolName,
              args,
              ...(declarationOf(mcpManager, serverName, toolName) === undefined
                ? {}
                : { declaration: declarationOf(mcpManager, serverName, toolName)! }),
              ...(ctx?.agent === undefined ? {} : { agent: ctx.agent }),
              ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }),
            }),
        );

        if (call.kind === "task") {
          return taskHandleText(serverName, call.taskId);
        }
        return await outcomeToContent(call.outcome, env, media);
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
        "Read a resource (document, data, image, or a skill's SKILL.md and its files) from a connected MCP server. Text is returned as-is; images and other media are uploaded (file_id) or inlined as base64 depending on endpoint capabilities, and are never dropped.",
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
 * 把一个工具在清单里声明的那一档交成扩展包认的形状。
 *
 * 清单来自 `tools/list`，所以这里问的和服务器说的是同一件事，不必再发一次请求。
 */
function declarationOf(
  mcpManager: McpConnectionManager,
  server: string,
  tool: string,
): ToolDeclaration | undefined {
  const found = mcpManager.getManifest(server)?.tools.find((item) => item.name === tool);
  if (found === undefined) return undefined;
  return {
    name: found.name,
    ...(found.description === "" ? {} : { description: found.description }),
    inputSchema: found.inputSchema as ToolDeclaration["inputSchema"],
    ...(found.execution?.taskSupport === undefined
      ? {}
      : { taskSupport: found.execution.taskSupport }),
  };
}

/**
 * 拿到任务句柄时回给模型的那段话。
 *
 * 三件事要一次说全，缺一件模型就会在这里等一个不会自己回来的结果：这是个任务而不是结果、任务
 * id 是什么、结果要自己拿哪一条工具去取（带齐两个参数的形状）。最后一句说清终态到了会有话过来，
 * 那正是「不用在这儿等」的理由。
 */
function taskHandleText(server: string, taskId: string): string {
  return JSON.stringify({
    task: true,
    taskId,
    hint:
      `This is a TASK, not a result: the server accepted the call and is working on it. ` +
      `Nothing comes back through this call. Get the result with ${GET_MCP_TASK_RESULT_TOOL} ` +
      `and the arguments {"server":"${server}","task_id":"${taskId}"}; ` +
      `give it up with ${CANCEL_MCP_TASK_TOOL} and the same two. ` +
      `When the task ends (completed / failed / cancelled) a message about it arrives in this session.`,
  });
}

/** 任务的一份终态 → 交给模型的内容 */
async function outcomeToContent(
  outcome: { status: string; result?: unknown; error?: { message: string } },
  env: ToolEnv,
  media: MediaContext,
): Promise<AgentNS.MessageContent> {
  if (outcome.status === "completed") return await callResultToContent(outcome.result, env, media);
  if (outcome.status === "cancelled") return `❌ The task was cancelled`;
  return `❌ The task failed: ${outcome.error?.message ?? "no reason given"}`;
}

/**
 * 创建 get_mcp_task_result 工具：按任务 id 取回结果。
 *
 * 结果原样交给模型：服务器存下来的就是一次工具调用的结果，与 `call_mcp_tool` 走同一套媒体映射
 * 与输出保护（见 {@link callResultToContent}）。任务还没跑完时这里会等它跑完 —— 这条工具就是
 * 「去拿结果」，没有第二种语义。
 */
export function createGetMcpTaskResultTool(
  mcpManager: McpConnectionManager,
  env: ToolEnv,
  filteredMcps: string[],
): CallbackTool {
  // 与 call_mcp_tool 同一白名单口径
  const allowed = new Set(filteredMcps);
  const allowList = filteredMcps.join(", ") || "(none)";

  return new CallbackTool({
    function: {
      name: GET_MCP_TASK_RESULT_TOOL,
      description:
        "Get the result of an MCP task by task id. The result is handed back as it is (text and " +
        "media, with the same output protection: large text is written to disk and only a head/tail " +
        "preview is returned; images and other media are never dropped). Use it when the session was " +
        "told that the task ended; if the task has not finished yet the call waits for it.",
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
      const bridge = mcpManager.getTaskBridge(serverName);
      if (bridge === undefined) {
        return `MCP server "${serverName}" client is not available`;
      }

      const taskId = String(input.task_id ?? "");
      try {
        mcpManager.touch(serverName);
        const outcome = await bridge.getResult(taskId);
        return await outcomeToContent(outcome, env, mediaContextOf(env, ctx));
      } catch (error: any) {
        return `❌ Failed to get the result of task "${taskId}" on "${serverName}": ${error?.message ?? error}`;
      }
    },
  });
}

/**
 * 创建 cancel_mcp_task 工具：让服务器停掉一个已经发起的任务。
 *
 * 取消能不能成由服务器说了算，发出去之后终态通知照旧会到；这里只把「已经发出去」这件事回给模型，
 * 不假装已经停下来了。
 */
export function createCancelMcpTaskTool(
  mcpManager: McpConnectionManager,
  filteredMcps: string[],
): CallbackTool {
  // 与 call_mcp_tool 同一白名单口径
  const allowed = new Set(filteredMcps);
  const allowList = filteredMcps.join(", ") || "(none)";

  return new CallbackTool({
    function: {
      name: CANCEL_MCP_TASK_TOOL,
      description:
        "Cancel a running MCP task by task id. The server decides whether it can stop; a task " +
        "that already ended cannot be cancelled and the call fails with the reason it gives.",
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
      const bridge = mcpManager.getTaskBridge(serverName);
      if (bridge === undefined) {
        return `MCP server "${serverName}" client is not available`;
      }

      const taskId = String(input.task_id ?? "");
      try {
        mcpManager.touch(serverName);
        await bridge.cancel(taskId);
        return JSON.stringify({ taskId, cancelled: true });
      } catch (error: any) {
        return `❌ Failed to cancel task "${taskId}" on "${serverName}": ${error?.message ?? error}`;
      }
    },
  });
}
