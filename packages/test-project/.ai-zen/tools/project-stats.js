module.exports = {
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
    // 注意：此工具在 vm 沙箱中运行，无法使用 require('fs')。
    // 仅作为一个可被 discoverUserTools 发现和实例化的示例工具。
    // 实际调用时可通过其他内置工具（如 glob、ls）获取文件信息。
    const targetDir = args.dir || "(current directory)";
    return `📊 项目统计：${targetDir}\n\n提示：请使用 glob 工具扫描文件来获取详细的统计信息。\n\n可用工具：\n  - glob: 查找文件\n  - ls: 列出目录\n  - findText: 搜索文本`;
  }
};
