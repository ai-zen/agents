import { AgentNS } from "@ai-zen/agents-core";
import { describe, expect, it } from "vitest";

import {
  METHOD_NAMES,
  PROTOCOL_VERSION,
  isMethodName,
  type ConversationSendParams,
  type ConversationSendResult,
  type ConversationTransientResult,
  type MessageHit,
  type MessageListParams,
  type MessageListResult,
  type MethodName,
} from "./methods.js";

const DOMAINS: readonly string[] = [
  "host",
  "workspace",
  "conversation",
  "message",
  "question",
  "notice",
  "config",
  "agent",
  "model",
  "asset",
  "completion",
  "handoff",
  "search",
];

describe("方法表", () => {
  it("方法名不重复", () => {
    expect(new Set(METHOD_NAMES).size).toBe(METHOD_NAMES.length);
  });

  it("方法名都是 <域>.<动作>，域在已知清单里", () => {
    for (const method of METHOD_NAMES) {
      expect(method, method).toMatch(/^[a-z]+(\.[a-zA-Z]+)+$/);
      const domain = method.slice(0, method.indexOf("."));
      expect(DOMAINS, method).toContain(domain);
    }
  });

  it("METHOD_NAMES 覆盖 MethodMap 的每一个方法（漏写会在编译期露馅）", () => {
    type Missing = Exclude<MethodName, (typeof METHOD_NAMES)[number]>;
    const noMissing: Missing extends never ? true : false = true;
    expect(noMissing).toBe(true);
    expect(METHOD_NAMES.length).toBeGreaterThan(50);
  });

  it("isMethodName 只认表里的名字", () => {
    expect(isMethodName("conversation.send")).toBe(true);
    for (const method of METHOD_NAMES) {
      expect(isMethodName(method)).toBe(true);
    }
    expect(isMethodName("conversation.explode")).toBe(false);
    expect(isMethodName(undefined)).toBe(false);
  });

  it("每个域在表里都有方法", () => {
    const used = new Set(METHOD_NAMES.map((method) => method.slice(0, method.indexOf("."))));
    for (const domain of DOMAINS) {
      expect(used, domain).toContain(domain);
    }
  });

  it("协议版本是个可比的字符串", () => {
    expect(PROTOCOL_VERSION).toBe("1");
  });
});

describe("PRD §4 的落点能力都有方法承接", () => {
  it("`message.list` 支持 { conversationId, after?, around? }（A12 / F-C6）", () => {
    const all: MessageListParams = { conversationId: "c-1" };
    const tail: MessageListParams = { conversationId: "c-1", after: "m-9" };
    const located: MessageListParams = { conversationId: "c-1", around: "m-4" };
    const subagent: MessageListParams = { conversationId: "c-1", toolCallId: "t-1" };
    expect(Object.keys(all)).toEqual(["conversationId"]);
    expect(tail.after).toBe("m-9");
    // F-C6 的定位：以某条为中心取一窗（消费者是桌面端的搜索命中跳转）
    expect(located.around).toBe("m-4");
    expect(subagent.toolCallId).toBe("t-1");
  });

  it("`conversation.send` 入参用 core 的内容形状，出参给出两个 id 与附件结局", () => {
    const params: ConversationSendParams = {
      conversationId: "c-1",
      input: {
        content: [{ type: "text", text: "看一眼这张图" }],
        assetIds: ["a-1"],
      },
    };
    const result: ConversationSendResult = {
      userMessageId: "m-1",
      assistantMessageId: "m-2",
      attachments: [
        {
          assetId: "a-1",
          deliveredAs: "inline",
          section: { type: "image_url", image_url: { url: "https://example.test/a.png" } },
          problem: null,
        },
      ],
      acceptedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(params.input.assetIds).toEqual(["a-1"]);
    expect(result.assistantMessageId).toBe("m-2");
    expect(result.attachments[0].section?.type).toBe("image_url");
  });

  it("`message.list` 的消息数组就是 core 的 Message，不重新包装字段", () => {
    const result: MessageListResult = {
      conversationId: "c-1",
      anchor: "m-2",
      messages: [
        {
          id: "m-2",
          role: AgentNS.Role.Assistant,
          status: AgentNS.MessageStatus.Completed,
          content: "看完了",
          reasoning_content: "先看文件",
          tool_calls: [
            { index: 0, id: "t-1", type: "function", function: { name: "read", arguments: "{}" } },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          omit: false,
          hidden: false,
        },
      ],
    };

    // 消息元素类型就是 AgentNS.Message（多一个字段少一个字段都会在编译期露馅）
    const first: AgentNS.Message = result.messages[0];
    expect(first.id).toBe("m-2");
    expect(first.tool_calls?.[0].function?.name).toBe("read");
    // 没有额外的外壳字段（旧的 `segments` / `attachments` / `omitted` 都没了）
    expect(Object.keys(first).sort()).toEqual([
      "content",
      "hidden",
      "id",
      "omit",
      "reasoning_content",
      "role",
      "status",
      "tool_calls",
      "usage",
    ]);
  });

  it("`conversation.transient` 回一条 core 的助手消息（内容/用量都在上面）", () => {
    const result: ConversationTransientResult = {
      message: { id: "m-1", role: AgentNS.Role.Assistant, content: "一次性回答", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
      subagents: [],
      problem: null,
    };
    expect(result.message.content).toBe("一次性回答");
    expect(result.message.usage?.total_tokens).toBe(3);
  });

  it("搜索命中的角色用 core 的 Role", () => {
    const hit: MessageHit = {
      conversationId: "c-1",
      conversationName: "聊聊",
      messageId: "m-3",
      role: AgentNS.Role.User,
      snippet: "…图片内容…",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(hit.role).toBe("user");
  });

  it("能力编号 ↔ 方法名的落点（按 PRD §4 清单逐条）", () => {
    // 落点为 S / S+C 的能力各自有承接方法；这张表是 PM 复核用的对照关系
    const coverage: Record<string, MethodName[]> = {
      "F-A1": ["host.hello"], // 判定这次调用算不算一段对话
      "F-A2": ["conversation.transient"], // 临时对话
      "F-A3": ["conversation.create"], // 开新会话、别续接
      "F-A8": ["config.get", "config.patch"], // 配错要能当场修
      "F-B1": ["agent.setModel", "agent.list"], // 模型唯一真相源
      "F-B2": ["agent.list", "agent.get", "agent.create", "agent.update"], // 助手定义
      "F-B3": ["agent.list"], // 默认助手
      "F-B4": ["conversation.setModel", "agent.setModel"], // 两个动作两个入口
      "F-B5": ["agent.list", "config.setDefaults"], // 不可用也列出
      "F-B6": ["conversation.setThinking", "agent.setThinking"], // 写参数不写档位名
      "F-B7": ["conversation.state", "agent.list"], // 状态能区分来源
      "F-B8": ["conversation.setModel"], // 拒绝降级
      "F-C1": ["conversation.get"],
      "F-C2": ["conversation.send"], // 落盘时机
      "F-C3": ["conversation.rename"],
      "F-C4": ["conversation.rename", "config.setDefaults"], // 自动命名 + 取名模型
      "F-C5": ["conversation.list", "conversation.pin"],
      "F-C6": ["search.conversations", "search.messages"],
      "F-C7": ["conversation.create"],
      "F-C8": ["conversation.revert"],
      "F-C10": ["conversation.delete"],
      "F-D1": ["conversation.state"], // 两条阈值
      "F-D2": ["question.list", "question.answer"],
      "F-D3": ["handoff.start"],
      "F-D4": ["handoff.start"],
      "F-D5": ["handoff.start"],
      "F-D6": ["handoff.start", "handoff.listDocuments"],
      "F-D7": ["handoff.start"], // 降级要说明
      "F-D9": ["message.list"], // 注入标记在消息上
      "F-D10": ["conversation.send", "question.answer"],
      "F-E1": ["host.shutdown", "host.reload"],
      "F-E2": ["config.patch"],
      "F-E3": ["host.upgrade", "host.version"],
      "F-E4": ["host.setLanguage", "config.saveEndpoint"], // 直达入口：语言 + 端点（凭据不在这条线上）
      "F-F1": ["config.get", "config.patch"],
      "F-F2": ["config.saveEndpoint", "config.deleteEndpoint"],
      "F-F3": ["model.list", "model.create", "model.update", "model.restoreFactory"],
      "F-F4": ["model.listImages", "model.saveImage", "model.deleteImage"],
      "F-F5": ["agent.delete"],
      "F-F6": ["config.getDiscovery", "config.saveMcp", "config.deleteMcp"],
      "F-F7": ["config.setDefaults"],
      "F-F8": ["config.patch"],
      "F-F9": ["conversation.delete", "workspace.remove"],
      "F-G1": ["config.getDiscovery", "config.saveMcp", "config.deleteMcp"],
      "F-G2": ["config.getDiscovery"],
      "F-G3": ["agent.create", "agent.update"],
      "F-H5": ["completion.files"],
      "F-H7": ["conversation.send"],
      "F-H8": ["asset.begin", "asset.end"],
      "F-I2": ["message.list"],
      "F-I3": ["conversation.state"],
      "F-I5": ["conversation.state"], // 用量快照（本轮 / 累计含子 Agent / 速率）就在它的 `usage` 上
      "F-I6": ["conversation.state"],
      "F-I7": ["message.list", "conversation.state"],
      "F-I8": ["notice.list", "notice.dismiss", "notice.clear"],
      "F-I9": ["question.list", "question.answer"],
      "F-J1": ["host.hello", "host.setLanguage"],
      "F-J2": ["notice.list"],
    };

    for (const [ability, methods] of Object.entries(coverage)) {
      expect(methods.length, ability).toBeGreaterThan(0);
      for (const method of methods) {
        expect(METHOD_NAMES as readonly string[], `${ability} → ${method}`).toContain(method);
      }
    }
  });

  it("落点为 C 的能力不占宿主方法名（抽查：清屏、终端、剪贴板）", () => {
    const forbidden = [
      "conversation.clearScreen",
      "terminal.restore",
      "clipboard.read",
      "editor.open",
    ];
    for (const method of forbidden) {
      expect(isMethodName(method), method).toBe(false);
    }
  });
});

describe("已删掉的方法不许自己长回来（裁定 2026-11-13）", () => {
  /**
   * 防的回归：有人照着旧 PRD / 旧客户端代码把方法加回 `MethodMap` 或 `METHOD_NAMES`。
   *
   * 这两组删的是「契约面」不是「能力」：用量看 `conversation.state.usage`（F-I5），
   * 凭据管理是宿主的入口（`agents-host token create|list|revoke`）。方法一旦回到表里，
   * 客户端就会以为这条路由通了，而宿主并不想提供它。
   */
  const REMOVED = [
    "host.usage",
    "credential.list",
    "credential.create",
    "credential.revoke",
  ] as const;

  it("这四个名字不在 METHOD_NAMES 里，也不是 MethodMap 的键", () => {
    // 运行时：分发只认 METHOD_NAMES（`isMethodName`），所以它们进不来
    for (const method of REMOVED) {
      expect(METHOD_NAMES as readonly string[], method).not.toContain(method);
      expect(isMethodName(method), method).toBe(false);
    }

    // 类型层：`MethodMap` 是纯类型，只能靠差集断言。上面「METHOD_NAMES 覆盖 MethodMap 的每个
    // 键」那条用例已经把这层关系钉住了，所以「不在 METHOD_NAMES」+「覆盖无漏」= 「不在 MethodMap」。
    // 这条断言是它的编译期版本：把方法加回 `MethodMap` 时，这里不再是 never，编译就红。
    type StillInContract = Extract<MethodName, (typeof REMOVED)[number]>;
    const noLongerInContract: StillInContract extends never ? true : false = true;
    expect(noLongerInContract).toBe(true);
  });
});
