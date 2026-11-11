import { describe, expect, it } from "vitest";

import {
  GENERATION_PHASES,
  MAX_ASSETS_PER_MESSAGE,
  MAX_ASSET_BYTES,
  MESSAGE_STATUSES,
  SEGMENT_KINDS,
  STATUS_BLOCK_IDS,
  NOTICE_LEVELS,
  QUESTION_KINDS,
  QUESTION_STATES,
  addTokenCounts,
  zeroTokenCounts,
  zeroUsage,
  type GenerationState,
  type MessageSegment,
  type StatusBlock,
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
    const states: GenerationState[] = [
      { phase: "connected", since: NOW },
      { phase: "awaiting_first_token", since: NOW },
      { phase: "thinking", since: NOW, chars: 12 },
      { phase: "generating", since: NOW, chars: 130 },
      {
        phase: "assembling_tool_calls",
        since: NOW,
        toolCalls: [{ toolCallId: "t1", name: "read", argumentsChars: 8 }],
      },
      {
        phase: "awaiting_tools",
        since: NOW,
        runningTools: [
          { toolCallId: "t1", name: "read", startedAt: NOW },
          { toolCallId: "t2", name: "grep", startedAt: NOW },
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
  });

  it("thinking 与 generating 分开，是两态而不是一个「输出中」", () => {
    expect(GENERATION_PHASES).toContain("thinking");
    expect(GENERATION_PHASES).toContain("generating");
  });
});

describe("消息状态与段（PRD F-I1 / F-I2）", () => {
  it("四态齐全", () => {
    expect([...MESSAGE_STATUSES]).toEqual(["streaming", "done", "aborted", "error"]);
  });

  it("段的种类只有三种：思考 / 工具调用 / 正文", () => {
    expect([...SEGMENT_KINDS]).toEqual(["thinking", "tool_call", "text"]);
  });

  it("一条消息的段按 思考 → 工具调用 → 正文 排（PRD F-I2）", () => {
    const segments: MessageSegment[] = [
      { kind: "thinking", text: "先看文件" },
      {
        kind: "tool_call",
        toolCallId: "t1",
        name: "read",
        argumentsText: '{"path":"a.ts"}',
        status: "done",
        resultText: "…",
        startedAt: NOW,
        finishedAt: NOW,
        problem: null,
        subagent: null,
      },
      { kind: "text", text: "看完了" },
    ];
    expect(segments.map((segment) => segment.kind)).toEqual(["thinking", "tool_call", "text"]);
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
  it("三个数字分开给：本轮 / 累计 / 速率", () => {
    const usage = zeroUsage(NOW);
    expect(Object.keys(usage)).toEqual(
      expect.arrayContaining(["turn", "total", "subAgent", "rate", "updatedAt"]),
    );
    expect(usage.rate).toEqual({ value: 0, unit: "tokens_per_second", basis: "completion" });
  });

  it("累计含子 Agent：subAgent 单独再给一份便于对账", () => {
    const usage = {
      ...zeroUsage(NOW),
      turn: { prompt: 10, completion: 5, total: 15 },
      subAgent: { prompt: 100, completion: 20, total: 120 },
      total: addTokenCounts({ prompt: 10, completion: 5, total: 15 }, { prompt: 100, completion: 20, total: 120 }),
    };
    expect(usage.total.total).toBe(135);
    expect(usage.total.total).toBe(usage.turn.total + usage.subAgent.total);
  });

  it("zeroTokenCounts 与 addTokenCounts 是纯函数", () => {
    const a = zeroTokenCounts();
    const b = { prompt: 1, completion: 2, total: 3 };
    expect(addTokenCounts(a, b)).toEqual(b);
    expect(a).toEqual({ prompt: 0, completion: 0, total: 0 });
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
