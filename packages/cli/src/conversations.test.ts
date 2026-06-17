import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  saveConversation,
  loadConversation,
  deleteConversation,
  getConversationsList,
} from "./conversations.js";
import { AgentNS } from "@ai-zen/agents-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import { CONVERSATIONS_DIR } from "./config.js";

// ==================== Mock 文件系统 ====================

const vol = new Map<string, string>(); // path -> content
const dirs = new Set<string>();

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (path.includes("node_modules")) return actual.existsSync(path);
      return dirs.has(path) || vol.has(path);
    }),
    mkdirSync: vi.fn((path: string, options?: any) => {
      dirs.add(path);
    }),
    readFileSync: vi.fn((path: string, encoding?: any) => {
      if (path.includes("node_modules")) return actual.readFileSync(path, encoding);
      if (!vol.has(path)) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      return vol.get(path)!;
    }),
    writeFileSync: vi.fn((path: string, content: string) => {
      vol.set(path, content);
    }),
    unlinkSync: vi.fn((path: string) => {
      vol.delete(path);
    }),
    readdirSync: vi.fn((path: string) => {
      if (path.includes("node_modules")) return actual.readdirSync(path);
      if (!dirs.has(path)) throw new Error(`ENOENT: ${path}`);
      const prefix = path.endsWith("/") ? path : path + "/";
      const files: string[] = [];
      for (const key of vol.keys()) {
        if (key.startsWith(prefix)) {
          files.push(key.slice(prefix.length));
        }
      }
      return files;
    }),
  };
});

// ==================== Mock config ====================

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    ensureConfigDir: vi.fn(() => {
      dirs.add(CONVERSATIONS_DIR);
    }),
    CONVERSATIONS_DIR: actual.CONVERSATIONS_DIR,
  };
});

// ==================== 辅助函数 ====================

const sampleMessages: AgentNS.Message[] = [
  { role: "system", content: "你是一个助手" },
  { role: "user", content: "你好" },
  { role: "assistant", content: "你好！有什么可以帮助你的？" },
];

// ==================== beforeEach ====================

beforeEach(() => {
  vol.clear();
  dirs.clear();
  dirs.add(CONVERSATIONS_DIR);
  vi.clearAllMocks();
});

// ==================== getConversationsList ====================

describe("getConversationsList", () => {
  it("无对话时返回空数组", () => {
    const list = getConversationsList();
    expect(list).toEqual([]);
  });

  it("返回所有对话列表，按更新时间降序", () => {
    saveConversation("对话A", sampleMessages, "model-1");
    saveConversation("对话B", sampleMessages, "model-2");

    const list = getConversationsList();
    expect(list.length).toBe(2);
    const names = list.map((c) => c.name);
    expect(names).toContain("对话A");
    expect(names).toContain("对话B");
  });

  it("对话列表包含正确字段", () => {
    saveConversation("测试", sampleMessages, "deepseek-v4-flash", undefined, "agent-1");

    const list = getConversationsList();
    expect(list.length).toBe(1);
    const conv = list[0];
    expect(conv.id).toBe("测试");
    expect(conv.name).toBe("测试");
    expect(conv.modelId).toBe("deepseek-v4-flash");
    expect(conv.agentId).toBe("agent-1");
    expect(conv.messageCount).toBe(3);
    expect(conv.createdAt).toBeDefined();
    expect(conv.updatedAt).toBeDefined();
  });

  it("损坏的 JSON 文件被跳过", () => {
    writeFileSync(`${CONVERSATIONS_DIR}/bad.json`, "not-json");
    saveConversation("好的", sampleMessages, "model-1");
    const list = getConversationsList();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("好的");
  });
});

// ==================== saveConversation ====================

describe("saveConversation", () => {
  it("保存新对话，返回 ID", () => {
    const id = saveConversation("新对话", sampleMessages, "model-1");
    expect(id).toBe("新对话");
    expect(writeFileSync).toHaveBeenCalled();
  });

  it("保存时文件名中的非法字符被替换", () => {
    const id = saveConversation("测/试:对话*", sampleMessages, "model-1");
    expect(id).toBe("测_试_对话_");
  });

  it("更新已有对话时保留创建时间", () => {
    // 先保存一次，将数据写入 vol
    saveConversation("测试", sampleMessages, "model-1");
    
    // 第二次保存（更新），此时 vol 中已有旧数据
    const secondMessages: AgentNS.Message[] = [
      { role: "system", content: "你是一个助手" },
      { role: "user", content: "第二条消息" },
    ];
    saveConversation("测试", secondMessages, "model-1", "测试");

    // 读取最终写入的内容
    const finalSave = vi.mocked(writeFileSync).mock.calls[1][1] as string;
    const finalData = JSON.parse(finalSave);

    expect(finalData.createdAt).toBeDefined();
    expect(finalData.updatedAt).toBeDefined();
    expect(finalData.messages.length).toBe(2);
  });
});

// ==================== loadConversation ====================

describe("loadConversation", () => {
  it("加载已保存的对话", () => {
    saveConversation("测试", sampleMessages, "model-1");
    const loaded = loadConversation("测试");
    expect(loaded.name).toBe("测试");
    expect(loaded.modelId).toBe("model-1");
    expect(loaded.messages.length).toBe(3);
    expect(loaded.messageCount).toBe(3);
  });

  it("加载不存在的对话时抛出错误", () => {
    expect(() => loadConversation("non-existent")).toThrow();
  });
});

// ==================== deleteConversation ====================

describe("deleteConversation", () => {
  it("删除已保存的对话", () => {
    saveConversation("测试", sampleMessages, "model-1");
    expect(vol.has(`${CONVERSATIONS_DIR}/测试.json`)).toBe(true);
    deleteConversation("测试");
    expect(vol.has(`${CONVERSATIONS_DIR}/测试.json`)).toBe(false);
  });

  it("删除不存在的对话时抛出错误", () => {
    expect(() => deleteConversation("non-existent")).toThrow();
  });
});
