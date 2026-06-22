import { describe, it, expect } from "vitest";
import { Message } from "./Message.js";
import { AgentNS } from "./AgentNS.js";

describe("Message", () => {
  describe("构造函数", () => {
    it("应使用有效参数正确构造", () => {
      const msg = new Message({
        role: AgentNS.Role.User,
        content: "你好",
      });
      expect(msg.role).toBe(AgentNS.Role.User);
      expect(msg.content).toBe("你好");
      expect(msg.status).toBeUndefined();
    });

    it("缺少 role 时应抛出错误", () => {
      expect(() => {
        new Message({} as any);
      }).toThrow("Message must have a role");
    });

    it("应设置所有可选字段", () => {
      const msg = new Message({
        role: AgentNS.Role.Assistant,
        content: "回复",
        name: "助手",
        tool_calls: [
          { id: "1", function: { name: "fn1", arguments: "{}" } },
        ],
        reasoning_content: "思考中...",
        status: AgentNS.MessageStatus.Pending,
        hidden: true,
        omit: false,
      });
      expect(msg.name).toBe("助手");
      expect(msg.tool_calls).toHaveLength(1);
      expect(msg.reasoning_content).toBe("思考中...");
      expect(msg.status).toBe(AgentNS.MessageStatus.Pending);
      expect(msg.hidden).toBe(true);
      expect(msg.omit).toBe(false);
    });
  });

  describe("Message.System", () => {
    it("应创建 system 角色消息", () => {
      const msg = Message.System("你是助手");
      expect(msg.role).toBe(AgentNS.Role.System);
      expect(msg.content).toBe("你是助手");
      expect(msg.status).toBe(AgentNS.MessageStatus.Completed);
    });

    it("无参时默认内容为空字符串", () => {
      const msg = Message.System();
      expect(msg.content).toBe("");
    });
  });

  describe("Message.User", () => {
    it("应创建 user 角色文本消息", () => {
      const msg = Message.User("你好");
      expect(msg.role).toBe(AgentNS.Role.User);
      expect(msg.content).toBe("你好");
      expect(msg.status).toBe(AgentNS.MessageStatus.Completed);
    });

    it("应创建 user 角色多模态消息", () => {
      const sections: AgentNS.MessageContentSection[] = [
        { type: "text", text: "描述这张图片：" },
        { type: "image_url", image_url: { url: "https://example.com/img.png" } },
      ];
      const msg = Message.User(sections);
      expect(msg.content).toBe(sections);
      expect(Array.isArray(msg.content)).toBe(true);
    });
  });

  describe("Message.Assistant", () => {
    it("应创建 pending 状态的 assistant 消息", () => {
      const msg = Message.Assistant();
      expect(msg.role).toBe(AgentNS.Role.Assistant);
      expect(msg.content).toBe("");
      expect(msg.status).toBe(AgentNS.MessageStatus.Pending);
    });

    it("可设置初始内容", () => {
      const msg = Message.Assistant("正在思考...");
      expect(msg.content).toBe("正在思考...");
    });
  });

  describe("Message.Tool", () => {
    it("应根据 tool_call 创建 tool 消息", () => {
      const toolCall: AgentNS.ToolCall = {
        id: "42",
        function: { name: "getWeather", arguments: "{}" },
      };
      const msg = Message.Tool(toolCall, "晴天");
      expect(msg.role).toBe(AgentNS.Role.Tool);
      expect(msg.tool_call_id).toBe("42");
      expect(msg.name).toBe("getWeather");
      expect(msg.content).toBe("晴天");
      expect(msg.status).toBe(AgentNS.MessageStatus.Pending);
    });
  });

  describe("Message.Function", () => {
    it("应根据 function_call 创建 function 消息", () => {
      const funcCall: AgentNS.FunctionCall = {
        name: "getTime",
        arguments: "{}",
      };
      const msg = Message.Function(funcCall, "12:00");
      expect(msg.role).toBe(AgentNS.Role.Function);
      expect(msg.name).toBe("getTime");
      expect(msg.content).toBe("12:00");
      expect(msg.status).toBe(AgentNS.MessageStatus.Pending);
    });
  });

  describe("Message.rewrite", () => {
    it("应备份原始内容到 raw_content", () => {
      const msg = Message.User("原始内容");
      Message.rewrite(msg, "新内容");

      expect(msg.raw_content).toBe("原始内容");
      expect(msg.content).toBe("新内容");
    });

    it("多次 rewrite 时只备份第一次的原始内容", () => {
      const msg = Message.User("原始内容");
      Message.rewrite(msg, "第一次改写");
      Message.rewrite(msg, "第二次改写");

      expect(msg.raw_content).toBe("原始内容");
      expect(msg.content).toBe("第二次改写");
    });

    it("支持多模态内容改写", () => {
      const original: AgentNS.MessageContentSection[] = [
        { type: "text", text: "原文本" },
      ];
      const newContent: AgentNS.MessageContentSection[] = [
        { type: "text", text: "新文本" },
        { type: "image_url", image_url: { url: "https://example.com/img.png" } },
      ];
      const msg = Message.User(original);
      Message.rewrite(msg, newContent);

      expect(msg.raw_content).toBe(original);
      expect(msg.content).toBe(newContent);
    });
  });
});
