import { describe, it, expect, beforeEach, vi } from "vitest";
import { DeltaRenderer } from "./delta-renderer.js";
import { AgentNS } from "@ai-zen/agents-core";

// ==================== Mock 终端输出 ====================

let outputBuffer: string[] = [];

beforeEach(() => {
  outputBuffer = [];
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: any) => {
      outputBuffer.push(String(chunk));
      return true;
    },
  );
});

// ==================== 辅助函数 ====================

function lastOutput(): string {
  return outputBuffer.join("");
}

// ==================== 测试用例 ====================

describe("DeltaRenderer", () => {
  describe("基础渲染", () => {
    it("渲染 content", () => {
      const renderer = new DeltaRenderer();
      renderer.render({ content: "你好" });
      expect(lastOutput()).toContain("你好");
    });

    it("渲染 reasoning_content", () => {
      const renderer = new DeltaRenderer({
        reasoningHeader: "💭 ",
        reasoningStyle: (s: string) => `[推理:${s}]`,
      });
      renderer.render({ reasoning_content: "正在思考" });
      expect(lastOutput()).toContain("[推理:正在思考]");
    });

    it("渲染 reasoning 时只打印一次 header", () => {
      const renderer = new DeltaRenderer({
        reasoningHeader: "💭 ",
      });
      renderer.render({ reasoning_content: "第一步" });
      renderer.render({ reasoning_content: "第二步" });
      // header 只出现一次
      const matches = lastOutput().match(/💭 /g);
      expect(matches).toHaveLength(1);
    });

    it("渲染 content 时只打印一次 header", () => {
      const renderer = new DeltaRenderer({
        contentHeader: "🤖 ",
      });
      renderer.render({ content: "第一段" });
      renderer.render({ content: "第二段" });
      const matches = lastOutput().match(/🤖 /g);
      expect(matches).toHaveLength(1);
    });
  });

  describe("reset", () => {
    it("重置后重新打印 header", () => {
      const renderer = new DeltaRenderer({
        reasoningHeader: "💭 ",
      });
      renderer.render({ reasoning_content: "第一次" });
      renderer.reset();
      renderer.render({ reasoning_content: "第二次" });
      const matches = lastOutput().match(/💭 /g);
      expect(matches).toHaveLength(2);
    });
  });

  describe("缩进", () => {
    it("支持缩进（配合 header 使用时）", () => {
      const renderer = new DeltaRenderer({
        indent: "    ",
        contentHeader: "回答:",
      });
      renderer.render({ content: "你好" });
      expect(lastOutput()).toContain("    回答:");
    });
  });

  describe("tool_calls 渲染", () => {
    it("工具调用时打印 tool_calls header", () => {
      const renderer = new DeltaRenderer();
      const delta: AgentNS.Delta = {
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "readFile", arguments: '{"path":"test.txt"}' },
          },
        ],
      };
      renderer.render(delta, AgentNS.FinishReason.ToolCalls);
      expect(lastOutput()).toContain("工具调用");
    });

    it("工具调用完成后打印参数", () => {
      const renderer = new DeltaRenderer();
      const delta: AgentNS.Delta = {
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "readFile", arguments: '{"path":"test.txt"}' },
          },
        ],
      };
      renderer.render(delta, AgentNS.FinishReason.ToolCalls);
      expect(lastOutput()).toContain("readFile");
      expect(lastOutput()).toContain('"path"');
    });
  });

  describe("数组类型 content", () => {
    it("渲染数组中的文本片段", () => {
      const renderer = new DeltaRenderer();
      renderer.render({
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "World" },
        ],
      });
      expect(lastOutput()).toContain("Hello World");
    });
  });

  describe("选项配置", () => {
    it("未设置 header 时不输出", () => {
      const renderer = new DeltaRenderer({});
      renderer.render({ reasoning_content: "思考" });
      renderer.render({ content: "回答" });
      // 没有 header 内容，只输出实际文本
      expect(lastOutput()).toBe("思考回答");
    });

    it("使用自定义样式", () => {
      const renderer = new DeltaRenderer({
        contentStyle: (s: string) => `{${s}}`,
      });
      renderer.render({ content: "测试" });
      expect(lastOutput()).toBe("{测试}");
    });
  });
});
