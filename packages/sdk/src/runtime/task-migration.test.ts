import { describe, it, expect } from "vitest";
import { shouldMigrate, countContextChars, buildMigrationPrompt } from "./task-migration";
import type { AgentMessage } from "../types";

describe("countContextChars", () => {
  it("计算 JSON 序列化后的字符数", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "Hello" },
      { role: "user", content: "Hi" },
    ];
    const expected = JSON.stringify(messages).length;
    expect(countContextChars(messages)).toBe(expected);
  });

  it("空数组为 2（空 JSON 数组）", () => {
    expect(countContextChars([])).toBe(2);
  });
});

describe("shouldMigrate", () => {
  it("超过阈值返回 true", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(600) },
    ];
    expect(shouldMigrate(messages, 500)).toBe(true);
  });

  it("未超阈值返回 false", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" },
    ];
    expect(shouldMigrate(messages, 500000)).toBe(false);
  });
});

describe("buildMigrationPrompt", () => {
  it("包含所有六个章节标题", () => {
    const prompt = buildMigrationPrompt();
    expect(prompt).toContain("## 💬 对话断点");
    expect(prompt).toContain("## ✅ 已完成的任务");
    expect(prompt).toContain("## 📋 未完成的任务");
    expect(prompt).toContain("## 🧠 重要记忆");
    expect(prompt).toContain("## 📁 文件索引");
    expect(prompt).toContain("## 🔔 接手指令");
  });
});
