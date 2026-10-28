import { CallbackTool } from "@ai-zen/agents-core";
import { fileToContentSection, resolveModelAndEndpoint, toDataUrl } from "../../../shared/content-blocks.js";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { createDisclosureParam } from "../../disclosure.js";
import { DEFAULT_MAX_TOOL_OUTPUT, guardOutput, headTailPreview } from "../builtin/outputGuard.js";
import { getLogger } from "../../../shared/logger.js";
import type { McpConnectionManager } from "./McpConnectionManager.js";
import type { Endpoint, McpServerConfig, McpServerManifest, Model, ToolEnv } from "../../../types/index.js";

const EMPTY_HINT = "(No MCP servers available, ask the user to add one)";

/**
 * 创建 load_mcp 工具。
 * server 枚举由 filteredMcps （完整 McpServerConfig[]）自动推导，
 * 查找配置也直接使用 filteredMcps，与枚举来源一致。
 */
export function createLoadMcpTool(
  mcpManager: McpConnectionManager,
  filteredMcps: McpServerConfig[],
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
        getLogger().info(
          `[load_mcp] ${serverName}: connected (manifest not disclosed: ${manifest.tools.length} tools, ${manifest.resources.length} resources)`,
        );
        return JSON.stringify({
          server: serverName,
          connected: true,
          tools: manifest.tools.length,
          resources: manifest.resources.length,
        });
      }

      getLogger().info(`[load_mcp] ${serverName}:\n${JSON.stringify(manifest, null, 2)}`);
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
async function toMessageSection(block: any, media: MediaContext): Promise<AgentNS.MessageContentSection> {
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
 *   纯文本时退化为单个字符串（历史行为）。
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
    // 仅一个文本块（无媒体）：退化为字符串，与历史行为一致
    return collapsed.length === 1 ? (collapsed[0] as AgentNS.TextContentSection).text : collapsed;
  }

  // 未超限：无媒体 → 纯字符串；有媒体 → 原序块数组
  const hasMedia = sections.some((s) => s.type !== "text");
  if (!hasMedia) return isError ? `❌ Tool execution failed:\n${fullText}` : fullText;
  return isError
    ? [{ type: "text", text: "❌ Tool execution failed:" }, ...sections]
    : sections;
}

/**
 * 创建 call_mcp_tool 工具。
 * 通过官方 Client.callTool() API 调用 MCP 服务器上的工具。
 *
 * 返回形态：
 *   - 仅文本 → 纯字符串（与历史行为一致）；
 *   - 含媒体 → 内容块数组：首块为受保护的文本，其后原样透传 image / file 块。
 *
 * env 仅用于读取 maxToolOutput（文本输出保护上限），与内置工具口径一致。
 */
export function createCallMcpTool(
  mcpManager: McpConnectionManager,
  env: ToolEnv,
): CallbackTool {
  return new CallbackTool({
    function: {
      name: "call_mcp_tool",
      description:
        "Call a tool exposed by a connected MCP server. Connect the server with load_mcp first. Large text output is written to disk and only a head/tail preview is returned; images, audio and other media are preserved: uploaded and referenced by file_id when the endpoint supports the Files API, otherwise inlined as base64.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name" },
          tool: { type: "string", description: "Tool name" },
          arguments: { type: "object", description: "Tool arguments" },
        },
        required: ["server", "tool", "arguments"],
        additionalProperties: false,
      },
    },
    callback: async (input, ctx): Promise<AgentNS.MessageContent> => {
      const serverName = input.server as string;
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
        const result = await client.callTool(
          {
            name: input.tool as string,
            arguments: input.arguments as Record<string, unknown>,
          },
          undefined,
          { signal: ctx?.signal },
        );

        // 按 MCP content 原始顺序映射，文本与媒体的相对位置完整保留
        const contents: any[] = (result as any).content ?? [];
        const isError = Boolean((result as any).isError);

        // 没有 content 时退回原始 JSON（既有兜底）
        if (contents.length === 0) {
          const json = JSON.stringify(result);
          return await protectCallOutput(
            { sections: [{ type: "text", text: json }], fullText: json, chars: json.length, isError },
            env,
          );
        }

        // 按当前模型定位端点：决定媒体走 Files API 上传还是 base64 内联
        const { model, endpoint } = resolveModelAndEndpoint(env.config, ctx?.agent?.model);
        const mediaContext: MediaContext = { endpoint, model, signal: ctx?.signal };
        // Promise.all 保序：文本与媒体的相对位置不变
        const sections = await Promise.all(
          contents.map((block) => toMessageSection(block, mediaContext)),
        );
        const textSections = sections.filter(
          (s): s is AgentNS.TextContentSection => s.type === "text",
        );
        const fullText = textSections.map((s) => s.text).join("\n");
        const chars = textSections.reduce((n, s) => n + s.text.length, 0);

        return await protectCallOutput({ sections, fullText, chars, isError }, env);
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
): CallbackTool {
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
        const mediaContext: MediaContext = { endpoint, model, signal: ctx?.signal };
        // 与 call_mcp_tool 同一套映射：文本归一为 text 块，媒体按端点能力上传或内联，
        // 不再把二进制资源（图片 / PDF）静默丢掉。
        const sections = await Promise.all(
          contents.map((content) => resourceToMessageSection(content, mediaContext)),
        );

        // 没有 contents 时退回原始 JSON（与 call_mcp_tool 同一兜底）
        if (sections.length === 0) {
          const json = JSON.stringify(result);
          return await protectCallOutput(
            { sections: [{ type: "text", text: json }], fullText: json, chars: json.length, isError: false },
            env,
          );
        }

        // 与 call_mcp_tool 共用同一套输出保护：文本超限落盘 result.txt，
        // 媒体块原位保留；未超限时纯文本退化为字符串、含媒体返回块数组。
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
