import { CallbackTool } from "@ai-zen/agents-core";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { createDisclosureParam } from "../../disclosure.js";
import { DEFAULT_MAX_TOOL_OUTPUT, guardOutput, headTailPreview } from "../builtin/outputGuard.js";
import { getLogger } from "../../../shared/logger.js";
import type { McpConnectionManager } from "./McpConnectionManager.js";
import type { McpServerConfig, McpServerManifest, ToolEnv } from "../../../types/index.js";

const EMPTY_HINT = "（当前没有可用的 MCP 服务器，请联系用户添加）";
const log = getLogger();

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
  const param = createDisclosureParam(ids, "选择一个 MCP 服务器", EMPTY_HINT);

  // 拼接各 MCP 服务器的描述供 LLM 参考（对齐 load_skill 的处理方式）
  const mcpDescriptions = filteredMcps
    .map((s) => `  - ${s.id}: ${s.description || "无描述"}`)
    .join("\n");
  const serverIdDescription = `${param.description}\n\n各 MCP 服务器说明：\n${mcpDescriptions || "  无可用 MCP 服务器"}`;

  return new CallbackTool({
    function: {
      name: "load_mcp",
      description:
        "连接到指定 MCP 服务器，获取其可用工具和资源列表。可用 include_manifest=false 仅建立连接、不返回清单（适用于上文中已有该清单的场景）。",
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
              "是否返回该服务器的完整能力清单（工具与资源）。可选，默认 true。若你的上文中已存在该清单（例如本会话早前加载过，而进程重启后连接已失效），可设为 false 仅建立连接、只返回摘要，以节省上下文 token",
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
        return `❌ MCP 服务器 "${serverName}" 不存在`;
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
          return `无法连接到 "${serverName}": ${error?.message ?? error}`;
        }
      }

      // 静默模式：只回吐摘要（清单仍留在管理器内，供 call_mcp_tool 使用）
      if (!includeManifest) {
        log.info(
          `[load_mcp] ${serverName}: 已连接（未披露清单：工具 ${manifest.tools.length} 个，资源 ${manifest.resources.length} 个）`,
        );
        return JSON.stringify({
          server: serverName,
          connected: true,
          tools: manifest.tools.length,
          resources: manifest.resources.length,
        });
      }

      log.info(`[load_mcp] ${serverName}:\n${JSON.stringify(manifest, null, 2)}`);
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

/** base64 二进制转 data URL（image_url / file_data 均接受） */
function toDataUrl(base64: string, mimeType: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/**
 * MCP content 块 → SDK 内容块。
 *
 * 文本类（text / resource.text / resource_link / 未知类型）归一为 `text` 块，
 * 由调用方拼接成正文后进入输出保护；
 * 媒体类（image / audio / resource.blob）归一为 `image_url` / `file` 块，
 * 原样透传给模型——图片不进字符闸门，也不丢弃。
 */
function toMessageSection(block: any): AgentNS.MessageContentSection {
  switch (block?.type) {
    case "image":
      return {
        type: "image_url",
        image_url: { url: toDataUrl(block.data, block.mimeType ?? "image/png") },
      };

    case "audio":
      // AgentNS 无独立音频块，以 Files API 的 file_data（base64 data URL）内联承载
      return {
        type: "file",
        file_data: toDataUrl(block.data, block.mimeType ?? "audio/wav"),
      };

    case "resource": {
      const r = block.resource ?? {};
      // 内嵌文本资源：本质是纯文本，并入正文（同样受输出保护）
      if (typeof r.text === "string") return { type: "text", text: r.text };
      // 内嵌二进制资源：按 mimeType 选块类型，不丢弃
      if (typeof r.blob === "string") {
        const mime = r.mimeType ?? "application/octet-stream";
        return mime.startsWith("image/")
          ? { type: "image_url", image_url: { url: toDataUrl(r.blob, mime) } }
          : { type: "file", file_data: toDataUrl(r.blob, mime) };
      }
      return { type: "text", text: `[资源] ${r.uri ?? "(未知 URI)"}` };
    }

    case "resource_link": {
      const parts = [block.name, block.uri, block.mimeType].filter(Boolean);
      return { type: "text", text: `[资源链接] ${parts.join(" · ")}` };
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
          `文本输出过大：共 ${chars} 字符，超过上限 ${limit} 字符。` +
          `完整文本已落盘（result.txt），可用 read 分批读取。`,
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
  if (!hasMedia) return isError ? `❌ 工具执行出错:\n${fullText}` : fullText;
  return isError
    ? [{ type: "text", text: "❌ 工具执行出错:" }, ...sections]
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
        "调用已连接 MCP 服务器上的指定工具。需先通过 load_mcp 连接服务器。文本输出过大时会落盘并只返回头尾预览；图片、音频等媒体原样返回。",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP 服务器名称" },
          tool: { type: "string", description: "工具名称" },
          arguments: { type: "object", description: "工具参数" },
        },
        required: ["server", "tool", "arguments"],
        additionalProperties: false,
      },
    },
    callback: async (input, ctx): Promise<AgentNS.MessageContent> => {
      const serverName = input.server as string;
      const state = mcpManager.getState(serverName);
      if (state !== "connected") {
        return `请先使用 load_mcp 连接 "${serverName}"`;
      }

      const client = mcpManager.getClient(serverName);
      if (!client) {
        return `MCP 服务器 "${serverName}" 的客户端不可用`;
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

        const sections = contents.map(toMessageSection);
        const textSections = sections.filter(
          (s): s is AgentNS.TextContentSection => s.type === "text",
        );
        const fullText = textSections.map((s) => s.text).join("\n");
        const chars = textSections.reduce((n, s) => n + s.text.length, 0);

        return await protectCallOutput({ sections, fullText, chars, isError }, env);
      } catch (error: any) {
        return `❌ 调用 "${input.tool}" 失败: ${error?.message ?? error}`;
      }
    },
  });
}

/**
 * 创建 read_mcp_resource 工具。
 */
export function createReadMcpResourceTool(mcpManager: McpConnectionManager): CallbackTool {
  return new CallbackTool({
    function: {
      name: "read_mcp_resource",
      description: "读取已连接 MCP 服务器上的指定资源（文档、数据等）。",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP 服务器名称" },
          uri: { type: "string", description: "资源 URI" },
        },
        required: ["server", "uri"],
        additionalProperties: false,
      },
    },
    callback: async (input, ctx): Promise<string> => {
      const serverName = input.server as string;
      const state = mcpManager.getState(serverName);
      if (state !== "connected") {
        return `请先使用 load_mcp 连接 "${serverName}"`;
      }

      const client = mcpManager.getClient(serverName);
      if (!client) {
        return `MCP 服务器 "${serverName}" 的客户端不可用`;
      }

      try {
        mcpManager.touch(serverName);
        const result = await client.readResource(
          { uri: input.uri as string },
          { signal: ctx?.signal },
        );

        const contents = result?.contents ?? [];
        const textParts = contents
          .filter((c: any) => c.text)
          .map((c: any) => c.text);
        return textParts.join("\n") || JSON.stringify(result);
      } catch (error: any) {
        return `❌ 读取资源 "${input.uri}" 失败: ${error?.message ?? error}`;
      }
    },
  });
}
