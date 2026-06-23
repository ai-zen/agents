import { describe, it, expect } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { calcTotalChars, shouldMigrate } from "./task-migration-agent.js";

// ==================== 测试用消息工厂 ====================

function makeTextMsg(
  role: AgentNS.Role,
  text: string,
  extra?: Partial<AgentNS.Message>,
): AgentNS.Message {
  return {
    role,
    content: text,
    ...extra,
  };
}

function makeArrayContentMsg(
  role: AgentNS.Role,
  texts: string[],
  extra?: Partial<AgentNS.Message>,
): AgentNS.Message {
  return {
    role,
    content: texts.map((t) => ({ type: "text" as const, text: t })),
    ...extra,
  };
}

function makeToolCallMsg(
  role: AgentNS.Role,
  toolCalls: { name: string; args: string }[],
  extra?: Partial<AgentNS.Message>,
): AgentNS.Message {
  return {
    role,
    content: "",
    tool_calls: toolCalls.map((tc, i) => ({
      index: i,
      id: `call_${i}`,
      type: "function",
      function: { name: tc.name, arguments: tc.args },
    })),
    ...extra,
  };
}

function makeFunctionCallMsg(
  role: AgentNS.Role,
  name: string,
  args: string,
  extra?: Partial<AgentNS.Message>,
): AgentNS.Message {
  return {
    role,
    content: "",
    function_call: { name, arguments: args },
    ...extra,
  };
}

// ==================== calcTotalChars ====================

describe("calcTotalChars", () => {
  it("计算消息列表的总字符数（JSON 序列化）", () => {
    const msgs = [
      makeTextMsg(AgentNS.Role.User, "你好"),
      makeTextMsg(AgentNS.Role.Assistant, "你好！有什么可以帮你的吗？"),
    ];
    // JSON.stringify 后包含 role、content 等字段的完整序列化长度
    const expected = JSON.stringify(msgs).length;
    expect(calcTotalChars(msgs)).toBe(expected);
  });

  it("计算空消息列表，序列化后长度为 2（[]）", () => {
    expect(calcTotalChars([])).toBe(2);
  });

  it("包含 tool_calls 的消息序列化后算总长度", () => {
    const msgs = [
      makeToolCallMsg(AgentNS.Role.Assistant, [
        { name: "readFile", args: '{"path":"src/index.ts"}' },
      ]),
    ];
    const expected = JSON.stringify(msgs).length;
    expect(calcTotalChars(msgs)).toBe(expected);
  });

  it("包含 function_call 的消息序列化后算总长度", () => {
    const msgs = [
      makeFunctionCallMsg(AgentNS.Role.Assistant, "writeFile", '{"path":"a.txt","content":"hi"}'),
    ];
    const expected = JSON.stringify(msgs).length;
    expect(calcTotalChars(msgs)).toBe(expected);
  });

  it("混合多种类型的消息序列化后算总长度", () => {
    const msgs = [
      makeTextMsg(AgentNS.Role.System, "你是一个助手。"),
      makeTextMsg(AgentNS.Role.User, "帮我写代码"),
      makeArrayContentMsg(AgentNS.Role.Assistant, ["好的，", "这是代码"]),
      makeToolCallMsg(AgentNS.Role.Assistant, [
        { name: "writeFile", args: '{"path":"test.ts","content":"..."}' },
      ]),
    ];
    const expected = JSON.stringify(msgs).length;
    expect(calcTotalChars(msgs)).toBe(expected);
  });

  it("含 image_url 内容段的序列化后算总长度", () => {
    const msgs: AgentNS.Message[] = [
      {
        role: AgentNS.Role.Assistant,
        content: [
          { type: "text" as const, text: "这是图片：" },
          { type: "image_url" as const, image_url: { url: "https://example.com/img.png" } },
          { type: "text" as const, text: "描述完毕" },
        ],
      },
    ];
    const expected = JSON.stringify(msgs).length;
    expect(calcTotalChars(msgs)).toBe(expected);
  });

  it("content 为 undefined 的消息序列化后算总长度", () => {
    const msgs: AgentNS.Message[] = [
      { role: AgentNS.Role.Assistant },
    ];
    const expected = JSON.stringify(msgs).length;
    expect(calcTotalChars(msgs)).toBe(expected);
  });
});

// ==================== shouldMigrate ====================

describe("shouldMigrate", () => {
  /**
   * 生成指定条数的消息列表。
   * 每条消息 content 长度为 fixedMsgLen。
   * 由于 JSON.stringify 后实际长度会包含字段名等，用 calcTotalChars 实际计算。
   */
  function makeMsgs(count: number): AgentNS.Message[] {
    return Array.from({ length: count }, (_, i) =>
      makeTextMsg(AgentNS.Role.User, "x".repeat(10)),
    );
  }

  it("消息序列化长度超过 2/3 阈值时返回 true", () => {
    // maxContextChars = 5000
    // 300 条消息，序列化后远超 2/3 阈值 (3333)
    const msgs = makeMsgs(300);
    expect(shouldMigrate(msgs, 5000)).toBe(true);
  });

  it("消息序列化长度远小于阈值时返回 false", () => {
    // 1 条消息，序列化后很小
    const msgs = makeMsgs(1);
    expect(shouldMigrate(msgs, 50000)).toBe(false);
  });

  it("maxContextChars 未定义时返回 false", () => {
    const msgs = makeMsgs(100);
    expect(shouldMigrate(msgs, undefined)).toBe(false);
  });

  it("maxContextChars 为 0 时返回 false", () => {
    const msgs = makeMsgs(100);
    expect(shouldMigrate(msgs, 0)).toBe(false);
  });

  it("maxContextChars 为负数时返回 false", () => {
    const msgs = makeMsgs(10);
    expect(shouldMigrate(msgs, -100)).toBe(false);
  });

  it("空消息列表时返回 false", () => {
    expect(shouldMigrate([], 100000)).toBe(false);
  });

  it("边界值：序列化后刚好等于 2/3 阈值时返回 true", () => {
    // 构造一个已知总长度的消息列表
    const msgs = [
      makeTextMsg(AgentNS.Role.User, "测试消息"),
    ];
    const totalChars = calcTotalChars(msgs);
    // 设置 maxContextChars 使 2/3 阈值刚好等于 totalChars
    // totalChars = 2/3 * max -> max = totalChars * 3 / 2
    const maxContextChars = Math.ceil(totalChars * 3 / 2);
    expect(shouldMigrate(msgs, maxContextChars)).toBe(true);
  });

  it("边界值：序列化后刚好不到 2/3 阈值时返回 false", () => {
    const msgs = [
      makeTextMsg(AgentNS.Role.User, "测试消息"),
    ];
    const totalChars = calcTotalChars(msgs);
    // maxContextChars 设为 totalChars * 2，这样 2/3 阈值 = totalChars * 4/3 > totalChars
    const maxContextChars = totalChars * 2;
    expect(shouldMigrate(msgs, maxContextChars)).toBe(false);
  });
});

// ==================== 集成测试（会调用真实 API，默认跳过） ====================

describe.skip("generateMigrationDoc 集成测试", () => {
  it("需要配置 API Key 才能运行", () => {
    // 手动测试方式：
    // 1. 确保 ~/.ai-zen/config.json 中配置了有效的 API Key 和默认模型
    // 2. 修改 test.skip 为 test 后运行
    // 3. 构造包含多轮对话和工具调用的模拟消息列表
    // 4. 调用 generateMigrationDoc 验证生成的交接文档格式
  });
});
