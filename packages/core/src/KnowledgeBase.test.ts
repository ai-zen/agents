import { describe, it, expect, vi } from "vitest";
import { KnowledgeBase, type KnowledgeItem } from "./KnowledgeBase.js";
import { EmbeddingModel } from "./Models/EmbeddingModel.js";

function createMockEmbeddingModel(): EmbeddingModel {
  return {
    createEmbedding: vi.fn(),
    code: "mock-embedding",
    title: "Mock Embedding",
    type: "embedding",
    name: "MockEmbedding",
    model_config: {},
    request_config: { url: "https://test.com", headers: {}, body: {} },
  } as any;
}

describe("KnowledgeBase", () => {
  describe("构造函数", () => {
    it("缺少 model 时应抛出错误", () => {
      expect(() => {
        new KnowledgeBase({} as any);
      }).toThrow("KnowledgeBase must have a model");
    });

    it("应正确构造", () => {
      const model = createMockEmbeddingModel();
      const kb = new KnowledgeBase({ model });
      expect(kb.model).toBe(model);
      expect(kb.data).toEqual([]);
    });

    it("应接受初始数据", () => {
      const model = createMockEmbeddingModel();
      const data: KnowledgeItem[] = [
        { title: "t1", text: "text1", vector: [0.1, 0.2] },
        { title: "t2", text: "text2", vector: [0.3, 0.4] },
      ];
      const kb = new KnowledgeBase({ model, data });
      expect(kb.data).toHaveLength(2);
    });
  });

  describe("search", () => {
    it("应委托给 VectorDatabase.search 并返回排序结果", () => {
      const model = createMockEmbeddingModel();
      const data: KnowledgeItem[] = [
        { title: "北京天气", text: "北京今天晴天", vector: [1.0, 0.0] },
        { title: "上海天气", text: "上海今天多云", vector: [0.8, 0.2] },
        { title: "深圳天气", text: "深圳今天下雨", vector: [0.1, 0.9] },
      ];
      const kb = new KnowledgeBase({ model, data });

      // 搜索指向 [1.0, 0.0] 的结果
      const results = kb.search([1.0, 0.0], 2, 0.5);
      expect(results).toHaveLength(2);
      expect(results[0].text).toBe("北京今天晴天"); // cos=1 最高
      expect(results[1].text).toBe("上海今天多云"); // cos≈0.97 次高
    });

    it("无匹配结果应返回空数组", () => {
      const model = createMockEmbeddingModel();
      const data: KnowledgeItem[] = [
        { title: "t1", text: "text1", vector: [0.1, 0.2] },
      ];
      const kb = new KnowledgeBase({ model, data });

      const results = kb.search([-1, -1], 5, 0.9);
      expect(results).toEqual([]);
    });
  });
});
