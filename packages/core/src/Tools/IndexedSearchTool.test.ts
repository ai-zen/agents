import { describe, it, expect, vi } from "vitest";
import { IndexedSearchTool, type IndexedSearchEntry } from "./IndexedSearchTool.js";
import { FunctionCallContext } from "../FunctionCallContext.js";
import { Agent } from "../Agent.js";
import { Message } from "../Message.js";

function createMockAgent(): Agent {
  return new Agent({ model: {} as any, messages: [Message.System("test")], tools: [] });
}

function createMockCtx(agent: Agent, parsed_args: any): FunctionCallContext {
  return new FunctionCallContext({
    agent,
    function_call: { name: "indexedSearch", arguments: JSON.stringify(parsed_args) },
    result_message: Message.Tool({ id: 1, function: { name: "indexedSearch" } }),
  });
}

describe("IndexedSearchTool", () => {
  const entries: IndexedSearchEntry[] = [
    { keywords: ["天气", "weather"], text: "今天天气晴朗，气温25°C" },
    { keywords: ["新闻", "news"], text: "今日要闻：科技创新取得突破" },
    { keywords: ["股票", "stock", "股市"], text: "今日股市收涨，沪指突破3500点" },
    { keywords: ["天气", "北京"], text: "北京天气：多云，气温18-28°C" },
  ];

  it("应通过关键词匹配到正确条目", async () => {
    const tool = new IndexedSearchTool({ entries });
    const agent = createMockAgent();
    const ctx = createMockCtx(agent, { keywords: ["天气"] });

    const result = await tool.exec(ctx);
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(2);
    const texts = parsed.map((r: any) => r.text);
    expect(texts).toContain("今天天气晴朗，气温25°C");
    expect(texts).toContain("北京天气：多云，气温18-28°C");
  });

  it("关键词输入为字符串（非数组）时应兼容处理", async () => {
    const tool = new IndexedSearchTool({ entries });
    const agent = createMockAgent();

    // 模拟 GPT 有时会传入字符串而非数组
    const ctx = new FunctionCallContext({
      agent,
      function_call: { name: "indexedSearch", arguments: JSON.stringify({ keywords: "weather" }) },
      result_message: Message.Tool({ id: 1, function: { name: "indexedSearch" } }),
    });

    const result = await tool.exec(ctx);
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe("今天天气晴朗，气温25°C");
  });

  it("无匹配关键词应返回空数组", async () => {
    const tool = new IndexedSearchTool({ entries });
    const agent = createMockAgent();
    const ctx = createMockCtx(agent, { keywords: ["不存在的关键词"] });

    const result = await tool.exec(ctx);
    expect(JSON.parse(result)).toEqual([]);
  });

  it("多个关键词匹配去重", async () => {
    const tool = new IndexedSearchTool({ entries });
    const agent = createMockAgent();
    // "天气" 匹配 2 条，"北京" 匹配 1 条，但 "北京天气" 同时包含两者，所以总共 2 条
    const ctx = createMockCtx(agent, { keywords: ["天气", "北京"] });

    const result = await tool.exec(ctx);
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(2);
  });

  it("构造函数应自动生成 function 定义", () => {
    const tool = new IndexedSearchTool({ entries });
    expect(tool.function.name).toBe("indexedSearch");
    expect(tool.function.parameters.properties?.keywords).toBeDefined();
    // 应包含所有唯一关键词作为 enum
    const enumValues = (tool.function.parameters.properties!.keywords as any).items.enum;
    expect(enumValues).toContain("天气");
    expect(enumValues).toContain("新闻");
    expect(enumValues).toContain("股票");
    expect(enumValues).toContain("北京");
    expect(enumValues).toContain("weather"); // weather 是独立关键词，应包含
  });
});
