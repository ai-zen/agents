import { AgentNS } from "@ai-zen/agents-core";
import { describe, expect, it } from "vitest";

import {
  SESSION_ACTIVITIES,
  MAX_ASSETS_PER_MESSAGE,
  MAX_ASSET_BYTES,
  NOTICE_LEVELS,
  QUESTION_KINDS,
  QUESTION_STATES,
  localAssetIdOf,
  type AttachmentOutcome,
  type SessionActivity,
  type SessionPresence,
  type LocalMessageContentSection,
  type MessageInput,
} from "./states.js";

describe("会话此刻的四件事（PRD 4.4 / CORE「对外报四件事」）", () => {
  it("忙闲就是 core 那一格：两个值，名字不改（`busy` 只留作拒绝原因码）", () => {
    const coreStates: AgentNS.AgentState[] = ["working", "idle"];
    const outward: SessionActivity[] = [...coreStates];
    expect(outward).toEqual(["working", "idle"]);
    expect([...SESSION_ACTIVITIES]).toEqual(["working", "idle"]);

    // 一个方向都不多不少：core 报的那两格就是外面报的那两格（多一个或少一个，编译就红）
    type UnknownCoreState = Exclude<AgentNS.AgentState, SessionActivity>;
    const coreStatesAllKnown: UnknownCoreState extends never ? true : false = true;
    type UnknownOutwardState = Exclude<SessionActivity, AgentNS.AgentState>;
    const outwardAllKnown: UnknownOutwardState extends never ? true : false = true;
    expect(coreStatesAllKnown && outwardAllKnown).toBe(true);
  });

  it("四件事各占一格，不合成一格：闲 / 忙、输入闸、输出闸、死活", () => {
    // 「闲但输出闸关着」与「忙」是两个不同的读数 —— 这是四件事必须分开的由来
    const idleButNotTaking: SessionPresence = {
      status: "idle",
      inputPaused: false,
      outputPaused: true,
      alive: true,
    };
    const working: SessionPresence = {
      status: "working",
      inputPaused: false,
      outputPaused: false,
      alive: true,
    };
    const gone: SessionPresence = {
      status: "idle",
      inputPaused: false,
      outputPaused: false,
      alive: false,
    };

    expect(Object.keys(idleButNotTaking).sort()).toEqual([
      "alive",
      "inputPaused",
      "outputPaused",
      "status",
    ]);
    // 「闲着」与「输出闸关着」同时成立：一个是手上没活，一个是不取新活
    expect(idleButNotTaking.status).toBe("idle");
    expect(idleButNotTaking.outputPaused).toBe(true);
    expect(working.status).toBe("working");
    expect(working.outputPaused).toBe(false);
    // 死活不是忙闲里的一格：死了也可能「手上没活」，两者必须分得开
    expect(gone.alive).toBe(false);
    expect(gone.status).toBe("idle");
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
  it("wire 出口把 core 的类型与增量工具原样再导出", async () => {
    const wire = await import("./index.js");
    const core = await import("@ai-zen/agents-core");

    // 同一个对象/同一套枚举，而不是抄一份
    expect(wire.AgentNS).toBe(core.AgentNS);
    expect(wire.applyChunk).toBe(core.applyChunk);
    // 方法表、事件表、错误码也在同一个出口上
    expect(wire.METHOD_NAMES).toContain("message.list");
    expect(wire.EVENT_NAMES).toContain("message.delta");
    expect(wire.isBizCode("busy")).toBe(true);
  });
});

describe("通知四档（PRD 4.9 / F-I8）", () => {
  it("四档语气：信息 / 成功 / 警告 / 错误", () => {
    expect([...NOTICE_LEVELS]).toEqual(["info", "success", "warning", "error"]);
  });
});

describe("问题对象（PRD 4.10）", () => {
  it("种类与生命周期状态都齐（状态只有两格：没有过期 / 没有取消 / 没有关掉）", () => {
    expect([...QUESTION_KINDS]).toEqual(["handoff", "confirmation"]);
    expect([...QUESTION_STATES]).toEqual(["pending", "answered"]);
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
