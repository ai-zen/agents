import {
  AgentTool,
  AzureOpenAI,
  Agent,
  AgentNS,
  CallbackTool,
} from "./dist/index.js";

async function main() {
  const chat = new Agent({
    endpoints: [
      // new OpenAI({
      //   enabled_models_keys: ["GPT35Turbo_1106"],
      //   api_key: "YOUR_OPENAI_KEY",
      // }),
      new AzureOpenAI({
        enabled_models_keys: ["GPT35Turbo_1106"],
        azure_endpoint: "https://YOUR_AZURE_RESOURCES.openai.azure.com/",
        api_key: "YOUR_AZURE_OPENAI_KEY",
        api_version: "2024-02-15-preview",
        deployments: {
          GPT35Turbo_1106: "YOUR_MODEL_DEPLOYMENT_NAME",
        },
      }),
    ],
    model: "GPT35Turbo_1106",
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
        model: "GPT35Turbo_1106",
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
  const messages = await chat.send("当前时间纽约天气如何？");
  console.log("messages", JSON.stringify(messages, null, 4));
}

await main();
