import { Agent, AgentNS, AgentTool, CallbackTool, OpenAI } from "./index.js";
import { ChatGPT } from "./Models/ChatCompletionModels/ChatGPT.js";

async function main() {
  const endpoint = new OpenAI({
    openai_endpoint: "https://open.bigmodel.cn/api/paas/v4",
    api_key: "YOUR_ZHIPU_KEY",
  });

  const glm45air = new ChatGPT({
    model_config: {},
    request_config: await endpoint.chatCompletion("glm-4.5-air"),
  });

  const chat = new Agent({
    model: glm45air,
    messages: [
      {
        role: AgentNS.Role.System,
        content: "你是是一个AI助手，专门帮助用户回答问题。",
      },
    ],
    tools: [
      new CallbackTool({
        function: {
          name: "getNowTime",
          description: "获取指定时区当前时间",
          parameters: {
            type: "object",
            properties: {
              timezone: {
                type: "number",
                description: "时区，东八区填8，西八区填-8",
              },
            },
            required: ["timezone"],
          },
        },
        callback({ timezone }) {
          var now = new Date();
          var utcTimestamp = now.getTime();
          var targetTimezoneOffset = timezone * 60 * 60 * 1000;
          var targetTimestamp = utcTimestamp + targetTimezoneOffset;
          var targetDate = new Date(targetTimestamp);
          return {
            timezone,
            time: targetDate.toISOString().replace(/[TZ]/g, " ").trim(),
          };
        },
      }),
      new AgentTool({
        function: {
          name: "getWeather",
          description: "当你需要获取某个城市某天的天气时可以调用此函数",
          parameters: {
            type: "object",
            properties: {
              city: {
                type: "string",
                description: "城市",
              },
              date: {
                type: "string",
                description: "日期，格式为 yyyy-MM-dd",
              },
            },
            required: ["city", "date"],
          },
        },
        model: glm45air,
        messages: [
          {
            role: AgentNS.Role.System,
            content: "你是一个 mock 数据生成大师，专门帮助用户生成MOCK信息。",
          },
          {
            role: AgentNS.Role.User,
            content:
              "请为这个城市 {{ city }} 时间 {{ date }} 生成 mock 天气预报数据，直接返回 JSON 数据，不需要进行其他说明。",
          },
        ],
      }),
    ],
  });

  console.log("send...");
  console.log("tools", JSON.stringify(chat.formatTools(), null, 4));
  const messages = await chat.send("当前时间纽约天气如何？");
  console.log("messages", JSON.stringify(messages, null, 4));
}

await main();
