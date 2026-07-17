module.exports = {
  function: {
    name: "greet",
    description: "返回问候语",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "要问候的人名"
        }
      },
      required: ["name"]
    }
  },
  exec: async function(args) {
    return `你好，${args.name}！欢迎使用 AI-Zen Agents！`;
  }
};
