import { addUsage, AgentNS, sumUsage, ZERO_USAGE } from "@ai-zen/agents-core";
import { describe, expect, it } from "vitest";

import {
  GENERATION_PHASES,
  MAX_ASSETS_PER_MESSAGE,
  MAX_ASSET_BYTES,
  STATUS_BLOCK_IDS,
  NOTICE_LEVELS,
  QUESTION_KINDS,
  QUESTION_STATES,
  zeroUsage,
  type AssemblingToolCall,
  type AttachmentOutcome,
  type ContextState,
  type GenerationState,
  type MessageInput,
  type RunningTool,
  type StatusBlock,
  type UsageSnapshot,
} from "./states.js";

const NOW = "2026-01-01T00:00:00.000Z";

describe("生成六态（PRD L8 / F-I3）", () => {
  it("就是 L8 的那六个说法，一个不少", () => {
    expect([...GENERATION_PHASES]).toEqual([
      "connected",
      "awaiting_first_token",
      "thinking",
      "generating",
      "assembling_tool_calls",
      "awaiting_tools",
    ]);
  });

  it("每一态带自己那份事实（判别式联合在编译期就挡住缺字段）", () => {
    // 工具调用用 core 的形状：id / index / function.name / function.arguments
    const assembling: AssemblingToolCall = {
      toolCall: { index: 0, id: "t1", type: "function", function: { name: "read", arguments: '{"pa' } },
      argumentsChars: 4,
    };
    const running: RunningTool = {
      toolCall: { index: 0, id: "t1", type: "function", function: { name: "read", arguments: "{}" } },
      startedAt: NOW,
    };

    const states: GenerationState[] = [
      { phase: "connected", since: NOW },
      { phase: "awaiting_first_token", since: NOW },
      { phase: "thinking", since: NOW, chars: 12 },
      { phase: "generating", since: NOW, chars: 130 },
      { phase: "assembling_tool_calls", since: NOW, toolCalls: [assembling] },
      {
        phase: "awaiting_tools",
        since: NOW,
        runningTools: [
          running,
          { ...running, toolCall: { ...running.toolCall, id: "t2", function: { name: "grep" } } },
        ],
      },
    ];

    // 六态都能被同一个函数处理，且不丢态
    for (const state of states) {
      expect(GENERATION_PHASES).toContain(state.phase);
    }
    // 并行工具只列还在跑的那几个：两把同时在跑就两条
    const awaiting = states[5];
    expect(awaiting.phase === "awaiting_tools" && awaiting.runningTools.length).toBe(2);
    // 工具名与 id 都在 core 的字段上，没有第二份
    expect(assembling.toolCall.function?.name).toBe("read");
    expect(running.toolCall.id).toBe("t1");
  });

  it("thinking 与 generating 分开，是两态而不是一个「输出中」", () => {
    expect(GENERATION_PHASES).toContain("thinking");
    expect(GENERATION_PHASES).toContain("generating");
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

describe("契约出口（客户端只 import 服务端包就够）", () => {
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
    expect([...QUESTION_KINDS]).toEqual(["handoff", "workspace_registration", "confirmation"]);
    expect([...QUESTION_STATES]).toEqual(["pending", "answered", "expired", "cancelled"]);
  });
});

describe("用量（PRD F-I5）", () => {
  it("三个口径里装的是 core 的 Usage，字段名照 core", () => {
    const usage = zeroUsage(NOW);
    expect(Object.keys(usage)).toEqual(
      expect.arrayContaining(["turn", "total", "subAgent", "rate", "updatedAt"]),
    );
    expect(usage.rate).toEqual({ value: 0, unit: "tokens_per_second", basis: "completion" });
    expect(usage.turn).toEqual(ZERO_USAGE);
    expect(Object.keys(usage.total)).toEqual(["prompt_tokens", "completion_tokens", "total_tokens"]);
  });

  it("聚合口径只是外壳：求和用 core 的 addUsage / sumUsage", () => {
    const turn: AgentNS.Usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const subAgent: AgentNS.Usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    const usage: UsageSnapshot = {
      ...zeroUsage(NOW),
      turn,
      subAgent,
      total: addUsage(turn, subAgent),
    };

    expect(usage.total.total_tokens).toBe(135);
    expect(usage.total.total_tokens).toBe(usage.turn.total_tokens + usage.subAgent.total_tokens);

    // 一条 assistant 消息 + 一条带子 Agent 用量的 tool 消息，sumUsage 把两者都算进去
    const messages: AgentNS.Message[] = [
      { id: "m-1", role: AgentNS.Role.Assistant, usage: turn },
      { id: "m-2", role: AgentNS.Role.Tool, subAgentUsage: subAgent },
    ];
    expect(sumUsage(messages)).toEqual(usage.total);
  });

  it("zeroUsage 每次给新对象（调用方改不坏共享的零值）", () => {
    const a = zeroUsage(NOW);
    a.turn.prompt_tokens = 7;
    expect(zeroUsage(NOW).turn.prompt_tokens).toBe(0);
    expect(ZERO_USAGE.prompt_tokens).toBe(0);
  });
});

describe("上下文阈值（PRD F-D1 / D27）", () => {
  it("阈值是两条线的绝对值，占用看 core Usage 的 prompt_tokens", () => {
    const context: ContextState = {
      usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 },
      handoffThreshold: 800,
      guardThreshold: 1000,
      overHandoff: true,
      overGuard: false,
    };
    expect(context.usage.prompt_tokens).toBeGreaterThan(context.handoffThreshold);
    expect(context.usage.prompt_tokens).toBeLessThan(context.guardThreshold);
  });
});

describe("状态栏块（PRD F-I6）", () => {
  it("块名固定，块内事实按块名不同", () => {
    expect([...STATUS_BLOCK_IDS]).toEqual([
      "agent",
      "model",
      "thinking",
      "context",
      "usage",
      "cwd",
      "tools",
      "subagents",
    ]);

    const label = { code: "label.cwd", messageKey: "label.cwd", params: {}, message: "Folder" } as const;
    const cwdBlock: StatusBlock = { id: "cwd", label, facts: { cwd: "/tmp/x", exists: false } };
    const toolsBlock: StatusBlock = { id: "tools", label, facts: { running: [] } };

    // 判别式联合：按 id 收窄后拿到的就是对应块的事实
    expect(cwdBlock.id === "cwd" && cwdBlock.facts.exists).toBe(false);
    expect(toolsBlock.id === "tools" && toolsBlock.facts.running.length).toBe(0);
  });
});

describe("上限（PRD D5）", () => {
  it("图片 20MB/张、4 张/条", () => {
    expect(MAX_ASSET_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_ASSETS_PER_MESSAGE).toBe(4);
  });
});
