import { describe, it, expect } from "vitest";
import { execTool } from "./exec.js";

describe("execTool", () => {
  it("工具名称和描述正确", () => {
    expect(execTool.function.name).toBe("exec");
    expect(execTool.function.description).toBe("执行命令");
  });

  it("执行简单命令返回 stdout", async () => {
    const result = await execTool.callback({ command: "echo hello" });
    const parsed = JSON.parse(result as string);
    expect(parsed.stdout.trim()).toBe("hello");
  });

  it("执行命令返回 stderr", async () => {
    const result = await execTool.callback({ command: "echo error >&2" });
    const parsed = JSON.parse(result as string);
    expect(parsed.stderr.trim()).toBe("error");
  });
});
