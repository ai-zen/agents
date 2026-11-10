/**
 * `SessionStream` 的用例：**纯状态机**，不起 daemon、不开 socket、不装假时钟。
 *
 * 这一组用例的存在理由就是「它可以是纯的」：CLI 那份状态机（`remote-chat-session.test.ts`）
 * 只能靠「真 socket + 真 Daemon + 逐帧驱动假 Agent」来验，于是一个竞态要摆一条链路才能看出
 * 对不对，而且验不到「快照比本地短」这种凑不出来的时序。搬进包之后，这些断言全是
 * 「喂几个事件，看状态」。
 *
 * 从 CLI 搬来的那几条在 `it` 的注释里标了出处（`remote-chat-session.test.ts` 的用例名），
 * 搬的是**断言**，不是测试脚手架：那边需要 daemon 的部分留在 `channel.test.ts`。
 */

import { describe, expect, it } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import type {
  Message,
  SessionSnapshotResult,
  SubAgentSnapshotResult,
} from "@ai-zen/agents-protocol";
import { SessionStream, type SessionStreamState } from "./stream.js";

// 造数据用**真的** `AgentNS.Role`（不是字面量镜像）：包里的 `ROLE` 是它的同值镜像，
// 两处一起把这个值钉死 —— 镜像写错的那天，这里先红
const user = (content: string): Message =>
  ({ id: `m-${content}`, role: AgentNS.Role.User, content }) as Message;
const assistant = (content: string, extra: Partial<Message> = {}): Message =>
  ({ id: `m-${content}`, role: AgentNS.Role.Assistant, content, ...extra }) as Message;
const tool = (content: string, toolCallId = "call_1"): Message =>
  ({
    id: `m-${content}`,
    role: AgentNS.Role.Tool,
    tool_call_id: toolCallId,
    content,
  }) as Message;

/** 一份快照（只填状态机真读的那几位；其余给合法值，免得漏字段时看不出是哪份数据的问题） */
function snapshotOf(
  messages: Message[],
  extra: Partial<SessionSnapshotResult> = {},
): SessionSnapshotResult {
  return {
    sessionId: "chat_1",
    workspaceId: "ws_1",
    agentId: "default",
    modelId: "test-model",
    modelLevel: "agent",
    apiModel: "test-model",
    turnId: 1,
    phase: null,
    messages,
    ...extra,
  };
}

function subAgentSnapshotOf(
  messages: Message[],
  extra: Partial<SubAgentSnapshotResult> = {},
): SubAgentSnapshotResult {
  return { subAgentId: "s1", index: 1, status: "running", messages, ...extra };
}

/** 造一台状态机并把它推进到「第二轮在飞」 */
function streaming(): SessionStream {
  const stream = new SessionStream({ sessionId: "chat_1" });
  stream.beginTurn(1);
  return stream;
}

describe("SessionStream：正文增量与收尾对账", () => {
  it("增量累积在**一条**临时消息上，屏幕能一路滚起来", () => {
    // 出自 remote-chat-session.test.ts「send 的语义与进程内一致」：生成中就能读到临时拼出来的正文
    const stream = streaming();
    stream.setPhase({ kind: "streaming" });

    stream.applyDelta({ text: "答" });
    stream.applyDelta({ text: "完", reasoning: "想" });

    expect(stream.state.messages).toEqual([
      { role: AgentNS.Role.Assistant, content: "答完", reasoning_content: "想" },
    ]);
    expect(stream.state.status).toBe("streaming");
    expect(stream.state.turnId).toBe(1);
    expect(stream.state.phase).toEqual({ kind: "streaming" });
  });

  it("turn.end 用服务端快照整份对账：服务端有、本地拼不出来的字段都补上", () => {
    // 出自同一条用例：「收尾后是服务端那份权威消息（连 reasoning_content 都在），不是本地拼的近似」
    const stream = streaming();
    stream.applyDelta({ text: "答完了" });

    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    stream.settle(
      snapshotOf([user("你好"), assistant("答完了", { reasoning_content: "想一想", usage })], {
        turnId: 1,
        modelId: "alt-model",
        modelLevel: "session",
        // 实发名与配置里的身份可以不同（别名）；参数覆盖与它的档位由同一次解析给出
        apiModel: "vendor/alt-model",
        modelParams: { thinking: { type: "disabled" } },
        modelParamsLevel: "session",
        lastUsage: usage,
      }),
    );

    expect(stream.state.messages).toEqual([
      { id: "m-你好", role: AgentNS.Role.User, content: "你好" },
      {
        id: "m-答完了",
        role: AgentNS.Role.Assistant,
        content: "答完了",
        reasoning_content: "想一想",
        usage,
      },
    ]);
    // 收尾之后：不在飞了、阶段回到空闲、模型跟着服务端那份走
    expect(stream.state.turnId).toBeNull();
    expect(stream.state.phase).toBeNull();
    expect(stream.state.status).toBe("idle");
    expect(stream.state.modelId).toBe("alt-model");
    expect(stream.state.modelLevel).toBe("session");
    // 实发模型名与参数覆盖必须一并带上：缺 `apiModel` 会把带图提交静默降级成纯文本，
    // 缺 `modelParams` 则桌面端的「思考强度」只能自己反推一遍优先级
    expect(stream.state.apiModel).toBe("vendor/alt-model");
    expect(stream.state.modelParams).toEqual({ thinking: { type: "disabled" } });
    expect(stream.state.modelParamsLevel).toBe("session");
    expect(stream.state.lastUsage).toEqual(usage);
  });

  it("快照比本地短：**不吞字**（本地的正文更长时取本地那份）", () => {
    // 竞态：快照是「请求处理那一刻」的副本，之后到达的增量只存在于本地 —— 整份覆盖会让
    // 屏幕上的答案凭空短一截，而且本轮不会再补上
    const stream = streaming();
    stream.applyDelta({ text: "答完了一" });
    stream.applyDelta({ text: "半" });

    stream.settle(snapshotOf([user("你好"), assistant("答完了一")]));

    expect(stream.state.messages).toHaveLength(2);
    expect(stream.state.messages[1]!.content).toBe("答完了一半");
  });

  it("服务端那份是唯一真相：本地拼不出的工具结果随快照一起上屏", () => {
    const stream = streaming();
    stream.applyDelta({ text: "我查一下" });

    stream.settle(
      snapshotOf([
        user("你好"),
        assistant("我查一下", { tool_calls: [{ type: "function" }] }),
        tool("结果是 42"),
      ]),
    );

    expect(stream.state.messages.map((message) => message.role)).toEqual([
      AgentNS.Role.User,
      AgentNS.Role.Assistant,
      AgentNS.Role.Tool,
    ]);
  });

  it("取不到快照（服务端刚重启）也照样收尾：本地那份近似留着，不假装这一轮还在跑", () => {
    const stream = streaming();
    stream.applyDelta({ text: "半句" });

    stream.settle(null);

    expect(stream.state.messages).toHaveLength(1);
    expect(stream.state.turnId).toBeNull();
    expect(stream.state.status).toBe("idle");
  });

  it("只带用量的收尾 chunk 不会在转录里留下空 assistant", () => {
    // 出自 remote-chat-session.test.ts「流末只带 usage 的 chunk 不会在转录里留下空 assistant」
    const stream = streaming();
    stream.applyDelta({ text: "答案" });
    // 只带 usage（正文与推理都是空串）：校准速率要用它，但**不该**拼进正文
    stream.applyDelta({ text: "", reasoning: "" });
    stream.applyDelta({});

    expect(stream.state.messages).toHaveLength(1);
    expect(stream.state.messages[0]!.content).toBe("答案");
  });
});

describe("SessionStream：工具调用与工具结果", () => {
  it("工具调用的组装态是**整份替换**，落在正在流式的那条消息上", () => {
    const stream = streaming();

    // 第一次上报：参数只到半截（可能还不是合法 JSON）
    stream.applyToolCalls([{ index: 0, name: "exec", arguments: '{"cmd"' }]);
    // 同一个调用在长大：客户端按 index 就地更新，不往后追加（追加会把参数拼成两遍）
    stream.applyToolCalls([{ index: 0, id: "call_1", name: "exec", arguments: '{"cmd":"ls"}' }]);

    expect(stream.state.messages).toHaveLength(1);
    expect(stream.state.messages[0]!.tool_calls).toEqual([
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "exec", arguments: '{"cmd":"ls"}' },
      },
    ]);

    // 之后的正文拼在**同一条**上（工具调用是这条响应的一部分，不是另一条消息）
    stream.applyDelta({ text: "好" });
    expect(stream.state.messages).toHaveLength(1);
    expect(stream.state.messages[0]!.content).toBe("好");
    expect(stream.state.messages[0]!.tool_calls).toHaveLength(1);
  });

  it("已经定型的工具结果原样上屏；同一 tool_call_id 重复投递不会出现两条", () => {
    const stream = streaming();
    const result = tool("结果是 42");

    stream.applyMessageAppended(result);
    stream.applyMessageAppended(result);

    expect(stream.state.messages).toEqual([result]);
  });
});

describe("SessionStream：子 Agent 栏目", () => {
  it("started 给出 index / id；增量落在它自己的对话里，主会话一个字都不多", () => {
    // 出自 remote-chat-session.test.ts「子 Agent 栏目」那组用例（原本要靠真 socket 驱动）
    const stream = streaming();
    stream.subAgentStarted({ subAgentId: "s1", index: 1 });

    expect(stream.state.subAgents).toEqual([
      { id: "s1", index: 1, messages: [], status: "running" },
    ]);

    stream.subAgentDelta({ subAgentId: "s1", text: "数到" });
    stream.subAgentDelta({ subAgentId: "s1", text: "3 个" });

    expect(stream.state.subAgents[0]!.messages[0]!.content).toBe("数到3 个");
    // 子 Agent 的增量不进主会话（拼进去等于凭空多出一段文字）
    expect(stream.state.messages).toEqual([]);
  });

  it("没有 started 就没有这一栏（`index` 是服务端给的，客户端编不出来）", () => {
    const stream = streaming();
    stream.subAgentDelta({ subAgentId: "s404", text: "没人认领的字" });

    expect(stream.state.subAgents).toEqual([]);
  });

  it("快照把已有内容补齐，且与已拼出的增量合并（不吞字、不多出一条）", () => {
    // 出自「started 给出 index / id：标签按服务端编号出现，快照把已有消息填上」
    const stream = streaming();
    stream.subAgentStarted({ subAgentId: "s1", index: 1 });
    stream.subAgentDelta({ subAgentId: "s1", text: "数到" });

    // 这次往返可能比第一批增量还慢：服务端那份末尾是「数到」，本地已经有「数到」
    stream.subAgentSnapshot(subAgentSnapshotOf([user("子任务：数文件"), assistant("数到")]));

    expect(stream.state.subAgents[0]!.messages).toHaveLength(2);
    expect(stream.state.subAgents[0]!.messages[1]!.content).toBe("数到");

    // 之后的增量继续拼在**同一条**上
    stream.subAgentDelta({ subAgentId: "s1", text: "3 个" });
    expect(stream.state.subAgents[0]!.messages).toHaveLength(2);
    expect(stream.state.subAgents[0]!.messages[1]!.content).toBe("数到3 个");
  });

  it("ended 把状态改成 done；`failed` 不会被随后的 done 擦成成功", () => {
    // 出自「ended 把状态改成 done；failed 不会被随后的 done 覆盖」：
    // core 的 `onSubAgentEnd` 在 finally 里分发，出错的那次也照样会来一条结束事件
    const stream = streaming();
    stream.subAgentStarted({ subAgentId: "s1", index: 1 });
    stream.subAgentStarted({ subAgentId: "s2", index: 2 });

    stream.subAgentEnded({ subAgentId: "s1", status: "done" });
    stream.subAgentEnded({ subAgentId: "s2", status: "failed" });
    stream.subAgentEnded({ subAgentId: "s2", status: "done" });

    expect(stream.state.subAgents.map((view) => view.status)).toEqual(["done", "failed"]);
  });

  it("只活当前一轮：turn.end 清空栏目（与进程内实现的 `finally` 等价）", () => {
    // 出自「只活当前一轮：turn.end 清空列表」
    const stream = streaming();
    stream.subAgentStarted({ subAgentId: "s1", index: 1 });
    stream.subAgentDelta({ subAgentId: "s1", text: "跑到一半" });

    stream.settle(snapshotOf([user("统计一下")]));

    expect(stream.state.subAgents).toEqual([]);
  });

  it("重复的 started 不会多出一个空栏目（重连之后事件可能被重放）", () => {
    const stream = streaming();
    stream.subAgentStarted({ subAgentId: "s1", index: 1 });
    stream.subAgentStarted({ subAgentId: "s1", index: 1 });

    expect(stream.state.subAgents).toHaveLength(1);
  });
});

describe("SessionStream：换 id", () => {
  it("idChanged 只换 id 与清栏目，**不动**在飞的那一轮（迁移发生在一轮内部）", () => {
    // 出自「服务端在一轮内部换 id（自动迁移）」：不跟着换就会在旧 id 上等一个永远不到的 turn.end
    const stream = streaming();
    stream.setPhase({ kind: "streaming" });
    stream.subAgentStarted({ subAgentId: "s1", index: 1 });

    stream.applyIdChanged("chat_2");

    expect(stream.state.sessionId).toBe("chat_2");
    expect(stream.state.subAgents).toEqual([]);
    // 这一轮的 turn.end 会从新 id 上来：丢失 turnId / status 就等于再也等不到它
    expect(stream.state.turnId).toBe(1);
    expect(stream.state.status).toBe("streaming");
    expect(stream.state.phase).toEqual({ kind: "streaming" });
  });
});

describe("SessionStream：失败是终态", () => {
  it("failTurn 之后 settle 不许把它擦成 idle（消息照样对账）", () => {
    const stream = streaming();
    stream.applyDelta({ text: "半句" });

    stream.failTurn({ code: "internal", message: "boom" });
    expect(stream.state.status).toBe("failed");
    expect(stream.state.turnId).toBeNull();
    // 已经流出来的字留着：跑到一半断掉不等于没跑过
    expect(stream.state.messages[0]!.content).toBe("半句");

    stream.settle(snapshotOf([user("问"), assistant("完整答案")]));

    expect(stream.state.status).toBe("failed");
    expect(stream.state.failure).toEqual({ code: "internal", message: "boom" });
    // 但快照仍然是权威：消息与阶段都对齐了
    expect(stream.state.messages).toHaveLength(2);
    expect(stream.state.phase).toBeNull();
  });

  it("新一轮开始才复位；换基线（首屏 / 重连对齐）也复位", () => {
    const stream = streaming();
    stream.failTurn({ code: "internal", message: "boom" });

    stream.beginTurn(2);
    expect(stream.state.status).toBe("streaming");
    expect(stream.state.failure).toBeUndefined();

    stream.failTurn({ code: "internal", message: "boom again" });
    stream.applySnapshot(snapshotOf([user("新基线")], { sessionId: "chat_2" }));
    expect(stream.state.status).toBe("idle");
    expect(stream.state.failure).toBeUndefined();
    expect(stream.state.sessionId).toBe("chat_2");
  });
});

describe("SessionStream：重连对齐（applySnapshot）", () => {
  it("一轮跑到一半断线重连：已拼出的正文留在**同一条**消息上，后续增量接着拼", () => {
    // CLI 那份实现在这里有一处静默丢字：`applySnapshot` 把消息整份换掉，而拼接态还指着
    // 已经被换下去的那条消息对象 —— 之后的增量全写在一个不在列表里的对象上，
    // 屏幕要等到 turn.end 才补回来。合并规则让它们收敛回同一条。
    const stream = streaming();
    stream.applyDelta({ text: "一半" });

    stream.applySnapshot(snapshotOf([user("问"), assistant("")], { turnId: 1 }));

    expect(stream.state.messages).toHaveLength(2);
    expect(stream.state.messages[1]!.content).toBe("一半");
    // 服务端还在跑：状态仍是「在飞」
    expect(stream.state.status).toBe("streaming");
    expect(stream.state.turnId).toBe(1);

    stream.applyDelta({ text: "继续" });

    expect(stream.state.messages).toHaveLength(2);
    expect(stream.state.messages[1]!.content).toBe("一半继续");
  });

  /**
   * 早退分支（`mergeStreamedSnapshot` 在「本地正文与推理都为空」时原样返回快照）之后，
   * 拼接态的那条临时消息**不在**返回的消息列表里 —— 调用方不能拿「列表长度 - 1」当它的下标。
   *
   * 这条路径是真实可达的：`session.toolCalls` 会建立一条**正文为空**的流式态（工具调用是
   * 这条响应的一部分，正文还没开始），此时断线重连、服务端还在跑（`phase !== null`），
   * 下一片正文到达就会写到「服务端最后一条」上 —— 而那一条往往是**工具结果**。
   */
  it("工具调用组装期间重连：服务端最后一条是工具结果 → 增量后该消息仍是 tool，新正文进新的一条 assistant", () => {
    const stream = streaming();
    // 工具调用组装中：拼接态只有 tool_calls，正文与推理都是空串（= 早退分支的入口）
    stream.applyToolCalls([{ index: 0, id: "call_1", name: "exec", arguments: '{"cmd":"ls"}' }]);

    // 断线重连：服务端还在跑（phase 非空），最后一条是刚定型的工具结果
    stream.applySnapshot(
      snapshotOf(
        [user("列一下"), assistant("", { tool_calls: [{ type: "function" }] }), tool("结果是 42")],
        {
          turnId: 1,
          phase: { kind: "streaming" },
        },
      ),
    );

    // 服务端还在跑的下一片正文
    stream.applyDelta({ text: "继续" });

    expect(stream.state.messages.map((message) => message.role)).toEqual([
      AgentNS.Role.User,
      AgentNS.Role.Assistant,
      AgentNS.Role.Tool,
      AgentNS.Role.Assistant,
    ]);
    // 工具结果一个字都不许被改：它被改写的症状是「工具跑完了，结果静默消失」
    expect(stream.state.messages[2]!.content).toBe("结果是 42");
    expect(stream.state.messages[2]!.tool_call_id).toBe("call_1");
    // 新正文进**新的一条** assistant
    expect(stream.state.messages[3]!.content).toBe("继续");
  });

  it("早退分支之后下一片增量新建一条 assistant，而不是复用旧拼接态", () => {
    const stream = streaming();
    // 空正文的拼接态（工具调用组装期间），随后重连拿到一份快照
    stream.applyToolCalls([{ index: 0, name: "exec", arguments: "{}" }]);
    stream.applySnapshot(snapshotOf([user("问")], { turnId: 1, phase: { kind: "streaming" } }));

    stream.applyDelta({ text: "新" });

    // 旧拼接态（正文空）没有可续的内容：丢弃它，增量另起一条
    expect(stream.state.messages).toHaveLength(2);
    expect(stream.state.messages[0]).toEqual(user("问")); // 快照里那条一个字都没被改写
    expect(stream.state.messages[1]).toEqual({ role: AgentNS.Role.Assistant, content: "新" });
    // 尤其不能把旧拼接态上的 `tool_calls` 带过来（那条组装态已经作废了）
    expect(stream.state.messages[1]!.tool_calls).toBeUndefined();
  });

  it("子 Agent 栏目在换基线时清掉（那些事件全丢在旧连接上了）", () => {
    const stream = streaming();
    stream.subAgentStarted({ subAgentId: "s1", index: 1 });

    stream.applySnapshot(snapshotOf([user("问")], { turnId: 1 }));

    expect(stream.state.subAgents).toEqual([]);
  });

  it("换基线时模型四件（含实发名与参数覆盖）一并透传；快照没给参数就清掉", () => {
    // 上一轮的参数覆盖不能带到新基线上：快照说「没有」就是没有
    const stream = new SessionStream({
      sessionId: "chat_1",
      modelId: "old-model",
      modelLevel: "agent",
    });
    stream.applySnapshot(
      snapshotOf([user("问")], {
        apiModel: "vendor/test-model",
        modelParams: { reasoning_effort: "high" },
        modelParamsLevel: "agent",
      }),
    );

    expect(stream.state.apiModel).toBe("vendor/test-model");
    expect(stream.state.modelParams).toEqual({ reasoning_effort: "high" });
    expect(stream.state.modelParamsLevel).toBe("agent");

    // 换到全局兜底那一级：那一级没有放参数覆盖的地方，快照就不给
    stream.applySnapshot(snapshotOf([user("问")], { modelLevel: "global" }));

    expect(stream.state.modelLevel).toBe("global");
    expect(stream.state.modelParams).toBeUndefined();
    expect(stream.state.modelParamsLevel).toBeUndefined();
  });
});

describe("SessionStream：用量口径", () => {
  it("totalUsage 把工具消息上的 subAgentUsage 一起累加（子 Agent 的消耗不漏算）", () => {
    // 出自 remote-chat-session.test.ts「totalUsage 会把工具消息上的 subAgentUsage 一起累加」：
    // 期望值与 core 的 `sumUsage` 逐字相同 —— 包里那份是它的口径镜像（不能 import 它的运行期值）
    const stream = streaming();
    stream.settle(
      snapshotOf([
        assistant("主 Agent 的一句话", {
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        {
          id: "m-tool",
          role: AgentNS.Role.Tool,
          tool_call_id: "t1",
          content: "委派结果",
          subAgentUsage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        } as Message,
      ]),
    );

    expect(stream.state.totalUsage).toEqual({
      prompt_tokens: 110,
      completion_tokens: 25,
      total_tokens: 135,
    });
  });
});

describe("SessionStream：变更通知", () => {
  it("每次真的变了才通知，且交出来的是**新对象**（前端靠引用比较决定要不要重画）", () => {
    const stream = streaming();
    const seen: SessionStreamState[] = [];
    const off = stream.onChange((state) => seen.push(state));

    stream.setPhase({ kind: "queued" });
    const before = stream.state;
    // 空增量不是变更：不该通知（否则每片 usage chunk 都要重画一次屏）
    stream.applyDelta({ text: "" });
    expect(stream.state).toBe(before);

    stream.applyDelta({ text: "字" });
    expect(seen.length).toBe(2);
    expect(seen.at(-1)).toBe(stream.state);
    expect(seen[0]).not.toBe(seen[1]);

    off();
    stream.applyDelta({ text: "还有" });
    expect(seen.length).toBe(2);
  });
});
