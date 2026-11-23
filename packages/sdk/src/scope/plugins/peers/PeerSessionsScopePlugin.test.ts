/**
 * PeerSession 插件（SDK 侧）的验收：**不给端口就不产出任何工具**，给了端口就三个工具，
 * 而且三个工具只做三件事 —— 把参数送给端口、把结构化拒绝原样交回模型、把「别轮询（她会自己
 * post_message 回来）/ 不等结果 / 靠 label」这几句话写进 description 与返回文案。
 *
 * 会话怎么建、那一格怎么现读全在宿主那一侧（`PeerSessionService`），本文件不重复验那些。
 */

import { describe, expect, it } from "vitest";
import type { Agent, ToolCallContext } from "@ai-zen/agents-core";
import { CallbackTool } from "@ai-zen/agents-core";

import { PeerSessionsScopePlugin } from "./PeerSessionsScopePlugin.js";
import {
  CREATE_SESSION_TOOL,
  createPeerSessionTools,
  PEER_SESSION_TOOL_NAMES,
  POST_MESSAGE_TOOL,
  READ_SESSION_STATUS_TOOL,
} from "./peerSessionTools.js";
import type {
  PeerSessionCreateInput,
  PeerSessionCreated,
  PeerSessionPort,
  PeerSessionPostInput,
  PeerSessionPosted,
  PeerSessionStatus,
  PeerSessionActivity,
} from "./peerSessionTools.js";
import type { FilterOutput, Scope } from "../../Scope.js";

/** 插件用不到 Scope 的任何东西（它不发现、不读配置），给一个占位就够 */
const fakeScope = {} as unknown as Scope;

/** 工具的第二个参数：本插件只摸 `agent`，其余字段用例不碰 */
const fakeAgent = { id: "agent-1" } as unknown as Agent;

function contextFor(agent: Agent = fakeAgent): ToolCallContext {
  return { agent } as unknown as ToolCallContext;
}

function filteredWith(tools: string[]): FilterOutput {
  return { tools, subagents: [], skills: [], mcps: [] };
}

/** 记账式端口：把每一次调用与参数记下来，答案由用例给 */
function recordingPort(answers: {
  created?: PeerSessionCreated;
  status?: PeerSessionStatus;
  sent?: PeerSessionPosted;
}): {
  port: PeerSessionPort;
  creates: PeerSessionCreateInput[];
  statuses: Array<{ caller: Agent; sessionId: string }>;
  sends: PeerSessionPostInput[];
} {
  const creates: PeerSessionCreateInput[] = [];
  const statuses: Array<{ caller: Agent; sessionId: string }> = [];
  const sends: PeerSessionPostInput[] = [];
  const port: PeerSessionPort = {
    async create(input) {
      creates.push(input);
      return answers.created ?? { ok: true, sessionId: "session-1", label: "会话 1" };
    },
    async status(input) {
      statuses.push(input);
      // 默认答案照着 `PeerSessionStatus` 那两支里的「有这一段」写：忙不忙只有 `working` / `idle`
      // 两格，死活是同一条答复里另给的 `alive`。
      return (
        answers.status ?? {
          found: true,
          status: "working",
          alive: true,
          label: "会话 1",
          lastMessage: null,
        }
      );
    },
    async post(input) {
      sends.push(input);
      return answers.sent ?? { ok: true };
    },
  };
  return { port, creates, statuses, sends };
}

/** 直接调回调（绕过 core 的 tool_call 解析）：本插件关心的只有「参数 + ctx.agent」 */
async function call(
  tool: unknown,
  args: Record<string, unknown>,
  ctx: ToolCallContext = contextFor(),
): Promise<unknown> {
  const callback = (tool as CallbackTool).callback;
  if (!callback) throw new Error("tool has no callback");
  return await callback(args, ctx);
}

describe("PeerSessionsScopePlugin：端口决定能力面", () => {
  it("不给端口 → candidates 为空、instantiate 空数组（三个工具一个都不产出，老行为一个字不变）", () => {
    const plugin = new PeerSessionsScopePlugin();
    expect(plugin.candidates()).toEqual({});
    expect(plugin.instantiate(fakeScope, filteredWith([...PEER_SESSION_TOOL_NAMES]))).toEqual([]);
    // 连工具名单里也没有它们：没有端口的 SDK 用户一个也拿不到
    expect([...PEER_SESSION_TOOL_NAMES]).toEqual([
      CREATE_SESSION_TOOL,
      READ_SESSION_STATUS_TOOL,
      POST_MESSAGE_TOOL,
    ]);
  });

  it("给了端口 → 三个候选名，按权限过滤结果实例化", () => {
    const { port } = recordingPort({});
    const plugin = new PeerSessionsScopePlugin(port);

    expect(plugin.candidates()).toEqual({
      tools: [CREATE_SESSION_TOOL, READ_SESSION_STATUS_TOOL, POST_MESSAGE_TOOL],
    });

    const all = plugin.instantiate(fakeScope, filteredWith([...PEER_SESSION_TOOL_NAMES]));
    expect(all.map((tool) => tool.function.name)).toEqual([
      CREATE_SESSION_TOOL,
      READ_SESSION_STATUS_TOOL,
      POST_MESSAGE_TOOL,
    ]);

    // `Scope.filter` 只放行一个（权限白名单）→ 就只实例化那一个
    const onlyCreate = plugin.instantiate(fakeScope, filteredWith([CREATE_SESSION_TOOL]));
    expect(onlyCreate.map((tool) => tool.function.name)).toEqual([CREATE_SESSION_TOOL]);

    // 发消息那个也可以被单独放行
    const onlyPost = plugin.instantiate(fakeScope, filteredWith([POST_MESSAGE_TOOL]));
    expect(onlyPost.map((tool) => tool.function.name)).toEqual([POST_MESSAGE_TOOL]);

    // 一个都不放行 → 一个都不产出
    expect(plugin.instantiate(fakeScope, filteredWith([]))).toEqual([]);
  });

  it("插件 id 固定（装配处按它查）", () => {
    expect(new PeerSessionsScopePlugin().id).toBe("peer-sessions");
    expect(PeerSessionsScopePlugin.ID).toBe("peer-sessions");
  });

  it("发消息那个工具的名字是 `post_message`（`send_to_session` 不再存在）", () => {
    expect(POST_MESSAGE_TOOL).toBe("post_message");
    const names = [...PEER_SESSION_TOOL_NAMES] as string[];
    expect(names).not.toContain("send_to_session");
  });
});

describe("create_session：建完即回，参数原样交给端口", () => {
  it("返回 { sessionId, label }，并把调用方（ctx.agent）交给端口", async () => {
    const { port, creates } = recordingPort({});
    const [createTool] = createPeerSessionTools(port);

    const result = await call(createTool, {
      prompt: "把登录页的测试补齐",
      agentId: "reviewer",
      modelId: "m-1",
      label: "补测试",
    });

    expect(creates).toHaveLength(1);
    expect(creates[0]).toEqual({
      caller: fakeAgent,
      prompt: "把登录页的测试补齐",
      agentId: "reviewer",
      modelId: "m-1",
      label: "补测试",
    });
    expect(result).toMatchObject({ sessionId: "session-1", label: "会话 1" });
  });

  it("可选参数空串 / 非字符串当作没给（不往端口里塞假值）", async () => {
    const { port, creates } = recordingPort({});
    const [createTool] = createPeerSessionTools(port);

    await call(createTool, { prompt: "跑一下", agentId: "", modelId: 42, label: undefined });
    expect(creates[0]).toEqual({ caller: fakeAgent, prompt: "跑一下" });
  });

  it("description 与返回文案都写着「别轮询（她会自己 post_message 回来）」与「靠 label」", async () => {
    const { port } = recordingPort({});
    const [createTool] = createPeerSessionTools(port);

    const description = createTool.function.description ?? "";
    const lower = description.toLowerCase();
    expect(lower).toContain("do not poll");
    expect(description).toContain("post_message");
    expect(description).toContain("`label`");

    const result = (await call(createTool, { prompt: "x" })) as { hint: string };
    expect(result.hint.toLowerCase()).toContain("do not poll");
    expect(result.hint).toContain("post_message");
    expect(result.hint).toContain("label");
  });

  it("「只限一层」写在创建这一侧，并且说明它不是投递的限制", () => {
    const { port } = recordingPort({ created: { ok: false, reason: "depth_exceeded" } });
    const [createTool] = createPeerSessionTools(port);
    const description = createTool.function.description ?? "";
    expect(description).toContain("Creating is limited to one level");
    expect(description).toContain("posting a message is not limited that way");
  });

  it("结构化拒绝原样交回（模型能按字段分支，不靠读文本）", async () => {
    const depth = recordingPort({
      created: { ok: false, reason: "depth_exceeded", hint: "one level only" },
    });
    const [createTool] = createPeerSessionTools(depth.port);
    expect(await call(createTool, { prompt: "x" })).toEqual({
      rejected: "depth_exceeded",
      hint: "one level only",
    });

    const model = recordingPort({
      created: { ok: false, reason: "model_unresolved", hint: "pass modelId" },
    });
    const [otherTool] = createPeerSessionTools(model.port);
    expect(await call(otherTool, { prompt: "x" })).toEqual({
      rejected: "model_unresolved",
      hint: "pass modelId",
    });
  });

  it("并发满了也是结构化拒绝（too_many_peers，宿主不给 hint 时用插件自带的）", async () => {
    const h = recordingPort({ created: { ok: false, reason: "too_many_peers" } });
    const [createTool] = createPeerSessionTools(h.port);
    const result = (await call(createTool, { prompt: "x" })) as { rejected: string; hint: string };
    expect(result.rejected).toBe("too_many_peers");
    expect(result.hint).toContain("maximum number of peer sessions");
  });

  it("宿主没给 hint 时用插件自带的那一句（模型总能拿到下一步怎么做）", async () => {
    const { port } = recordingPort({ created: { ok: false, reason: "depth_exceeded" } });
    const [createTool] = createPeerSessionTools(port);
    const result = (await call(createTool, { prompt: "x" })) as { rejected: string; hint: string };
    expect(result.rejected).toBe("depth_exceeded");
    expect(result.hint).toContain("one level only");
  });
});

describe("post_message：只回「收下了」", () => {
  it("参数原样交给端口（caller 是 ctx.agent），回执只有 accepted 与 hint", async () => {
    const { port, sends } = recordingPort({});
    const [, , postTool] = createPeerSessionTools(port);

    const result = (await call(postTool, {
      sessionId: "session-1",
      content: "再补两个用例",
    })) as Record<string, unknown>;

    expect(sends).toEqual([{ caller: fakeAgent, sessionId: "session-1", content: "再补两个用例" }]);
    expect(result.accepted).toBe(true);
    // 回执里没有那一格（忙 / 闲 / 暂停）：「它现在什么情形」不是投递能定下的事实
    expect("state" in result).toBe(false);
    expect(typeof result.hint).toBe("string");
    expect(result.hint).toContain("does not come back");
    // 不写「不会自动推给我」那种对未来的断言（它与「她会自己 post_message 回来」打脸）：
    // 收下之后能说的只有「进了那边的 inbox」＋「别轮询」
    const hint = String(result.hint).toLowerCase();
    expect(hint).not.toContain("nothing is pushed");
    expect(hint).not.toContain("automatically");
    expect(hint).toContain("do not poll");
  });

  it("两种拒绝都是结构化返回（不抛错）：gone / dead 各带一句下一步", async () => {
    const gone = recordingPort({ sent: { ok: false, reason: "gone" } });
    const [, , goneTool] = createPeerSessionTools(gone.port);
    const goneResult = (await call(goneTool, { sessionId: "missing", content: "x" })) as {
      rejected: string;
      hint: string;
    };
    expect(goneResult.rejected).toBe("gone");
    expect(goneResult.hint).toContain("Nothing was sent");

    const dead = recordingPort({ sent: { ok: false, reason: "dead" } });
    const [, , deadTool] = createPeerSessionTools(dead.port);
    const deadResult = (await call(deadTool, { sessionId: "s", content: "x" })) as {
      rejected: string;
      hint: string;
    };
    expect(deadResult.rejected).toBe("dead");
    expect(deadResult.hint).toContain("no agent behind it");
  });

  it("description 写着「投递不看关系」与「别轮询」，参数不合法时不往端口里塞假值", async () => {
    const { port, sends } = recordingPort({});
    const [, , postTool] = createPeerSessionTools(port);

    const description = postTool.function.description ?? "";
    expect(description).toContain("does not depend on how the two of us are related");
    expect(description).toContain("Do not poll");
    // 描述里不含「把结果投回来」这类对未来的断言
    expect(description.toLowerCase()).not.toContain("pushed back to me");

    await call(postTool, { sessionId: 42, content: 7 });
    expect(sends[0]).toEqual({ caller: fakeAgent, sessionId: "", content: "7" });
  });
});

describe("read_session_status：忙不忙 + 死活 + 「没有这一段」，只给「忙不忙 + 最近一句摘要」", () => {
  it("PeerSessionStatus 两种形状各自成立（判别式，编译期与运行期都钉住）", () => {
    // 编译期：这两支都是合法形状，`status` 在找不到那一支只能是 null；
    // 找到那一支必有 `alive` 与 `lastMessage`，没有消息数组、没有 startedAt
    const found: PeerSessionStatus = {
      found: true,
      status: "working",
      alive: true,
      label: "会话 1",
      lastMessage: "先看看登录页",
    };
    const empty: PeerSessionStatus = {
      found: true,
      status: "idle",
      alive: true,
      label: "会话 2",
      lastMessage: null,
    };
    const gone: PeerSessionStatus = {
      found: true,
      status: "idle",
      alive: false,
      label: "会话 3",
      lastMessage: null,
    };
    const notFound: PeerSessionStatus = { found: false, status: null };

    expect(found).toEqual({
      found: true,
      status: "working",
      alive: true,
      label: "会话 1",
      lastMessage: "先看看登录页",
    });
    expect(empty.lastMessage).toBeNull();
    expect(gone.alive).toBe(false);
    expect(notFound).toEqual({ found: false, status: null });
    // 忙不忙只有两格，而且就是 core 的 `agent.state` 那两个词（`paused` / `dead` 不在里面）
    const two: PeerSessionActivity[] = ["working", "idle"];
    expect(two).toHaveLength(2);
  });

  it("找到了：found / status / alive / label / lastMessage 原样出现，并带上 hint", async () => {
    const { port, statuses } = recordingPort({
      status: {
        found: true,
        status: "idle",
        alive: true,
        label: "会话 1",
        lastMessage: "登录页查过了",
      },
    });
    const [, statusTool] = createPeerSessionTools(port);

    const result = await call(statusTool, { sessionId: "session-1" });
    expect(statuses).toEqual([{ caller: fakeAgent, sessionId: "session-1" }]);
    expect(result).toMatchObject({
      found: true,
      status: "idle",
      alive: true,
      label: "会话 1",
      lastMessage: "登录页查过了",
    });
    expect((result as { hint: string }).hint.toLowerCase()).toContain("do not poll");
  });

  it("找不到：found: false + status: null，并说清「不会有回音」", async () => {
    const { port } = recordingPort({ status: { found: false, status: null } });
    const [, statusTool] = createPeerSessionTools(port);

    const result = (await call(statusTool, { sessionId: "missing" })) as {
      found: boolean;
      status: null;
      hint: string;
    };
    expect(result.found).toBe(false);
    expect(result.status).toBeNull();
    // 找不到不是第五格：答案里不该冒出一个叫 gone 的状态值
    expect("state" in result).toBe(false);
    expect(result.hint.toLowerCase()).toContain("no answer will arrive");
  });

  it("两格各一句 + 死的那一支一句：活着的说「别轮询」，死的说「自己做」", async () => {
    const live: PeerSessionActivity[] = ["working", "idle"];
    for (const status of live) {
      const { port } = recordingPort({
        status: { found: true, status, alive: true, label: "s", lastMessage: null },
      });
      const [, statusTool] = createPeerSessionTools(port);
      const result = (await call(statusTool, { sessionId: "s" })) as {
        status: string;
        alive: boolean;
        hint: string;
      };
      expect(result.status).toBe(status);
      expect(result.alive).toBe(true);
      // 活着 → 她说完会自己 post_message 回来，别轮询
      expect(result.hint.toLowerCase()).toContain("do not poll");
      expect(result.hint).toContain("post_message");
    }

    // 死不是第三个状态值：它还是 `status: "idle"`（没有 agent 就没有「在不在干」这回事），
    // 由 `alive: false` 单独说。
    const dead = recordingPort({
      status: { found: true, status: "idle", alive: false, label: "s", lastMessage: null },
    });
    const [, deadTool] = createPeerSessionTools(dead.port);
    const deadResult = (await call(deadTool, { sessionId: "s" })) as {
      hint: string;
      alive: boolean;
    };
    expect(deadResult.alive).toBe(false);
    expect(deadResult.hint.toLowerCase()).toContain("no answer will arrive");
    expect(deadResult.hint).toContain("Do the work here instead");
  });

  it("没有 running / failed / aborted / gone / paused / dead 这些值（那是另外几件事）", async () => {
    const { port } = recordingPort({
      status: { found: true, status: "idle", alive: true, label: "s", lastMessage: null },
    });
    const [, statusTool] = createPeerSessionTools(port);

    const description = statusTool.function.description ?? "";
    expect(description).toContain("working or idle");
    expect(description).toContain("alive");
    expect(description).not.toContain("paused");
    expect(description).not.toContain("failed");
    expect(description).not.toContain("aborted");
    // 摘要只是摘要：给了原文模型就会当上下文搬运（需求：只给「忙不忙 + 最近一句摘要」）
    expect(description).toContain("never the full transcript");
    expect(description).toContain("never its history");
    expect(description).toContain("`lastMessage`");
    expect(description).toContain("`label`");
    // 工具说明里写明「别轮询」
    expect(description.toLowerCase()).toContain("do not poll");
  });

  it("hint 说清「只有摘要」：不是全量、不是历史，而且别轮询", async () => {
    for (const status of ["working", "idle"] as const) {
      const { port } = recordingPort({
        status: { found: true, status, alive: true, label: "s", lastMessage: "好了" },
      });
      const [, statusTool] = createPeerSessionTools(port);
      const result = (await call(statusTool, { sessionId: "s" })) as { hint: string };

      expect(result.hint).toContain("`lastMessage`");
      expect(result.hint).toContain("never that session's full transcript");
      expect(result.hint).toContain("never its history");
    }
    const live = recordingPort({
      status: { found: true, status: "working", alive: true, label: "s", lastMessage: null },
    });
    const [, liveTool] = createPeerSessionTools(live.port);
    const liveResult = (await call(liveTool, { sessionId: "s" })) as { hint: string };
    expect(liveResult.hint.toLowerCase()).toContain("do not poll");
  });

  it("答案里只有「忙不忙 + 最近一句摘要」：没有 startedAt、没有消息数组、没有条数", async () => {
    const { port } = recordingPort({
      status: {
        found: true,
        status: "working",
        alive: true,
        label: "s",
        lastMessage: "先看看登录页",
      },
    });
    const [, statusTool] = createPeerSessionTools(port);

    const result = (await call(statusTool, { sessionId: "s" })) as Record<string, unknown>;
    // 摘要那一格在（需求要的就是它）
    expect(result.lastMessage).toBe("先看看登录页");
    // 全量与历史一概不在：给了就是把对方的上下文搬进来
    expect("messages" in result).toBe(false);
    expect("messageCount" in result).toBe(false);
    expect("history" in result).toBe(false);
    // 需求里没有「什么时候开的这一格」
    expect("startedAt" in result).toBe(false);
    expect(typeof result.hint).toBe("string");
  });
});
