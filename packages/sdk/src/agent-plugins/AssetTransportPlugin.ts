import { AgentNS, type AgentPlugin, type InnerLoopContext } from "@ai-zen/agents-core";
import { fileToContentSection, resolveModelAndEndpoint } from "../shared/content-blocks.js";
import type { AppConfig, Endpoint, Model, ToolEnvDeps } from "../types/index.js";

/** 段上的本地标记：内容段里指回宿主素材行的 id（PRD 原文：`__asset_id` 只是本地标记） */
const ASSET_ID_KEY = "__asset_id";

export interface AssetTransportOptions {
  /** 取配置（端点与模型的能力位现读） */
  readonly config: () => AppConfig;
  /** 出网依赖（`upload` / `readAsset`） */
  readonly deps: ToolEnvDeps;
}

/**
 * 附件传输插件 —— 发出去之前把带 `__asset_id` 的段按**当前生效的模型与端点**重建成厂商要的形状。
 *
 * 内容在库里只有一份（落库那份就是原本那份，一个字都不清理：prompt caching 要的是前后两次请求
 * 的前缀逐字一致）；`__asset_id` 那一段只是「这是本地的哪一份素材」，出网的那一份每次现造：
 *
 * | 这一份素材 | 发出去的样子 |
 * |---|---|
 * | 端点声明了 `capabilities.filesApi` | `file` 段 + `file_id`（每次调用都真上传，不复用上一份 id） |
 * | 其余端点 + 图片 | `image_url` + base64 data URL |
 * | 模型看不见图（`vision !== true`） | 一段文本提示，并把 warning 单独说清 |
 * | 素材已不在 / 重建失败 / 上传失败 | 一段说得清的文本，**不重试** |
 *
 * ## 为什么落在 `onInnerLoopStart`，而不是 `formatContentSection`
 *
 * 后者是 core 拼请求体时用的格式化层，**同步**；而重建要读字节（宿主那边是一次文件读取）、
 * 还可能上传一次 —— 只能异步。`onInnerLoopStart` 恰恰是异步的，而且按 core 的注释它本来就
 * 允许改这一次要发出去的请求体（`ctx.body` 是「这一次请求」的唯一一份）。
 *
 * ## 为什么这里不拒（`onInnerLoopStart` 是能拒的钩子）
 *
 * 拒了等于整次请求不发。需求要的是「失败就报失败、不重试…绝不假成功，全失败就退回纯文本并说
 * 清楚」：一段发不出去就换成一句话说明，别的段与这条消息本身照发。所以这个插件**永远不返回判决**。
 *
 * ## 素材字节从哪来
 *
 * 只有 `deps.readAsset` 一个口：素材库是宿主的财产（行、字节、引用关系都在它那儿），SDK 只认
 * 这一个函数。没有注入它就等于「哪一份都取不到」—— 每一段都会退化成一句「已不在」，这比抛错
 * 好（请求照发），也比假装成功好。
 */
export class AssetTransportPlugin implements AgentPlugin {
  constructor(private readonly options: AssetTransportOptions) {}

  async onInnerLoopStart(ctx: InnerLoopContext): Promise<void> {
    const sent = ctx.body.messages;
    // 一条一条配上它在记忆里的那一份（`__asset_id` 只在那儿，见 `pairWithSources`）
    const sources = pairWithSources(sent, ctx.agent.messages);

    // 一句素材引用都没有：这一次请求体一个字都不动（连换一个段对象都不做）
    if (!sources.some((source) => hasAssetSection(source.content))) return;

    // 端点与模型**现读**：`file_id` 是端点维度资源，传错端点会得到 not found
    const { model, endpoint } = resolveModelAndEndpoint(this.options.config(), ctx.agent.model);

    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!;
      if (!Array.isArray(source.content)) continue;

      const target = sent[index];
      if (typeof target !== "object" || target === null) continue;
      const formatted = (target as { content?: unknown }).content;
      // 段数对不上就不动这一条（理由同 `pairWithSources`：宁可不换，不硬套）
      if (!Array.isArray(formatted) || formatted.length !== source.content.length) continue;

      const sections: unknown[] = [];
      let rebuilt = false;
      for (let at = 0; at < source.content.length; at += 1) {
        const local = source.content[at]!;
        const outgoing = formatted[at];
        const assetId = assetIdOf(local);
        // 位置对不上（出网那一段的类型与库里那一段不同）就不换这一处：发一段空的引用，
        // 也好过把别的段顶掉
        if (assetId === null || typeOf(outgoing) !== local.type) {
          sections.push(outgoing);
          continue;
        }
        rebuilt = true;
        sections.push(...(await this.transport(assetId, model, endpoint)));
      }

      if (rebuilt) (target as { content?: unknown }).content = sections;
    }
  }

  /**
   * 一段素材 → 这一次能发出去的那一段（可能的产物是两段：说清 warning 的那一句 + 文本提示）。
   *
   * 三种结局都不抛：这里抛出去会把整次请求打断，而需求要的是「全失败就退回纯文本并说清楚」。
   * 上传失败也一样 —— **不重试**（换一种传输方式偷偷再试一次，用户就不知道发出去的到底是
   * 哪一份了）。
   */
  private async transport(
    assetId: string,
    model: Model | undefined,
    endpoint: Endpoint | null | undefined,
  ): Promise<AgentNS.MessageContentSection[]> {
    const asset = this.options.deps.readAsset?.(assetId);
    if (asset === undefined) return [text(`附件 ${assetId} 已不在（可能被删了）`)];

    try {
      const result = await fileToContentSection({
        source: { data: asset.bytes, mime: asset.mime, filename: asset.name },
        endpoint,
        model,
        deps: this.options.deps,
      });

      // 退化成文本（模型看不见图）：把原因单独说清 —— 那一段文本本身只说「当前模型不支持图片
      // 输入」，用户还得知道「这张图因此没被发出去」这件事从哪来
      if (result.warning === undefined) return [result.section];
      return [text(`附件 ${asset.name ?? assetId}：${result.warning}`), result.section];
    } catch (error) {
      return [text(`附件 ${asset.name ?? assetId} 无法发送：${messageOf(error)}`)];
    }
  }
}

/**
 * 这一次要发出去的每一条消息，配上它在**记忆里**的那一份。
 *
 * 为什么要配：`ctx.body.messages` 是 core 的 `formatHistory()` 的产物 —— 它按字段白名单重建每
 * 一段，`__asset_id`（本机扩展键）在那一步就没了。也就是说请求体里**认不出**哪一段是素材引用，
 * 认得出的只有 `agent.messages` 里那一条（落库那份原样带着它）。
 *
 * 两份一对一：`formatHistory` 只筛消息（`status` 是完成了的、`omit` 没立起来的），既不重排消息
 * 也不重排段。所以按下标配就够。
 *
 * 条数对不上就返回空（这一次一条都不换，不猜）：那说明 core 那一侧的筛法变了，此时按位置硬套
 * 会把 A 消息的素材塞进 B 消息里 —— 发出去是一张别人的图，比「没重建」坏得多。
 */
function pairWithSources(
  sent: readonly unknown[],
  messages: readonly AgentNS.Message[],
): AgentNS.Message[] {
  // 这三个条件就是 core 的 `formatHistory` 那一条筛法（`Agent.formatHistory`）
  const sources = messages.filter(
    (message) =>
      (message.status === undefined || message.status === AgentNS.MessageStatus.Completed) &&
      !message.omit,
  );
  return sources.length === sent.length ? sources : [];
}

/** 这一段是不是一份素材引用 */
function hasAssetSection(content: AgentNS.MessageContent | undefined): boolean {
  return Array.isArray(content) && content.some((section) => assetIdOf(section) !== null);
}

function assetIdOf(section: AgentNS.MessageContentSection): string | null {
  const assetId = (section as unknown as Record<string, unknown>)[ASSET_ID_KEY];
  return typeof assetId === "string" ? assetId : null;
}

function typeOf(section: unknown): unknown {
  if (typeof section !== "object" || section === null) return undefined;
  return (section as { type?: unknown }).type;
}

function text(content: string): AgentNS.MessageContentSection {
  return { type: "text", text: content };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
