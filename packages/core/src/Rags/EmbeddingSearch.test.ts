import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmbeddingSearch } from "./EmbeddingSearch.js";
import { KnowledgeBase } from "../KnowledgeBase.js";
import { Message } from "../Message.js";
import { AgentNS } from "../AgentNS.js";

function createMockKnowledgeBase(
  embeddingResult: number[],
  searchResults: { text: string }[],
): KnowledgeBase {
  const model = {
    createEmbedding: vi.fn().mockResolvedValue(embeddingResult),
    code: "mock-embedding",
    title: "Mock Embedding",
    type: "embedding",
    name: "MockEmbedding",
    model_config: {},
    request_config: { url: "https://test.com", headers: {}, body: {} },
  } as any;

  const kb = new KnowledgeBase({ model });
  // 直接注入 mock 的 db.search 方法
  (kb as any).db = {
    search: vi.fn().mockReturnValue(searchResults),
  };

  return kb;
}

describe("EmbeddingSearch", () => {
  describe("构造函数", () => {
    it("应正确构造", () => {
      const kb = createMockKnowledgeBase([0.1, 0.2], []);
      const rag = new EmbeddingSearch({ knowledge_bases: [kb] });

      expect(rag.knowledge_bases).toHaveLength(1);
      expect(rag.template).toBeDefined();
      expect(rag.endpoints).toEqual([]);
    });

    it("空 knowledge_bases 应允许", () => {
      const rag = new EmbeddingSearch({ knowledge_bases: [] });
      expect(rag.knowledge_bases).toEqual([]);
    });
  });

  describe("defaultTemplate", () => {
    it("文本内容应生成正确格式", () => {
      const rag = new EmbeddingSearch({ knowledge_bases: [] });
      const template = (rag as any).defaultTemplate.bind(rag);

      const result = template("今天的天气如何？", ["晴天", "25°C"]);
      expect(result).toContain("My question is:");
      expect(result).toContain("今天的天气如何？");
      expect(result).toContain("<晴天>, <25°C>");
      expect(result).toContain("Answer my question based on the following information:");
    });

    it("多模态内容应生成正确格式", () => {
      const rag = new EmbeddingSearch({ knowledge_bases: [] });
      const template = (rag as any).defaultTemplate.bind(rag);

      const sections: AgentNS.MessageContentSection[] = [
        { type: "text", text: "描述这张图片" },
        { type: "image_url", image_url: { url: "https://example.com/img.png" } },
      ];

      const result = template(sections, ["参考信息1"]);
      expect(Array.isArray(result)).toBe(true);
      const arr = result as AgentNS.MessageContentSection[];
      expect(arr[0].type).toBe("text");
      expect((arr[0] as AgentNS.TextContentSection).text).toContain("My question is:");
      expect(arr[1]).toBe(sections[0]);
      expect(arr[2]).toBe(sections[1]);
      expect(arr[3].type).toBe("text");
      expect((arr[3] as AgentNS.TextContentSection).text).toContain("<参考信息1>");
    });

    it("无引用时不应包含参考信息", () => {
      const rag = new EmbeddingSearch({ knowledge_bases: [] });
      const template = (rag as any).defaultTemplate.bind(rag);

      const result = template("你好", []);
      expect(result).toContain("My question is:");
      expect(result).toContain("你好");
      // 空引用的格式化结果为 ""
      expect(result).toContain("based on the following information:");
    });
  });

  describe("query", () => {
    it("应查询知识库并返回文本结果", async () => {
      const kb1 = createMockKnowledgeBase(
        [0.1, 0.2],
        [{ text: "北京晴天" }, { text: "北京多云" }],
      );
      const kb2 = createMockKnowledgeBase(
        [0.3, 0.4],
        [{ text: "上海阴天" }],
      );

      const rag = new EmbeddingSearch({ knowledge_bases: [kb1, kb2] });
      const results = await rag.query("天气");

      expect(results).toHaveLength(3);
      expect(results).toContain("北京晴天");
      expect(results).toContain("北京多云");
      expect(results).toContain("上海阴天");
    });

    it("知识库返回空时应过滤掉", async () => {
      const kb = createMockKnowledgeBase([0.1, 0.2], []);
      const rag = new EmbeddingSearch({ knowledge_bases: [kb] });
      const results = await rag.query("天气");

      expect(results).toEqual([]);
    });
  });

  describe("rewrite", () => {
    it("有引用时应改写用户消息", async () => {
      const kb = createMockKnowledgeBase(
        [0.1, 0.2],
        [{ text: "北京今天晴天" }],
      );

      const rag = new EmbeddingSearch({ knowledge_bases: [kb] });
      const msg = Message.User("北京天气如何？");

      await rag.rewrite(msg);

      // 原始内容应备份到 raw_content
      expect(msg.raw_content).toBe("北京天气如何？");
      // 改写后应包含参考信息
      expect(msg.content).toContain("北京今天晴天");
      expect(msg.content).toContain("My question is:");
    });

    it("无引用时不应改写消息", async () => {
      const kb = createMockKnowledgeBase([0.1, 0.2], []);
      const rag = new EmbeddingSearch({ knowledge_bases: [kb] });
      const msg = Message.User("北京天气如何？");

      await rag.rewrite(msg);

      // 没有引用，不应改写
      expect(msg.raw_content).toBeUndefined();
      expect(msg.content).toBe("北京天气如何？");
    });

    it("应使用自定义 template", async () => {
      const kb = createMockKnowledgeBase(
        [0.1, 0.2],
        [{ text: "北京今天晴天" }],
      );

      const customTemplate = vi.fn(
        (question: AgentNS.MessageContent, references: string[]) => {
          return `【参考】${references.join(" | ")} 【问题】${question}`;
        },
      );

      const rag = new EmbeddingSearch({
        knowledge_bases: [kb],
        template: customTemplate,
      });

      const msg = Message.User("天气如何？");
      await rag.rewrite(msg);

      expect(customTemplate).toHaveBeenCalledTimes(1);
      expect(msg.content).toBe("【参考】北京今天晴天 【问题】天气如何？");
    });
  });
});
