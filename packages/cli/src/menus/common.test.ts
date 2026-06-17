import { describe, it, expect } from "vitest";
import { maskApiKey, SEPARATOR, SEPARATOR_LONG } from "./common.js";

// ==================== maskApiKey ====================

describe("maskApiKey", () => {
  it("未设置时返回红色提示", () => {
    const result = maskApiKey(undefined);
    expect(result).toContain("未设置");
  });

  it("空字符串返回红色提示", () => {
    const result = maskApiKey("");
    expect(result).toContain("未设置");
  });

  it("短 key（<=12）只保留首尾 4 位", () => {
    const result = maskApiKey("123456789012");
    expect(result).toContain("1234");
    expect(result).toContain("9012");
    expect(result).toContain("...");
  });

  it("长 key 保留前 8 位和后 4 位", () => {
    const result = maskApiKey("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(result).toContain("sk-abcde");
    expect(result).toContain("3456");
    expect(result).toContain("...");
  });

  it("不同长度的 key 都能正确处理", () => {
    const key = "a".repeat(20);
    const result = maskApiKey(key);
    expect(result).toContain("aaaaaaaa");
    expect(result).toContain("aaaa");
  });
});

// ==================== 分隔线 ====================

describe("SEPARATOR", () => {
  it("SEPARATOR 长度为 60", () => {
    // chalk.gray 会添加 ANSI 转义码，取纯文本
    const plain = SEPARATOR.replace(/\u001b\[\d+m/g, "");
    expect(plain.length).toBe(60);
  });
});

describe("SEPARATOR_LONG", () => {
  it("SEPARATOR_LONG 长度为 80", () => {
    const plain = SEPARATOR_LONG.replace(/\u001b\[\d+m/g, "");
    expect(plain.length).toBe(80);
  });
});
