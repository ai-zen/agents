/**
 * 内容格式化（`formatContent` / `formatContentSection`）与 `formatHistory` 的关系。
 *
 * 两件事要钉住：白的字段才能出网（本地扩展、厂商多塞的字段都剥掉），
 * 以及这两个函数是 `formatHistory` 唯一的逐段路径（覆写就生效）。
 */

import type OpenAI from "openai";
import { describe, expect, it } from "vitest";

import { Agent } from "./Agent.js";
import type { AgentNS } from "./AgentNS.js";
import { AgentNS as AgentNSValue } from "./AgentNS.js";
import { formatContent, formatContentSection } from "./formatContent.js";
import { Message } from "./Message.js";

/** 造一个不连模型的 agent（`formatHistory` 不碰 client / model） */
function makeAgent(messages: AgentNS.Message[] = []): Agent {
  return new Agent({ client: {} as unknown as OpenAI, model: "gpt-x", messages });
}

/** 段上的本地扩展与厂商多塞的键（都是认不出的字段） */
type LooseSection = AgentNS.MessageContentSection & Record<string, unknown>;

describe("formatContentSection", () => {
  it("text 段只留 index / type / text", () => {
    const section: LooseSection = {
      index: 1,
      type: "text",
      text: "你好",
      __asset_id: "a1",
      cache_control: { type: "ephemeral" },
    };

    expect(formatContentSection(section)).toEqual({ index: 1, type: "text", text: "你好" });
  });

  it("image_url 段的内层只留 url / detail", () => {
    const section: LooseSection = {
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAA", detail: "low", width: 32 },
      __asset_id: "a2",
    };

    expect(formatContentSection(section)).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAA", detail: "low" },
    });
  });

  it("file 段留 file_id / file_data / filename", () => {
    expect(
      formatContentSection({ type: "file", file_id: "file-1", extra: 1 } as LooseSection),
    ).toEqual({ type: "file", file_id: "file-1" });
    expect(
      formatContentSection({
        type: "file",
        file_data: "data:text/plain;base64,QQ==",
        filename: "a.txt",
      }),
    ).toEqual({ type: "file", file_data: "data:text/plain;base64,QQ==", filename: "a.txt" });
  });

  it("认不出的段类型只剩 type（有 index 就带上）", () => {
    expect(formatContentSection({ type: "audio", url: "https://x/a.mp3" } as LooseSection)).toEqual(
      {
        type: "audio",
      },
    );
    expect(
      formatContentSection({ index: 2, type: "video", video_url: { url: "u" } } as LooseSection),
    ).toEqual({ index: 2, type: "video" });
  });

  it("不改入参", () => {
    const section: LooseSection = { type: "text", text: "原样", __asset_id: "a3" };
    formatContentSection(section);
    expect(section.__asset_id).toBe("a3");
  });
});

describe("Agent.formatContent", () => {
  it("字符串原样返回，不委派给 formatContentSection", () => {
    const agent = makeAgent();
    let sectionCalls = 0;
    agent.formatContentSection = (section) => {
      sectionCalls += 1;
      return section;
    };

    expect(agent.formatContent("纯文本")).toBe("纯文本");
    expect(sectionCalls).toBe(0);
  });

  it("数组逐段交给 formatContentSection", () => {
    const agent = makeAgent();
    const seen: string[] = [];
    agent.formatContentSection = (section) => {
      seen.push(section.type);
      return section;
    };

    agent.formatContent([
      { type: "text", text: "a" },
      { type: "image_url", image_url: { url: "u" } },
    ]);
    expect(seen).toEqual(["text", "image_url"]);
  });

  it("默认实现就是 core 的 formatContent（剥掉认不出的字段）", () => {
    const agent = makeAgent();

    expect(
      agent.formatContent([{ type: "text", text: "带扩展", __asset_id: "a4" } as LooseSection]),
    ).toEqual([{ type: "text", text: "带扩展" }]);
  });

  it("覆写 formatContent 之后 formatHistory 跟着走", () => {
    const agent = makeAgent([Message.User([{ type: "text", text: "原文" }])]);
    agent.formatContent = () => "覆盖后的内容";

    expect(agent.formatHistory()[0]?.content).toBe("覆盖后的内容");
  });

  it("覆写 formatContentSection 之后 formatContent 与 formatHistory 都跟着走", () => {
    const agent = makeAgent([Message.User([{ type: "text", text: "原文" }])]);
    let calls = 0;
    agent.formatContentSection = (section) => {
      calls += 1;
      return section.type === "text" ? { type: "text", text: "改写" } : section;
    };

    expect(agent.formatContent([{ type: "text", text: "原文" }])).toEqual([
      { type: "text", text: "改写" },
    ]);
    expect(agent.formatHistory()[0]?.content).toEqual([{ type: "text", text: "改写" }]);
    expect(calls).toBe(2);
  });
});

describe("formatHistory 的逐段路径", () => {
  it("有内容的消息各过一次 formatContent，段各过一次 formatContentSection", () => {
    const agent = makeAgent([
      Message.System("系统"),
      Message.User([
        { type: "text", text: "一段" },
        { type: "text", text: "两段" },
      ]),
      { id: "m-x", role: AgentNSValue.Role.Assistant, content: "字符串内容" } as AgentNS.Message,
    ]);

    const originalContent = agent.formatContent.bind(agent);
    const originalSection = agent.formatContentSection.bind(agent);
    let contentCalls = 0;
    let sectionCalls = 0;
    agent.formatContent = (content) => {
      contentCalls += 1;
      return originalContent(content);
    };
    agent.formatContentSection = (section) => {
      sectionCalls += 1;
      return originalSection(section);
    };

    const history = agent.formatHistory();

    // 三条消息都有内容：各过一次入口
    expect(contentCalls).toBe(3);
    // 只有数组内容逐段走：两段
    expect(sectionCalls).toBe(2);
    expect(history[1]?.content).toEqual([
      { type: "text", text: "一段" },
      { type: "text", text: "两段" },
    ]);
  });
});

describe("formatHistory 的产物（逐字节回归）", () => {
  it("与改动前一致：前缀缓存依赖这份字节稳定", () => {
    const agent = makeAgent([
      { id: "m1", role: AgentNSValue.Role.System, content: "你是助手" },
      {
        id: "m2",
        role: AgentNSValue.Role.User,
        content: [
          { type: "text", text: "看看这张" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA", detail: "low" } },
          { type: "file", file_id: "file-1" },
          { type: "file", file_data: "data:text/plain;base64,QQ==", filename: "a.txt" },
        ],
        status: AgentNSValue.MessageStatus.Completed,
      },
      {
        id: "m3",
        role: AgentNSValue.Role.Assistant,
        content: "好的",
        reasoning_content: "想一下",
        tool_calls: [
          { index: 0, id: "call-1", type: "function", function: { name: "f", arguments: "{}" } },
        ],
        status: AgentNSValue.MessageStatus.Completed,
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
      {
        id: "m4",
        role: AgentNSValue.Role.Tool,
        tool_call_id: "call-1",
        name: "f",
        content: "结果",
        status: AgentNSValue.MessageStatus.Completed,
      },
      {
        id: "m5",
        role: AgentNSValue.Role.Function,
        name: "g",
        function_call: { name: "g", arguments: "{}" },
        content: "老函数结果",
      },
      {
        id: "m6",
        role: AgentNSValue.Role.Assistant,
        content: "在写",
        status: AgentNSValue.MessageStatus.Pending,
      },
      {
        id: "m7",
        role: AgentNSValue.Role.User,
        content: "被省掉",
        omit: true,
        status: AgentNSValue.MessageStatus.Completed,
      },
      {
        id: "m8",
        role: AgentNSValue.Role.User,
        content: [{ type: "text", text: "无状态" }],
      },
    ]);

    expect(JSON.stringify(agent.formatHistory())).toBe(
      '[{"role":"system","content":"你是助手"},' +
        '{"role":"user","content":[{"type":"text","text":"看看这张"},' +
        '{"type":"image_url","image_url":{"url":"data:image/png;base64,AAA","detail":"low"}},' +
        '{"type":"file","file_id":"file-1"},' +
        '{"type":"file","file_data":"data:text/plain;base64,QQ==","filename":"a.txt"}]},' +
        '{"role":"assistant","content":"好的","tool_calls":[' +
        '{"index":0,"id":"call-1","type":"function","function":{"name":"f","arguments":"{}"}}],' +
        '"reasoning_content":"想一下"},' +
        '{"role":"tool","content":"结果","tool_call_id":"call-1","name":"f"},' +
        '{"role":"function","content":"老函数结果","function_call":{"name":"g","arguments":"{}"},' +
        '"name":"g"},' +
        '{"role":"user","content":[{"type":"text","text":"无状态"}]}]',
    );
  });
});

describe("formatContent（纯函数）", () => {
  it("字符串原样返回，数组逐段重建", () => {
    expect(formatContent("纯文本")).toBe("纯文本");
    expect(
      formatContent([{ type: "text", text: "带扩展", __asset_id: "a5" } as LooseSection]),
    ).toEqual([{ type: "text", text: "带扩展" }]);
  });
});
