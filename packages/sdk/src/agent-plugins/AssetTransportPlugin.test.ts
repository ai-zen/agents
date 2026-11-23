/**
 * 四条验收：
 *
 * 1. 带 `__asset_id` 的段被换成**这一次**该发的那一份 —— 端点声明了 Files API 就是 `file_id`，
 *    没有就是 `image_url` + data URL；
 * 2. 模型看不见图时退化成文本，并把 warning 说清；
 * 3. 取不到字节 / 重建抛错时换成一段说得清的文本，上传**只调用一次**（不重试）；
 * 4. 没有 `__asset_id` 的内容一个字都不动。
 *
 * 请求体不用手搓：用真的 `Agent` 造一条消息、拿它自己的 `formatHistory()` 当 `ctx.body.messages`
 * —— 这正是运行时那一侧的形状（`formatHistory` 会把 `__asset_id` 剥掉，插件必须靠记忆里那一份
 * 才认得出哪一段是 Asset 引用，这一层不能靠用例自己伪造）。
 */

import { Agent, AgentNS, Message } from "@ai-zen/agents-core";
import type { InnerLoopContext } from "@ai-zen/agents-core";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig, EndpointDefinition, ToolEnvDeps } from "../types/index.js";
import { AssetTransportPlugin } from "./AssetTransportPlugin.js";

const MIME = "image/png";

function configWith(patch: { filesApi?: boolean; vision?: boolean } = {}): AppConfig {
  const endpoint: EndpointDefinition = {
    id: "e-1",
    name: "端点一",
    baseUrl: "https://api.example.com/v1",
    apiKey: "key-1",
    ...(patch.filesApi === undefined ? {} : { capabilities: { filesApi: patch.filesApi } }),
  };

  return {
    endpoints: [endpoint],
    models: [
      {
        id: "m-1",
        name: "模型一",
        endpointId: "e-1",
        tokenThresholds: { handoff: 100, guard: 200 },
        vision: patch.vision ?? true,
      },
    ],
  };
}

/** 一段 Asset 引用：出网的那一份里没有 `__asset_id`（core 的白名单会剥掉），所以它只活在记忆里 */
function assetSection(assetId: string): AgentNS.MessageContentSection {
  return { type: "image_url", image_url: { url: "" }, __asset_id: assetId } as never;
}

/**
 * 造一次「要发出去的请求」：消息进记忆，请求体是 `formatHistory()` 的产物 —— 与 core 在
 * `onInnerLoopStart` 那一刻给插件的东西同形。
 */
function buildCtx(content: AgentNS.MessageContent): InnerLoopContext {
  const agent = new Agent({
    client: {} as never,
    model: "m-1",
    messages: [
      new Message({
        id: "m-1",
        role: AgentNS.Role.User,
        status: AgentNS.MessageStatus.Completed,
        content,
      }),
    ],
  });

  return { agent, body: { messages: agent.formatHistory() } } as unknown as InnerLoopContext;
}

/** 出网那一条消息的内容段（用例里读它断言） */
function sentSections(ctx: InnerLoopContext): AgentNS.MessageContentSection[] {
  const message = (ctx.body.messages as Array<{ content?: unknown }>)[0];
  return message?.content as AgentNS.MessageContentSection[];
}

function readAssetOf(bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])): ToolEnvDeps["readAsset"] {
  return (assetId) => ({ bytes, mime: MIME, name: `图-${assetId}.png` });
}

describe("AssetTransportPlugin", () => {
  it("端点声明了 Files API：换出来的是 `file` 段 + `file_id`", async () => {
    const ctx = buildCtx([{ type: "text", text: "看图" }, assetSection("a-1")]);
    const upload = vi.fn(async () => "file-1");

    await new AssetTransportPlugin({
      config: () => configWith({ filesApi: true }),
      deps: { upload, readAsset: readAssetOf() },
    }).onInnerLoopStart!(ctx);

    expect(sentSections(ctx)[1]).toEqual({ type: "file", file_id: "file-1" });
    expect(upload).toHaveBeenCalledTimes(1);
    // 不是 Asset 的那一段原样留着（同一个引用，没被重建一遍）
    expect(sentSections(ctx)[0]).toEqual({ type: "text", text: "看图" });
  });

  it("端点没声明 Files API：换出来的是 `image_url`，url 是 data URL", async () => {
    const ctx = buildCtx([{ type: "text", text: "看图" }, assetSection("a-1")]);

    await new AssetTransportPlugin({
      config: () => configWith(),
      deps: { readAsset: readAssetOf() },
    }).onInnerLoopStart!(ctx);

    const section = sentSections(ctx)[1] as { type: string; image_url: { url: string } };
    expect(section.type).toBe("image_url");
    expect(section.image_url.url.startsWith("data:")).toBe(true);
    // 本地标记不出网
    expect("__asset_id" in section).toBe(false);
  });

  it("模型看不见图：那一段退化成文本，正文里把 warning 说清", async () => {
    const ctx = buildCtx([assetSection("a-1")]);

    await new AssetTransportPlugin({
      config: () => configWith({ vision: false }),
      deps: { readAsset: readAssetOf() },
    }).onInnerLoopStart!(ctx);

    const sections = sentSections(ctx);
    expect(sections.every((section) => section.type === "text")).toBe(true);
    const text = sections.map((section) => (section as { text?: string }).text ?? "").join("\n");
    expect(text).toContain("The current model does not support image input");
    // 说的是哪一份 Asset 也得在
    expect(text).toContain("图-a-1.png");
  });

  it("取不到字节：换成一段带 id 的文本，不抛、不重试", async () => {
    const ctx = buildCtx([assetSection("a-9")]);
    const readAsset = vi.fn(() => undefined);

    await new AssetTransportPlugin({
      config: () => configWith(),
      deps: { readAsset },
    }).onInnerLoopStart!(ctx);

    const section = sentSections(ctx)[0] as { type: string; text: string };
    expect(section.type).toBe("text");
    expect(section.text).toContain("a-9");
    expect(readAsset).toHaveBeenCalledTimes(1);
  });

  it("上传抛错：换成一段带错误消息的文本，且只上传了一次（不重试）", async () => {
    const ctx = buildCtx([assetSection("a-1")]);
    const upload = vi.fn(async () => {
      throw new Error("HTTP 500");
    });

    await new AssetTransportPlugin({
      config: () => configWith({ filesApi: true }),
      deps: { upload, readAsset: readAssetOf() },
    }).onInnerLoopStart!(ctx);

    const section = sentSections(ctx)[0] as { type: string; text: string };
    expect(section.type).toBe("text");
    expect(section.text).toContain("HTTP 500");
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("没有 `__asset_id` 的内容一个字都不动", async () => {
    const ctx = buildCtx("就一句普通的话");

    expect(
      await new AssetTransportPlugin({
        config: () => configWith(),
        deps: { readAsset: vi.fn(() => undefined) },
      }).onInnerLoopStart!(ctx),
    ).toBeUndefined();

    // 同一个数组、同一句话：没有被重建成新的一份
    expect((ctx.body.messages as Array<{ content?: unknown }>)[0]!.content).toBe("就一句普通的话");
  });
});
