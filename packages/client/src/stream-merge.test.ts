/**
 * `mergeStreamedSnapshot` 的用例：快照与本地增量合并的三条规则，逐条钉住。
 *
 * 为什么这些用例住在共享包：规则本身住在这里，两个前端（CLI 的 TUI、桌面端）行为一致的前提
 * 就是这份实现被同一批用例管着。原先这套断言只存在于 CLI 里，桌面端接入时无从检验。
 *
 * 为什么不用 `vi.mock` / 真 socket：要钉的是「快照比第一批增量还慢」这种时序，而它在真链路上
 * 复现不了（要凑时序）—— 纯函数直接喂「快照那一刻的消息列表 + 本地拼到一半的状态」，断言
 * 「回来的是什么」。这里没有文件系统、没有进程级全局，因此也不需要 `AI_ZEN_DIR`。
 */

import { describe, expect, it } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { mergeStreamedSnapshot, type StreamedAssistant } from "./stream-merge.js";

describe("流式增量与服务端快照的合并（竞态）", () => {
  const assistant = (content: string) =>
    ({ role: AgentNS.Role.Assistant, content }) as unknown as AgentNS.Message;
  const user = (content: string) =>
    ({ role: AgentNS.Role.User, content }) as unknown as AgentNS.Message;
  const tool = (content: string) =>
    ({ role: AgentNS.Role.Tool, tool_call_id: "t1", content }) as unknown as AgentNS.Message;
  /** 本地已经拼出来的那条临时消息（就是调用方逐帧累积的那个状态） */
  const streamOf = (text: string, reasoning = ""): StreamedAssistant => {
    const message = assistant(text);
    if (reasoning) message.reasoning_content = reasoning;
    return { message, text, reasoning };
  };

  it("本地还没有增量：结果就是快照（开始时最常见）", () => {
    const snapshot = [user("任务")];
    const merged = mergeStreamedSnapshot(snapshot, null);

    expect(merged.messages).toEqual(snapshot);
    expect(merged.stream).toBeNull();
  });

  it("增量为空（一个字都没到）：stream 原样返回，不判成「有内容」", () => {
    // 防的是「把空增量当增量」：那样会给一段还没开始的内容凭空追加一条空 assistant 消息
    const snapshot = [user("任务")];
    const stream = streamOf("");
    const merged = mergeStreamedSnapshot(snapshot, stream);

    expect(merged.messages).toEqual(snapshot);
    expect(merged.stream).toBe(stream);
  });

  it("只有推理没有正文：不算「没有增量」，推理内容照样要落到消息上", () => {
    // 防的是把判空条件从 `!text && !reasoning` 写成 `!text`：推理模型的「想」会被整段吞掉
    const snapshot = [user("任务"), assistant("")];
    const merged = mergeStreamedSnapshot(snapshot, streamOf("", "想"));

    expect(merged.messages).toHaveLength(2);
    expect(merged.messages[1]!.reasoning_content).toBe("想");
    expect(merged.stream).not.toBeNull();
    // 之后的正文明明还没到，也得继续拼在**同一条**上
    expect(merged.stream!.message).toBe(merged.messages[1]);
  });

  it("快照晚于第一批增量：已经拼出来的正文不丢，也不多出一条", () => {
    // 服务端那份里是**空占位**（core 在开始流式前就把 assistant 消息 append 进了 messages），
    // 本地已经拼出半句「答」—— 无脑覆盖就会把这半句摸掉
    const snapshot = [user("任务"), assistant("")];
    const merged = mergeStreamedSnapshot(snapshot, streamOf("答", "想"));

    expect(merged.messages).toHaveLength(2);
    expect(merged.messages[1]!.content).toBe("答");
    expect(merged.messages[1]!.reasoning_content).toBe("想");
    // 之后的增量继续拼在**同一条**上（否则屏幕上会凭空多出一条消息）
    expect(merged.stream!.message).toBe(merged.messages[1]);
  });

  it("快照那份比本地旧：取信息多的那份（本地只多不少）", () => {
    const snapshot = [user("任务"), assistant("答")];
    const merged = mergeStreamedSnapshot(snapshot, streamOf("答完了"));

    expect(merged.messages).toHaveLength(2);
    expect(merged.messages[1]!.content).toBe("答完了");
    // 反向的那一支（本地是快照的**后缀**）：同一段，后续增量接着拼在这一条上
    expect(merged.stream!.message).toBe(merged.messages[1]);
    expect(merged.stream!.text).toBe("答完了");
  });

  it("快照那份比本地新：本地只是它的一段前缀 → 取快照那条，不许多出一条「答」", () => {
    // 规则 2 原先只覆盖「本地更全」那个方向。反方向（本地拼到「答」，而快照里已经是
    // 「答完了」：这期间增量没被本地收到 —— 重连、或快照请求比增量晚回来但服务端更快）
    // 会同时不命中规则 2 与规则 3 的任何一分支，落到「宁可重复也不吞字」的兜底上，
    // 于是屏幕上末尾多出一条内容为「答」的 assistant 消息。
    const snapshot = [user("任务"), assistant("答完了")];
    const merged = mergeStreamedSnapshot(snapshot, streamOf("答"));

    expect(merged.messages).toHaveLength(2);
    expect(merged.messages[1]!.content).toBe("答完了");
    // 本地那半句是**过时的前缀**（它的每个字都在快照里），丢掉不会丢内容
    expect(merged.stream!.message).toBe(merged.messages[1]);
    expect(merged.stream!.text).toBe("答完了");
  });

  it("规则 2 的两个方向互相对称：谁更全就留谁，两个方向都只有一条 assistant", () => {
    // 两条用例各自钉住一支，这一条钉的是「两支的判断条件真的是同一条前缀关系」——
    // 只补一支时它必红（另一支会多出一条消息）。
    for (const [local, tail] of [
      ["答完了", "答"],
      ["答", "答完了"],
    ] as const) {
      const merged = mergeStreamedSnapshot([user("任务"), assistant(tail)], streamOf(local));
      expect(merged.messages).toHaveLength(2);
      expect(merged.messages[1]!.content).toBe("答完了");
    }
  });

  it("服务端已经收下这段（当前没有在流的 assistant）：不重复追加", () => {
    // 本地累计的「先想」已经在快照里了，而快照末尾是工具结果（下一段还没开始）
    const merged = mergeStreamedSnapshot(
      [user("任务"), assistant("先想"), tool("结果")],
      streamOf("先想"),
    );

    expect(merged.messages).toHaveLength(3);
    // 临时消息丢掉：之后的增量重新起一条（否则会接在已收尾的旧消息后面）
    expect(merged.stream).toBeNull();
  });

  it("快照之后才开的新一段：只接上多出来的尾巴", () => {
    const merged = mergeStreamedSnapshot(
      [user("任务"), assistant("先想"), tool("结果")],
      streamOf("先想结论"),
    );

    expect(merged.messages).toHaveLength(4);
    expect(merged.messages[3]!.content).toBe("结论");
    expect(merged.stream!.message).toBe(merged.messages[3]);
  });

  it("对不上任何一段时宁重不丢：整段追加，不静默吞字", () => {
    const merged = mergeStreamedSnapshot(
      [user("任务"), assistant("旧内容"), tool("结果")],
      streamOf("新内容"),
    );

    expect(merged.messages).toHaveLength(4);
    expect(merged.messages[3]!.content).toBe("新内容");
  });

  it("规则 2 只认快照末尾那一条：末尾是工具结果时只接尾巴，不动前面那一段", () => {
    // 防的是「拿任意一条 assistant 当前缀就整份替换」：那会把已经收尾的上一段改写，
    // 屏幕上刚滚过去的答案会跟着变一次
    const merged = mergeStreamedSnapshot(
      [user("任务"), assistant("先想"), tool("结果")],
      streamOf("先想了"),
    );

    expect(merged.messages).toHaveLength(4);
    expect(merged.messages[1]!.content).toBe("先想");
    expect(merged.messages[3]!.content).toBe("了");
  });
});
