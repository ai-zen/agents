import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionHandoff,
  isHandoffAborted,
  type HandoffAgentLike,
  type SessionHandoffNotice,
} from "./SessionHandoff.js";

/**
 * 交接的服务端包装 —— 测的是**包装**，不是 SDK 的交接流程。
 *
 * SDK 自己已经把「停工 → 写文档 → 校验 → 降级 → 剔历史 → 注入断点」测透了；这里只断言
 * 服务端特有的三件事：文档落在工作区里、进度只以 `code + params` 出去（不产文案）、
 * 取消语义如实透出。所以假 Agent 无网络也能跑完。
 */

let workspace: string;

/** 交接文档正文：SDK 有 400 字节的有效性阈值，桩必须够长 */
const DOC = `# 交接文档\n\n${"- 桩内容\n".repeat(80)}`;

/**
 * 每个用例一个工作区。
 *
 * 共用会碰到��个真实现象：交接文件名只精确到秒（`YYYYMMDD-HHmmss.md`），同一秒里的
 * 两次交接撞同一个路径 —— 上一个用例写下的文档会让「写不出来」的用例误判成写成功了。
 * 撞名本身是 SDK 的有意设计（并发交接是调用方该避开的事），测试得绕开它。
 */
const handoffDir = () => join(workspace, ".ai-zen", "handoffs");

beforeEach(async () => {
  workspace = await fs.mkdtemp(join(tmpdir(), "aiz-handoff-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

interface FakeAgentOptions {
  /** 带 `write` 工具 = 可以走 `self` 模式（交接回合由原 Agent 自己写盘） */
  writeTool?: boolean;
  /** 交接回合是否真的写出文件（置 false 用来测「写不出来 → 降级摘要」） */
  writesFile?: boolean;
  /** 摘要请求的实现（默认立刻返回文档；取消用例让它挂住） */
  summarize?: (signal: AbortSignal | undefined) => Promise<unknown>;
}

function makeAgent(options: FakeAgentOptions = {}): HandoffAgentLike {
  const { writeTool = false, writesFile = true, summarize } = options;

  const agent: HandoffAgentLike = {
    messages: [],
    definition: { messages: [{ role: "system", content: "模板" }] },
    tools: writeTool ? [{ function: { name: "write" } }] : [],
    model: "m",
    modelConfig: {},
    client: {
      chat: {
        completions: {
          create: (_body: unknown, requestOptions?: { signal?: AbortSignal }) =>
            summarize
              ? summarize(requestOptions?.signal)
              : Promise.resolve({ choices: [{ message: { content: DOC } }] }),
        },
      },
    },
    // 交接回合：真 Agent 会往 messages 里追加「指令 + 回执」，再把指令里的路径写出来
    send: async (input: string) => {
      agent.messages.push({ role: "user", content: input });
      if (!writesFile) return;
      const match = input.match(/Handoff document absolute path: (.+)/);
      if (!match) return;
      const path = match[1]!.trim();
      await fs.mkdir(join(path, ".."), { recursive: true });
      await fs.writeFile(path, DOC, "utf-8");
    },
    abort: () => {},
    use: () => {},
    scope: { cwd: workspace },
  };

  return agent;
}

function makeService(notices: SessionHandoffNotice[] = []): SessionHandoff {
  return new SessionHandoff({
    // Skill 目录故意指向不存在的路径：走 SDK 的兜底模板，用例不依赖磁盘上的 Skill
    aiZenDir: join(workspace, "ai-zen"),
    homeDir: join(workspace, "home"),
    workspacePath: workspace,
    notice: (notice) => notices.push(notice),
  });
}

/** 交接目录里此刻有哪些文件（取消用例靠它证明「没留下半成品」） */
async function handoffFiles(): Promise<string[]> {
  return existsSync(handoffDir()) ? (await fs.readdir(handoffDir())).sort() : [];
}

describe("SessionHandoff：文档落在工作区里", () => {
  it("handoff 只写文档：不碰会话、不换 id", async () => {
    const agent = makeAgent();
    agent.messages = [{ role: "user", content: "任务" }];

    const outcome = await makeService().handoff(agent);

    expect(existsSync(outcome.handoffPath)).toBe(true);
    // 跟着项目走：`<工作区>/.ai-zen/handoffs/<时间戳>.md`
    expect(outcome.handoffPath.startsWith(handoffDir())).toBe(true);
    // 没有 write 工具 → SDK 直接选摘要模式（消息一条都不加）
    expect(outcome.mode).toBe("summary");
    expect(agent.messages).toEqual([{ role: "user", content: "任务" }]);
  });

  it("self 模式：交接回合由原 Agent 自己写盘，这一回合留在会话里", async () => {
    const agent = makeAgent({ writeTool: true });
    agent.messages = [{ role: "user", content: "任务" }];

    const outcome = await makeService().handoff(agent);

    expect(outcome.mode).toBe("self");
    expect(existsSync(outcome.handoffPath)).toBe(true);
    // 交接回合（指令 + 回执）留在会话里，用户可继续要求打磨同一份文档
    expect(agent.messages.length).toBeGreaterThan(1);
  });

  it("migrate：剔除历史，只留「模板 + 交接断点」", async () => {
    const agent = makeAgent({ writeTool: true });
    agent.messages = [
      { role: "user", content: "旧任务" },
      { role: "assistant", content: "旧答复" },
    ];

    const outcome = await makeService().migrate(agent);

    // prune：模板 1 条 + 交接断点 1 条
    expect(agent.messages).toHaveLength(2);
    expect(agent.messages[0]).toEqual({ role: "system", content: "模板" });
    expect(String((agent.messages[1] as { content: string }).content)).toContain(outcome.handoffPath);
    // 旧历史真的没了（不是靠 `omit` 标记藏着）
    expect(JSON.stringify(agent.messages)).not.toContain("旧任务");
  });
});

describe("SessionHandoff：通知只带事实，不产文案", () => {
  it("进度与结果都是一条 `code + params`（客户端查自己的 i18n 表）", async () => {
    const notices: SessionHandoffNotice[] = [];
    const agent = makeAgent({ writeTool: true });
    agent.messages = [{ role: "user", content: "任务" }];

    const outcome = await makeService(notices).handoff(agent);

    expect(notices).toEqual([
      { level: "info", code: "handoffWriting", params: { mode: "self" } },
      { level: "info", code: "handoffPath", params: { path: outcome.handoffPath } },
    ]);
    // 载荷里没有任何给人看的句子：中文终端与英文浏览器各查各的表
    for (const notice of notices) {
      expect(Object.keys(notice).sort()).toEqual(["code", "level", "params"]);
    }
  });

  it("self 写不出文档 → 降级摘要，并明确报「降级」", async () => {
    const notices: SessionHandoffNotice[] = [];
    const agent = makeAgent({ writeTool: true, writesFile: false });
    agent.messages = [{ role: "user", content: "任务" }];

    const outcome = await makeService(notices).handoff(agent);

    expect(outcome.mode).toBe("summary"); // 实际执行者
    expect(existsSync(outcome.handoffPath)).toBe(true); // 文档仍然有了
    expect(notices.map((notice) => notice.code)).toEqual([
      "handoffWriting",
      "migrationDegraded",
      "handoffPath",
    ]);
    expect(notices[1]).toMatchObject({
      level: "warn",
      params: { requested: "self", mode: "summary" },
    });
  });
});

describe("SessionHandoff：取消", () => {
  it("abort() 立刻停下且不降级：报的是 HandoffAbortedError，不是「文档没写出来」", async () => {
    const service = makeService();
    const agent = makeAgent({
      // 摘要请求挂住，直到被取消 —— 模拟「用户按了 Ctrl+C」
      summarize: (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("Request was aborted"), { name: "AbortError" })),
          );
        }),
    });
    agent.messages = [{ role: "user", content: "任务" }];

    const before = await handoffFiles();
    const pending = service.handoff(agent);
    await new Promise((resolve) => setTimeout(resolve, 0)); // 让它跑到「等模型」那一步
    expect(service.busy).toBe(true);

    service.abort();

    const error = await pending.then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(isHandoffAborted(error)).toBe(true);
    expect(service.busy).toBe(false);
    // 没有留下半成品文档：下一次接手不会把不完整的内容当成真实交接读进去
    expect(await handoffFiles()).toEqual(before);
  });
});
