import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { HandoffGuardPlugin, HANDOFF_SOURCE_LABEL } from "./HandoffGuardPlugin.js";

const CWD = "/workspace/project";
const HANDOFF = "/workspace/project/.ai-zen/handoffs/20260101-000000-abcd1234.md";

/**
 * 构造 `onToolStart` 的 ctx：守卫只读 `toolCall.tool_call.function.name` 与
 * `toolCall.parsedArgs`，所以这里给一个最小表面即可。
 */
function toolStart(name: string, args: Record<string, unknown> = {}): any {
  return { agent: {}, toolCall: { tool_call: { function: { name } }, parsedArgs: args } };
}

describe("HandoffGuardPlugin", () => {
  it("未 arm 时完全让行（不影响正常对话的写操作）", () => {
    const guard = new HandoffGuardPlugin();
    expect(guard.armed).toBe(false);
    expect(guard.onToolStart(toolStart("write", { path: "src/a.ts" }))).toBeUndefined();
    expect(guard.onToolStart(toolStart("rm", { path: "src" }))).toBeUndefined();
  });

  it("arm 后放行对交接文档的写入（含相对路径归一）", () => {
    const guard = new HandoffGuardPlugin();
    guard.arm(HANDOFF, CWD);

    expect(guard.onToolStart(toolStart("write", { path: HANDOFF }))).toBeUndefined();
    expect(
      guard.onToolStart(
        toolStart("write", { path: ".ai-zen/handoffs/20260101-000000-abcd1234.md" }),
      ),
    ).toBeUndefined();
  });

  it("arm 后拒绝写到其他路径，并给出可用于纠偏的提示", () => {
    const guard = new HandoffGuardPlugin();
    guard.arm(HANDOFF, CWD);

    const rejection = guard.onToolStart(toolStart("write", { path: "src/a.ts" }));

    expect(typeof rejection).toBe("string");
    expect(rejection).toContain("only allowed write is the handoff document");
    expect(rejection).toContain(HANDOFF);
  });

  it("arm 后拒绝其他写入类工具（edit / rm / rename / mkdir …）", () => {
    const guard = new HandoffGuardPlugin();
    guard.arm(HANDOFF, CWD);

    for (const name of ["edit", "batch_edit", "rm", "rename", "mkdir", "copy"]) {
      const rejection = guard.onToolStart(toolStart(name, { path: HANDOFF }));
      expect(rejection).toContain("Modifying the workspace is not allowed");
    }
  });

  it("arm 后放行读取类工具（核实状态需要）", () => {
    const guard = new HandoffGuardPlugin();
    guard.arm(HANDOFF, CWD);

    for (const name of ["read", "ls", "glob", "find_text", "inspect_file", "cwd", "exec"]) {
      expect(guard.onToolStart(toolStart(name))).toBeUndefined();
    }
  });

  it("disarm 后恢复完全让行", () => {
    const guard = new HandoffGuardPlugin();
    guard.arm(HANDOFF, CWD);
    guard.disarm();

    expect(guard.onToolStart(toolStart("write", { path: "src/a.ts" }))).toBeUndefined();
    expect(guard.onToolStart(toolStart("edit", { path: "src/a.ts" }))).toBeUndefined();
  });

  it("arm 时归一化交接文档路径（传入相对交接路径也可比较）", () => {
    const guard = new HandoffGuardPlugin();
    guard.arm(".ai-zen/handoffs/x.md", CWD);

    expect(
      guard.onToolStart(toolStart("write", { path: resolve(CWD, ".ai-zen/handoffs/x.md") })),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 那次写文档的结果（自交接的判据）与这一批的收口
// ---------------------------------------------------------------------------

/**
 * 构造 `onToolEnd` 的 ctx：判据只读工具名、参数里的路径与结果消息的状态。
 */
function toolEnd(name: string, args: Record<string, unknown> = {}, status = "completed"): any {
  return {
    agent: {},
    toolCall: {
      tool_call: { function: { name } },
      parsedArgs: args,
      resultMessage: { status },
    },
  };
}

/** 一条交接指令（`onOuterLoopStart` 按来源标签认出它） */
function handoffEntry(): any {
  return { priority: "low", source: { kind: "system", label: HANDOFF_SOURCE_LABEL }, content: "去写" };
}

describe("HandoffGuardPlugin：写这份文档的结果", () => {
  it("写到交接路径的那次调用回来了 → 写完了", async () => {
    const guard = new HandoffGuardPlugin();
    const watch = guard.arm(HANDOFF, CWD);

    guard.onToolEnd(toolEnd("write", { path: HANDOFF }));

    expect(await watch.outcome).toBe("written");
  });

  it("那一下被掐（结果标成 Aborted）→ 被中断", async () => {
    const guard = new HandoffGuardPlugin();
    const watch = guard.arm(HANDOFF, CWD);

    guard.onToolEnd(toolEnd("write", { path: HANDOFF }, "aborted"));

    expect(await watch.outcome).toBe("interrupted");
  });

  it("写别的路径被门拒了，那一次不算写完", async () => {
    const guard = new HandoffGuardPlugin();
    const watch = guard.arm(HANDOFF, CWD);

    expect(guard.onToolStart(toolStart("write", { path: "src/a.ts" }))).toBeTypeOf("string");
    guard.onToolEnd(toolEnd("write", { path: "src/a.ts" }));

    guard.onOuterLoopStart({ agent: {}, entries: [handoffEntry()] } as any);
    guard.onOuterLoopEnd();

    expect(await watch.outcome).toBe("missing");
  });

  it("这一批收口了还没见到那次写 → 没写出来（顺带报这一批完了）", async () => {
    const guard = new HandoffGuardPlugin();
    const watch = guard.arm(HANDOFF, CWD);

    guard.onOuterLoopStart({ agent: {}, entries: [handoffEntry()] } as any);
    guard.onOuterLoopEnd();

    expect(await watch.outcome).toBe("missing");
    await expect(watch.over).resolves.toBeUndefined();
  });

  it("写完了也照样报这一批收口（此后这段记忆不再增长）", async () => {
    const guard = new HandoffGuardPlugin();
    const watch = guard.arm(HANDOFF, CWD);

    guard.onOuterLoopStart({ agent: {}, entries: [handoffEntry()] } as any);
    guard.onToolEnd(toolEnd("write", { path: HANDOFF }));
    guard.onOuterLoopEnd();

    expect(await watch.outcome).toBe("written");
    await expect(watch.over).resolves.toBeUndefined();
  });

  it("与我无关的那一批收口不算我的收口", async () => {
    const guard = new HandoffGuardPlugin();
    const watch = guard.arm(HANDOFF, CWD);
    let overYet = false;
    void watch.over.then(() => (overYet = true));

    // 这一批里没有交接那条指令（别人的话）
    guard.onOuterLoopStart({ agent: {}, entries: [{ priority: "low", source: { kind: "user" } }] } as any);
    guard.onOuterLoopEnd();
    await Promise.resolve();

    expect(overYet).toBe(false);
    expect(guard.armed).toBe(true);
  });

  it("用户按了中断 → 被中断；关门 / 硬杀 → 段没了", async () => {
    const paused = new HandoffGuardPlugin();
    const pausedWatch = paused.arm(HANDOFF, CWD);
    paused.onOutputPaused();
    expect(await pausedWatch.outcome).toBe("interrupted");

    const stopped = new HandoffGuardPlugin();
    const stoppedWatch = stopped.arm(HANDOFF, CWD);
    stopped.onStop();
    expect(await stoppedWatch.outcome).toBe("gone");

    const killed = new HandoffGuardPlugin();
    const killedWatch = killed.arm(HANDOFF, CWD);
    killed.onKill();
    expect(await killedWatch.outcome).toBe("gone");
  });

  it("上一趟的结论不留给下一趟", async () => {
    const guard = new HandoffGuardPlugin();
    const first = guard.arm(HANDOFF, CWD);
    guard.onToolEnd(toolEnd("write", { path: HANDOFF }));
    expect(await first.outcome).toBe("written");

    // 再问一次：新的观察点，结论得重新来
    const second = guard.arm(HANDOFF, CWD);
    guard.onOuterLoopStart({ agent: {}, entries: [handoffEntry()] } as any);
    guard.onOuterLoopEnd();
    expect(await second.outcome).toBe("missing");
  });

  it("disarm 之后还在等的两件承诺都能落定（没人该永远等）", async () => {
    const guard = new HandoffGuardPlugin();
    const watch = guard.arm(HANDOFF, CWD);

    guard.disarm();

    expect(await watch.outcome).toBe("missing");
    await expect(watch.over).resolves.toBeUndefined();
    expect(guard.armed).toBe(false);
  });

  it("不在交接里时 onToolEnd 不看任何结果", async () => {
    const guard = new HandoffGuardPlugin();
    const watch = guard.arm(HANDOFF, CWD);
    guard.disarm();

    // 收摊之后再来的结果不该改结论
    guard.onToolEnd(toolEnd("write", { path: HANDOFF }));

    expect(await watch.outcome).toBe("missing");
  });
});
