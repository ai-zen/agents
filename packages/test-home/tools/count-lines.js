module.exports = {
  function: {
    name: "count_lines",
    description: "统计文件的行数（排除空行）",
    parameters: {
      type: "object",
      properties: {
        filepath: {
          type: "string",
          description: "文件路径"
        }
      },
      required: ["filepath"]
    }
  },
  exec: async function(args) {
    const fs = require("fs");
    const content = fs.readFileSync(args.filepath, "utf-8");
    const lines = content.split("\n").filter(line => line.trim() !== "");
    return `文件 "${args.filepath}" 共有 ${lines.length} 行非空代码`;
  }
};
