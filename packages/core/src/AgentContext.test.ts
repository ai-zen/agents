import { describe, it, expect } from "vitest";
import { AgentContext } from "./AgentContext.js";
import { Message } from "./Message.js";
import { AgentNS } from "./AgentNS.js";
import { Tool } from "./Tool.js";

describe("AgentContext", () => {
  it("应使用有效 model 正确构造", () => {
    const ctx = new AgentContext({
      model: {} as any,
    });
    expect(ctx.model).toBeDefined();
    expect(ctx.messages).toEqual([]);
    expect(ctx.tools).toEqual([]);
    expect(ctx.rag).toBeUndefined();
    expect(ctx.allowJsonParseError).toBe(true);
  });

  it("缺少 model 时应抛出错误", () => {
    expect(() => {
      new AgentContext({} as any);
    }).toThrow("AgentContext must have a model");
  });

  it("应接受自定义配置", () => {
    const tool1 = new (class extends Tool {
      constructor() {
        super({
          function: { name: "fn1", description: "", parameters: { type: "object", properties: {} } },
        });
      }
      async exec() {
        return "ok";
      }
    })();

    const ctx = new AgentContext({
      model: {} as any,
      model_config: { temperature: 0.7 },
      messages: [Message.System("你好")],
      tools: [tool1],
      allowJsonParseError: false,
    });

    expect(ctx.model_config).toEqual({ temperature: 0.7 });
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].role).toBe(AgentNS.Role.System);
    expect(ctx.tools).toHaveLength(1);
    expect(ctx.allowJsonParseError).toBe(false);
  });

  describe("append", () => {
    it("应添加消息并返回最后一条", () => {
      const ctx = new AgentContext({ model: {} as any });
      const msg = Message.User("测试消息");
      const result = ctx.append(msg);

      expect(ctx.messages).toHaveLength(1);
      expect(result).toBe(msg);
      expect(result.content).toBe("测试消息");
    });

    it("多次 append 应累积消息", () => {
      const ctx = new AgentContext({ model: {} as any });
      ctx.append(Message.System("角色设定"));
      ctx.append(Message.User("问题1"));
      ctx.append(Message.Assistant());

      expect(ctx.messages).toHaveLength(3);
    });
  });

  it("默认 allowJsonParseError 为 true", () => {
    const ctx = new AgentContext({ model: {} as any });
    expect(ctx.allowJsonParseError).toBe(true);
  });
});
