import { describe, it, expect } from "vitest";
import { VectorDatabase, type DatabaseRecord } from "./VectorDatabase.js";

interface TestRecord extends DatabaseRecord {
  id: number;
  label: string;
}

function makeRecord(id: number, vector: number[], label?: string): TestRecord {
  return { id, vector, label: label ?? `item-${id}` };
}

describe("VectorDatabase", () => {
  describe("cosineSimilarity", () => {
    it("完全相同向量应返回 1", () => {
      const db = new VectorDatabase();
      const result = db.cosineSimilarity([1, 2, 3], [1, 2, 3]);
      expect(result).toBeCloseTo(1, 5);
    });

    it("相反向量应返回 -1", () => {
      const db = new VectorDatabase();
      const result = db.cosineSimilarity([1, 0], [-1, 0]);
      expect(result).toBeCloseTo(-1, 5);
    });

    it("正交向量应返回 0", () => {
      const db = new VectorDatabase();
      const result = db.cosineSimilarity([1, 0], [0, 1]);
      expect(result).toBeCloseTo(0, 5);
    });

    it("零向量与任意向量的相似度为 0", () => {
      const db = new VectorDatabase();
      expect(db.cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
      expect(db.cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
      expect(db.cosineSimilarity([0, 0], [0, 0])).toBe(0);
    });

    it("部分相似向量应返回介于 0~1 的值", () => {
      const db = new VectorDatabase();
      const result = db.cosineSimilarity([1, 2, 3], [4, 5, 6]);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);
    });
  });

  describe("search", () => {
    it("应返回按相似度排序的结果", () => {
      const db = new VectorDatabase<TestRecord>([
        makeRecord(1, [1, 0], "水平右"),
        makeRecord(2, [0, 1], "垂直上"),
        makeRecord(3, [-1, 0], "水平左"),
        makeRecord(4, [1, 1], "右上"),
      ]);

      // 搜索指向右侧的向量 [1, 0]
      const results = db.search([1, 0], 4, 0);

      // 余弦相似度：[1,0]≈1, [1,1]≈0.707, [0,1]=0, [-1,0]=-1
      // 过滤条件 score > 0，所以 score=0 和 score<0 的被过滤掉
      // 只有 score > 0 的 [1,0](1) 和 [1,1](0.707) 保留
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe(1); // 1.0
      expect(results[1].id).toBe(4); // 0.707
    });

    it("应过滤掉低于 minScore 的结果", () => {
      const db = new VectorDatabase<TestRecord>([
        makeRecord(1, [1, 0]),      // cos([1,0], [1,0]) = 1
        makeRecord(2, [0.5, 0.5]),  // cos([1,0], [0.5,0.5]) = 0.707
        makeRecord(3, [0.1, 0.1]),  // cos([1,0], [0.1,0.1]) = 0.707
      ]);

      // minScore=0.8, 只有 [1,0] 的相似度 1 > 0.8
      const results = db.search([1, 0], 10, 0.8);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(1);
    });

    it("应限制返回数量不超过 topN", () => {
      const db = new VectorDatabase<TestRecord>([
        makeRecord(1, [1, 0]),
        makeRecord(2, [0, 1]),
        makeRecord(3, [-1, 0]),
      ]);

      const results = db.search([1, 0], 1, -1);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(1);
    });

    it("空数据库应返回空数组", () => {
      const db = new VectorDatabase<TestRecord>([]);
      const results = db.search([1, 0], 5, 0);
      expect(results).toEqual([]);
    });
  });

  describe("insert / input / output", () => {
    it("insert 应添加单条记录", () => {
      const db = new VectorDatabase<TestRecord>();
      db.insert(makeRecord(1, [1, 0]));

      expect(db.output()).toHaveLength(1);
      expect(db.output()[0].id).toBe(1);
    });

    it("input 应批量添加记录", () => {
      const db = new VectorDatabase<TestRecord>();
      db.input([
        makeRecord(1, [1, 0]),
        makeRecord(2, [0, 1]),
      ]);

      expect(db.output()).toHaveLength(2);
    });

    it("构造函数可接受初始数据", () => {
      const db = new VectorDatabase<TestRecord>([
        makeRecord(1, [1, 0]),
      ]);
      expect(db.output()).toHaveLength(1);
    });

    it("多次 insert 应累积记录", () => {
      const db = new VectorDatabase<TestRecord>();
      db.insert(makeRecord(1, [1, 0]));
      db.insert(makeRecord(2, [0, 1]));
      db.insert(makeRecord(3, [-1, 0]));

      expect(db.output()).toHaveLength(3);
    });
  });
});
