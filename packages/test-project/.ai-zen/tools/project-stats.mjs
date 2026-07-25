export default {
  function: {
    name: "project_stats",
    description: "统计项目中的文件数量和类型分布",
    parameters: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description: "项目目录路径，默认当前目录"
        }
      },
      required: []
    }
  },
  exec: async function(args) {
    const targetDir = args.dir || "(current directory)";
    return `📊 项目统计：${targetDir}\n\n提示：请使用 glob 工具扫描文件来获取详细的统计信息。\n\n可用工具：\n  - glob: 查找文件\n  - ls: 列出目录\n  - findText: 搜索文本`;
  }
};
