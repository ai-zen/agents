import { AgentNS } from "@ai-zen/agents-core";
import { describe, expect, it } from "vitest";

import { statusOfState } from "../runtime/ChatRunner.js";
import {
  MAX_ASSETS_PER_MESSAGE,
  MAX_ASSET_BYTES,
  NOTICE_LEVELS,
  QUESTION_KINDS,
  QUESTION_STATES,
  localAssetIdOf,
  type AttachmentOutcome,
  type ConversationStatus,
  type LocalMessageContentSection,
  type MessageInput,
} from "./states.js";

describe("对话此刻的四格（PRD 4.4 / PLAN §10.1）", () => {
  it("core 报两格（working / 闲），加一格「不收件」与一格「死」：对外恰好四个值，不多不少", () => {
    // 前两格照 core 的 `AgentState`（`working` / `idle` = 循环的位置），宿主把它们翻成对外的两个
    // 名字（`statusOfState`）；后两格是宿主自己那两件事：「不收件」= `agent.isOutputPaused`，
    // 「死」= 宿主那边连 agent 对象都没有
    const agentStates: AgentNS.AgentState[] = ["working", "idle"];
    const all: ConversationStatus[] = [...agentStates.map(statusOfState), "paused", "dead"];
    expect(all).toEqual(["busy", "idle", "paused", "dead"]);

    // 两个方向都不多不少：core 的两格翻过来全在这一格里，而减掉它们只剩宿主那两件事
    // （任一方向多了或少了值，下面两行就不再是 `true`，编译就红）
    type OutwardFromCore = ReturnType<typeof statusOfState>;
    type UnknownCoreState = Exclude<OutwardFromCore, ConversationStatus>;
    const coreStatesAllKnown: UnknownCoreState extends never ? true : false = true;
    type HostOnlyState = Exclude<ConversationStatus, OutwardFromCore>;
    const hostOnlyStates: HostOnlyState extends "paused" | "dead" ? true : false = true;
    expect(coreStatesAllKnown && hostOnlyStates).toBe(true);
  });
});

describe("消息相关概念用的是 core 的类型（R21 纠偏）", () => {
  it("消息状态用 core 的 MessageStatus，不再是自造的四态", () => {
    expect(Object.values(AgentNS.MessageStatus)).toEqual([
      "unknown",
      "pending",
      "completed",
      "error",
      "aborted",
      "writing",
    ]);
    const status: AgentNS.MessageStatus = AgentNS.MessageStatus.Writing;
    expect(status).toBe("writing");
  });

  it("角色与结束原因也是 core 的枚举", () => {
    expect(Object.values(AgentNS.Role)).toEqual([
      "unknown",
      "system",
      "user",
      "assistant",
      "function",
      "tool",
    ]);
    expect(Object.values(AgentNS.FinishReason)).toContain("tool_calls");
  });

  it("消息本体的字段全部来自 core（内容 / 思考 / 工具调用 / 用量 / 标记）", () => {
    const message: AgentNS.Message = {
      id: "m-1",
      role: AgentNS.Role.Assistant,
      status: AgentNS.MessageStatus.Completed,
      finish_reason: AgentNS.FinishReason.Stop,
      content: [
        { index: 0, type: "text", text: "看完了" },
        { index: 1, type: "image_url", image_url: { url: "https://example.test/a.png" } },
        { index: 2, type: "file", file_id: "file-1" },
      ],
      reasoning_content: "先看文件",
      tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "read", arguments: "{}" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      omit: false,
      hidden: false,
    };

    expect(message.role).toBe("assistant");
    expect(Array.isArray(message.content) && message.content[2].type).toBe("file");
    // 内容段类型就是 core 的那三种
    const section: AgentNS.MessageContentSection = { type: "text", text: "hi" };
    expect(section.type).toBe("text");
  });

  it("用户输入用 core 的内容形状，素材只按 id 引用", () => {
    const textOnly: MessageInput = { content: "看一眼这张图" };
    const withAssets: MessageInput = {
      content: [
        { type: "text", text: "这两张" },
        { type: "image_url", image_url: { url: "https://example.test/b.png" } },
      ],
      assetIds: ["a-1", "a-2"],
    };

    expect(typeof textOnly.content).toBe("string");
    expect(withAssets.assetIds).toEqual(["a-1", "a-2"]);
    // 内容段就是 core 的联合类型，没有自造的 part
    const first = Array.isArray(withAssets.content) ? withAssets.content[1] : null;
    expect(first?.type).toBe("image_url");
  });

  it("附件结局引用的内容块是 core 的类型", () => {
    const inline: AttachmentOutcome = {
      assetId: "a-1",
      deliveredAs: "inline",
      section: { type: "image_url", image_url: { url: "https://example.test/c.png" } },
      problem: null,
    };
    const fallback: AttachmentOutcome = {
      assetId: "a-2",
      deliveredAs: "text_fallback",
      section: { type: "text", text: "[图片：a.png]" },
      problem: null,
    };
    const dropped: AttachmentOutcome = {
      assetId: "a-3",
      deliveredAs: "dropped",
      section: null,
      problem: null,
    };

    expect(inline.section?.type).toBe("image_url");
    expect(fallback.section?.type).toBe("text");
    expect(dropped.section).toBeNull();
  });
});

describe("契约出口（客户端只 import 宿主包就够）", () => {
  it("wire 出口把 core 的类型与用量工具原样再导出", async () => {
    const wire = await import("./index.js");
    const core = await import("@ai-zen/agents-core");

    // 同一个对象/同一套枚举，而不是抄一份
    expect(wire.AgentNS).toBe(core.AgentNS);
    expect(wire.sumUsage).toBe(core.sumUsage);
    expect(wire.addUsage).toBe(core.addUsage);
    expect(wire.ZERO_USAGE).toBe(core.ZERO_USAGE);
    expect(wire.applyChunk).toBe(core.applyChunk);
    // 方法表、事件表、错误码也在同一个出口上
    expect(wire.METHOD_NAMES).toContain("message.list");
    expect(wire.EVENT_NAMES).toContain("message.delta");
    expect(wire.isBizCode("busy")).toBe(true);
  });
});

describe("通知三档（PRD L3 / F-I8）", () => {
  it("三档语气", () => {
    expect([...NOTICE_LEVELS]).toEqual(["info", "warning", "error"]);
  });
});

describe("问题对象（PRD D22）", () => {
  it("种类与生命周期状态都齐", () => {
    expect([...QUESTION_KINDS]).toEqual(["handoff", "confirmation"]);
    expect([...QUESTION_STATES]).toEqual(["pending", "answered", "expired", "cancelled"]);
  });
});

describe("上限（PRD D5）", () => {
  it("图片 20MB/张、4 张/条", () => {
    expect(MAX_ASSET_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_ASSETS_PER_MESSAGE).toBe(4);
  });
});

describe("本地扩展字段（`__asset_id`）", () => {
  it("localAssetIdOf 只看有没有这个字段，不解析任何 scheme", () => {
    const withAsset = (assetId: string): LocalMessageContentSection => ({
      type: "image_url",
      image_url: { url: "" },
      __asset_id: assetId,
    });
    expect(localAssetIdOf(withAsset("a1"))).toBe("a1");
    const fileWithAsset: LocalMessageContentSection = {
      type: "file",
      filename: "a.pdf",
      __asset_id: "a2",
    };
    expect(localAssetIdOf(fileWithAsset)).toBe("a2");
    // 没有扩展字段就是「不引用素材」—— 哪怕 url 长得像我们自己的 scheme
    expect(localAssetIdOf({ type: "image_url", image_url: { url: "asset://a1" } })).toBeNull();
    expect(localAssetIdOf({ type: "file", file_id: "asset://a2" })).toBeNull();
    // 空串 / 空白算没写
    expect(localAssetIdOf(withAsset("  "))).toBeNull();
  });
});
