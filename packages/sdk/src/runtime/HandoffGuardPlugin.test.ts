import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { HandoffGuardPlugin } from "./HandoffGuardPlugin.js";

const CWD = "/workspace/project";
const HANDOFF = "/workspace/project/.ai-zen/handoffs/20260101-000000-abcd1234.md";

/** 构造 ToolCallContext 的最小表面 */
function toolCall(name: string, args: Record<string, unknown> = {}): any {
  return { tool_call: { function: { name } }, parsedArgs: args };
}

describe("HandoffGuardPlugin", () => {
  it("未 arm 时完全让行（不影响正常对话的写操作）", () => {
    const guard = new HandoffGuardPlugin();
    expect(guard.armed).toBe(false);
    expect(guard.onToolCall(toolCall("write", { path: "src/a.ts" }))).toBeUndefined();
    expect(guard.onToolCall(toolCall("rm", { path: "src" }))).toBeUndefined();
  });

  it("arm 后放行对交接文档的写入（含相对路径归一）", () => {
    const guard = new HandoffGuardPlugin();
    guard.arm(HANDOFF, CWD);

    expect(guard.onToolCall(toolCall("write", { path: HANDOFF }))).toBeUndefined();
    expect(
      guard.onToolCall(
        toolCall("write", { path: ".ai-zen/handoffs/20260101-000000-abcd1234.md" }),
      ),
    ).toBeUndefined();
  });

  it("arm 后拒绝写到其他路径，并给出可用于纠偏的提示", () => {
    const guard = new HandoffGuardPlugin();
    guard.arm(HANDOFF, CWD);

    const rejection = guard.onToolCall(toolCall("write", { path: "src/a.ts" }));

    expect(typeof rejection).toBe("string");
    expect(rejection).toContain("only allowed write is the handoff document");
    expect(rejection).toContain(HANDOFF);
  });

  it("arm 后拒绝其他写入类工具（edit / rm / rename / mkdir …）", () => {
    const guard = new HandoffGuardPlugin();
    guard.arm(HANDOFF, CWD);

    for (const name of ["edit", "batch_edit", "rm", "rename", "mkdir", "copy"]) {
      const rejection = guard.onToolCall(toolCall(name, { path: HANDOFF }));
      expect(rejection).toContain("Modifying the workspace is not allowed");
    }
  });

  it("arm 后放行读取类工具（核实状态需要）", () => {
    const guard = new HandoffGuardPlugin();
    guard.arm(HANDOFF, CWD);

    for (const name of ["read", "ls", "glob", "find_text", "inspect_file", "cwd", "exec"]) {
      expect(guard.onToolCall(toolCall(name))).toBeUndefined();
    }
  });

  it("disarm 后恢复完全让行", () => {
    const guard = new HandoffGuardPlugin();
    guard.arm(HANDOFF, CWD);
    guard.disarm();

    expect(guard.onToolCall(toolCall("write", { path: "src/a.ts" }))).toBeUndefined();
    expect(guard.onToolCall(toolCall("edit", { path: "src/a.ts" }))).toBeUndefined();
  });

  it("arm 时归一化交接文档路径（传入相对交接路径也可比较）", () => {
    const guard = new HandoffGuardPlugin();
    guard.arm(".ai-zen/handoffs/x.md", CWD);

    expect(
      guard.onToolCall(toolCall("write", { path: resolve(CWD, ".ai-zen/handoffs/x.md") })),
    ).toBeUndefined();
  });
});
