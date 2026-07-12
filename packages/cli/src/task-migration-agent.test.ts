import { describe, it, expect } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import {
  calcTotalChars,
  shouldMigrate,
  formatMessageToText,
  formatHistoryToText,
} from "./task-migration-agent.js";

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

// ==================== formatMessageToText ====================

describe("formatMessageToText", () => {
  it("渲染纯文本用户消息", () => {
    const msg = makeTextMsg(AgentNS.Role.User, "你好");
    expect(formatMessageToText(msg)).toBe("[user] 你好");
  });

  it("渲染纯文本助手回复", () => {
    const msg = makeTextMsg(AgentNS.Role.Assistant, "你好！有什么可以帮你的吗？");
    expect(formatMessageToText(msg)).toBe("[assistant] 你好！有什么可以帮你的吗？");
  });

  it("渲染系统提示词", () => {
    const msg = makeTextMsg(AgentNS.Role.System, "你是一个助手。");
    expect(formatMessageToText(msg)).toBe("[system] 你是一个助手。");
  });

  it("渲染 tool_calls 并保留 call_id", () => {
    const msg = makeToolCallMsg(AgentNS.Role.Assistant, [
      { name: "readFile", args: '{"path":"package.json"}' },
      { name: "ls", args: '{"path":"./src"}' },
    ]);
    const result = formatMessageToText(msg);
    expect(result).toContain("[assistant]");
    expect(result).toContain("call_0");
    expect(result).toContain("readFile");
    expect(result).toContain("call_1");
    expect(result).toContain("ls");
    expect(result).toContain('{"path":"package.json"}');
    expect(result).toContain('{"path":"./src"}');
  });

  it("渲染 tool 结果消息并标注对应的 call_id", () => {
    const msg = makeTextMsg(AgentNS.Role.Tool, '{"name":"readFile","content":"..."}', {
      tool_call_id: "call_0",
    });
    const result = formatMessageToText(msg);
    expect(result).toContain("[tool]");
    expect(result).toContain("[回应 call_0]");
    expect(result).toContain('{"name":"readFile","content":"..."}');
  });

  it("渲染 function_call 消息", () => {
    const msg = makeFunctionCallMsg(AgentNS.Role.Assistant, "writeFile", '{"path":"a.txt","content":"hi"}');
    const result = formatMessageToText(msg);
    expect(result).toContain("[assistant]");
    expect(result).toContain("writeFile");
    expect(result).toContain('{"path":"a.txt","content":"hi"}');
  });

  it("渲染数组内容（多模态）", () => {
    const msg: AgentNS.Message = {
      role: AgentNS.Role.Assistant,
      content: [
        { type: "text" as const, text: "这是图片：" },
        { type: "image_url" as const, image_url: { url: "https://example.com/img.png" } },
        { type: "text" as const, text: "描述完毕" },
      ],
    };
    const result = formatMessageToText(msg);
    expect(result).toContain("[assistant]");
    expect(result).toContain("这是图片：");
    expect(result).toContain("[图片: https://example.com/img.png]");
    expect(result).toContain("描述完毕");
  });

  it("跳过 hidden 消息", () => {
    const msg = makeTextMsg(AgentNS.Role.User, "隐藏消息", { hidden: true });
    expect(formatMessageToText(msg)).toBeNull();
  });

  it("跳过 omit 消息", () => {
    const msg = makeTextMsg(AgentNS.Role.User, "省略消息", { omit: true });
    expect(formatMessageToText(msg)).toBeNull();
  });

  it("content 为 undefined 且无 tool_calls 时渲染为 (空)", () => {
    const msg: AgentNS.Message = { role: AgentNS.Role.Assistant };
    expect(formatMessageToText(msg)).toBe("[assistant] (空)");
  });

  it("空字符串 content 无 tool_calls 时渲染为 (空)", () => {
    const msg = makeTextMsg(AgentNS.Role.Assistant, "");
    expect(formatMessageToText(msg)).toBe("[assistant] (空)");
  });
});

// ==================== formatHistoryToText ====================

describe("formatHistoryToText", () => {
  it("渲染完整对话历史", () => {
    const msgs = [
      makeTextMsg(AgentNS.Role.System, "你是一个AI助手。"),
      makeTextMsg(AgentNS.Role.User, "帮我看看项目结构"),
      makeToolCallMsg(AgentNS.Role.Assistant, [
        { name: "readFile", args: '{"path":"package.json"}' },
      ]),
      makeTextMsg(AgentNS.Role.Tool, '{"name":"readFile","content":"{\\"name\\":\\"test\\"}"}', {
        tool_call_id: "call_0",
      }),
      makeTextMsg(AgentNS.Role.Assistant, "已查看，项目名为 test"),
    ];

    const result = formatHistoryToText(msgs);
    const lines = result.split("\n");

    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("[system] 你是一个AI助手。");
    expect(lines[1]).toBe("[user] 帮我看看项目结构");
    expect(lines[2]).toContain("[assistant]");
    expect(lines[2]).toContain("readFile");
    expect(lines[2]).toContain("call_0");
    expect(lines[3]).toContain("[tool]");
    expect(lines[3]).toContain("[回应 call_0]");
    expect(lines[4]).toBe("[assistant] 已查看，项目名为 test");
  });

  it("过滤掉 hidden 和 omit 消息", () => {
    const msgs = [
      makeTextMsg(AgentNS.Role.User, "可见消息"),
      makeTextMsg(AgentNS.Role.User, "隐藏消息", { hidden: true }),
      makeTextMsg(AgentNS.Role.User, "省略消息", { omit: true }),
      makeTextMsg(AgentNS.Role.User, "又可见"),
    ];
    const result = formatHistoryToText(msgs);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("[user] 可见消息");
    expect(lines[1]).toBe("[user] 又可见");
  });

  it("空列表返回空字符串", () => {
    expect(formatHistoryToText([])).toBe("");
  });
});

// ==================== calcTotalChars ====================

describe("calcTotalChars", () => {
  it("计算消息列表的总字符数（基于 JSON 序列化）", () => {
    const msgs = [
      makeTextMsg(AgentNS.Role.User, "你好"),
      makeTextMsg(AgentNS.Role.Assistant, "你好！有什么可以帮你的吗？"),
    ];
    const expected = JSON.stringify(msgs).length;
    expect(calcTotalChars(msgs)).toBe(expected);
  });

  it("计算空消息列表，长度为 2（[]）", () => {
    expect(calcTotalChars([])).toBe(2);
  });

  it("包含 tool_calls 的消息", () => {
    const msgs = [
      makeToolCallMsg(AgentNS.Role.Assistant, [
        { name: "readFile", args: '{"path":"src/index.ts"}' },
      ]),
    ];
    const expected = JSON.stringify(msgs).length;
    expect(calcTotalChars(msgs)).toBe(expected);
  });

  it("包含 function_call 的消息", () => {
    const msgs = [
      makeFunctionCallMsg(AgentNS.Role.Assistant, "writeFile", '{"path":"a.txt","content":"hi"}'),
    ];
    const expected = JSON.stringify(msgs).length;
    expect(calcTotalChars(msgs)).toBe(expected);
  });

  it("混合多种类型的消息", () => {
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

  it("含 image_url 内容段", () => {
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

  it("content 为 undefined 的消息", () => {
    const msgs: AgentNS.Message[] = [
      { role: AgentNS.Role.Assistant },
    ];
    const expected = JSON.stringify(msgs).length;
    expect(calcTotalChars(msgs)).toBe(expected);
  });

  it("hidden 和 omit 消息也计入总长度（JSON 序列化不会跳过任何字段）", () => {
    const msgs = [
      makeTextMsg(AgentNS.Role.User, "可见"),
      makeTextMsg(AgentNS.Role.User, "隐藏", { hidden: true }),
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
   */
  function makeMsgs(count: number): AgentNS.Message[] {
    return Array.from({ length: count }, (_, i) =>
      makeTextMsg(AgentNS.Role.User, "x".repeat(10)),
    );
  }

  it("消息文本长度超过 maxContextChars 时返回 true", () => {
    const msgs = makeMsgs(300);
    expect(shouldMigrate(msgs, 5000)).toBe(true);
  });

  it("消息文本长度小于 maxContextChars 时返回 false", () => {
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

  it("边界值：文本长度刚好等于 maxContextChars 时返回 true", () => {
    const msgs = [
      makeTextMsg(AgentNS.Role.User, "测试消息"),
    ];
    const totalChars = calcTotalChars(msgs);
    const maxContextChars = totalChars;
    expect(shouldMigrate(msgs, maxContextChars)).toBe(true);
  });

  it("边界值：文本长度刚好小于 maxContextChars 时返回 false", () => {
    const msgs = [
      makeTextMsg(AgentNS.Role.User, "测试消息"),
    ];
    const totalChars = calcTotalChars(msgs);
    const maxContextChars = totalChars + 1;
    expect(shouldMigrate(msgs, maxContextChars)).toBe(false);
  });
});

// ==================== 集成测试（会调用真实 API，默认跳过） ====================
// 设置 RUN_INTEGRATION=true 环境变量来启用集成测试
// 需要确保 ~/.ai-zen/config.json 中配置了有效的 API Key 和默认模型
// 用法: RUN_INTEGRATION=true npx vitest run task-migration-agent.test.ts
const runIntegration = process.env.RUN_INTEGRATION === "true";

(runIntegration ? describe : describe.skip)("generateMigrationDoc 集成测试", () => {
  /**
   * 构造一个模拟的多轮对话历史，包含：
   * - 系统提示词
   * - 多轮用户/助手对话
   * - 工具调用（readFile、writeFile）
   * - 工具结果返回
   * - 多模态内容（图片）
   */
  function makeMockHistory(): AgentNS.Message[] {
    return [
      makeTextMsg(AgentNS.Role.System, "你是一个AI助手，帮助用户回答问题和执行任务。"),
      makeTextMsg(AgentNS.Role.User, "帮我看看当前项目结构"),
      makeToolCallMsg(AgentNS.Role.Assistant, [
        { name: "readFile", args: '{"path":"package.json"}' },
        { name: "ls", args: '{"path":"./src"}' },
      ]),
      makeTextMsg(AgentNS.Role.Tool, '{"name":"readFile","content":"{\\"name\\":\\"test-project\\"}"}', { tool_call_id: "call_0" }),
      makeTextMsg(AgentNS.Role.Tool, '{"name":"ls","content":"[\\"index.ts\\",\\"utils.ts\\"]"}', { tool_call_id: "call_1" }),
      makeTextMsg(AgentNS.Role.Assistant, "项目结构已查看，根目录有 package.json，src 下有 index.ts 和 utils.ts"),
      makeTextMsg(AgentNS.Role.User, "帮我创建一个新文件 src/api.ts，写一个简单的 fetch 封装"),
      makeToolCallMsg(AgentNS.Role.Assistant, [
        { name: "writeFile", args: '{"path":"src/api.ts","content":"export async function fetchData(url: string) {\\n  const res = await fetch(url);\\n  return res.json();\\n}"}' },
      ]),
      makeTextMsg(AgentNS.Role.Tool, "文件已写入", { tool_call_id: "call_0" }),
      makeTextMsg(AgentNS.Role.Assistant, "文件 src/api.ts 已创建，包含一个 fetchData 函数"),
      makeTextMsg(AgentNS.Role.User, "很好，再帮我把这个函数改名为 requestApi，并且加上错误处理"),
      makeTextMsg(AgentNS.Role.Assistant, "好的，我来修改 src/api.ts"),
      makeToolCallMsg(AgentNS.Role.Assistant, [
        { name: "readFile", args: '{"path":"src/api.ts"}' },
      ]),
      makeTextMsg(AgentNS.Role.Tool, "export async function fetchData(url: string) {\\n  const res = await fetch(url);\\n  return res.json();\\n}", { tool_call_id: "call_0" }),
      makeToolCallMsg(AgentNS.Role.Assistant, [
        { name: "writeFile", args: '{"path":"src/api.ts","content":"export async function requestApi(url: string) {\\n  try {\\n    const res = await fetch(url);\\n    if (!res.ok) throw new Error(\\"HTTP \\" + res.status);\\n    return res.json();\\n  } catch (err) {\\n    console.error(\\"请求失败:\\", err);\\n    throw err;\\n  }\\n}"}' },
      ]),
      makeTextMsg(AgentNS.Role.Tool, "文件已写入", { tool_call_id: "call_0" }),
      makeTextMsg(AgentNS.Role.Assistant, "已修改完成：函数改名为 requestApi，加了 try/catch 错误处理和 HTTP 状态检查"),
      makeTextMsg(AgentNS.Role.User, "好的，谢谢"),
    ];
  }

  it("生成符合模板格式的交接文档", async () => {
    const { generateMigrationDoc } = await import("./task-migration-agent.js");
    const history = makeMockHistory();

    const doc = await generateMigrationDoc(history);

    // 验证文档不为空
    expect(doc).toBeTruthy();
    expect(doc.trim().length).toBeGreaterThan(0);

    // 验证包含必要的模板章节标题
    const requiredSections = [
      "对话断点",
      "已完成的任务",
      "未完成的任务",
      "重要记忆",
      "文件索引",
      "接手指令",
    ];
    for (const section of requiredSections) {
      expect(doc).toContain(section);
    }

    // 验证文档格式为 Markdown（包含标题标记）
    expect(doc).toContain("##");

    // 验证包含对话历史中的关键信息
    expect(doc).toContain("src/api.ts");
    expect(doc).toContain("requestApi");
  });

  it("处理简短对话时返回有效文档", async () => {
    const { generateMigrationDoc } = await import("./task-migration-agent.js");
    const history: AgentNS.Message[] = [
      makeTextMsg(AgentNS.Role.System, "你是一个AI助手，帮助用户回答问题和执行任务。"),
      makeTextMsg(AgentNS.Role.User, "帮我创建一个 Node.js 脚本，读取当前目录下所有 .md 文件并统计总字数"),
      makeToolCallMsg(AgentNS.Role.Assistant, [
        { name: "readFile", args: '{"path":"package.json"}' },
      ]),
      makeTextMsg(AgentNS.Role.Tool, '{"name":"readProject","content":"{\"name\":\"test-project\"}"}', { tool_call_id: "call_0" }),
      makeTextMsg(AgentNS.Role.Assistant, "已查看项目结构，package.json 显示项目名为 test-project"),
      makeToolCallMsg(AgentNS.Role.Assistant, [
        { name: "writeFile", args: '{"path":"count-md.js","content":"const fs = require(\"fs\");\\nconst path = require(\"path\");\\nconst mdFiles = fs.readdirSync(__dirname).filter(f => f.endsWith(\".md\"));\\nlet total = 0;\\nfor (const f of mdFiles) {\\n  const content = fs.readFileSync(f, \"utf-8\");\\n  total += content.length;\\n}\\nconsole.log(\"总字数:\", total);"}' },
      ]),
      makeTextMsg(AgentNS.Role.Tool, "文件已写入", { tool_call_id: "call_0" }),
      makeTextMsg(AgentNS.Role.Assistant, "脚本 count-md.js 已创建，功能是统计当前目录下所有 .md 文件的总字数"),
    ];

    const doc = await generateMigrationDoc(history);

    expect(doc).toBeTruthy();
    expect(doc.trim().length).toBeGreaterThan(0);
    expect(doc).toContain("##");
  });

  it("处理包含图片内容的对话历史", async () => {
    const { generateMigrationDoc } = await import("./task-migration-agent.js");
    const history: AgentNS.Message[] = [
      makeTextMsg(AgentNS.Role.System, "你是一个AI助手。"),
      makeTextMsg(AgentNS.Role.User, "帮我看一下这张图片"),
      {
        role: AgentNS.Role.Assistant,
        content: [
          { type: "text" as const, text: "这是一张示意图：" },
          { type: "image_url" as const, image_url: { url: "https://example.com/diagram.png" } },
        ],
      },
    ];

    const doc = await generateMigrationDoc(history);

    expect(doc).toBeTruthy();
    expect(doc.trim().length).toBeGreaterThan(0);
    expect(doc).toContain("##");
  });
});
