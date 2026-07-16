import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverUserTools } from "./usertools";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Tool, CallbackTool } from "@ai-zen/agents-core";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-zen-usertools-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeTool(filename: string, code: string) {
  writeFileSync(join(dir, filename), code);
}

// 辅助：生成一个简单的工具文件内容
function simpleToolCode(name: string, description: string) {
  return `
module.exports = {
  function: {
    name: "${name}",
    description: "${description}",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  },
  exec: async function(args) {
    return "executed: ${name}";
  }
};
`;
}

describe("discoverUserTools", () => {
  it("空目录返回空数组", () => {
    expect(discoverUserTools([dir])).toEqual([]);
  });

  it("目录不存在返回空数组", () => {
    expect(discoverUserTools([join(dir, "nonexistent")])).toEqual([]);
  });

  it("发现所有 .js 文件并加载为 Tool 实例", () => {
    writeTool("my-tool.js", simpleToolCode("my_tool", "My custom tool"));
    writeTool("code-review.js", simpleToolCode("code_review", "Review code"));
    writeTool("deploy.js", simpleToolCode("deploy", "Deploy to server"));

    const result = discoverUserTools([dir]);
    expect(result).toHaveLength(3);
    expect(result[0]).toBeInstanceOf(Tool);

    const names = result.map((t) => t.function.name);
    expect(names).toContain("my_tool");
    expect(names).toContain("code_review");
    expect(names).toContain("deploy");
  });

  it("忽略非 .js 文件", () => {
    writeTool("valid.js", simpleToolCode("valid_tool", "Valid tool"));
    writeFileSync(join(dir, "README.md"), "docs");
    writeFileSync(join(dir, "config.json"), "{}");

    const result = discoverUserTools([dir]);
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe("valid_tool");
  });

  it("按文件名排序以保证确定性", () => {
    writeTool("c.js", simpleToolCode("tool_c", "Third"));
    writeTool("a.js", simpleToolCode("tool_a", "First"));
    writeTool("b.js", simpleToolCode("tool_b", "Second"));

    const result = discoverUserTools([dir]);

    expect(result).toHaveLength(3);
    const names = result.map((t) => t.function.name);
    expect(names).toEqual(["tool_a", "tool_b", "tool_c"]);
  });

  it("多路径扫描：合并所有路径的工具", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ai-zen-usertools2-"));
    try {
      writeTool("tool-a.js", simpleToolCode("tool_a", "Tool A"));
      writeFileSync(join(dir2, "tool-b.js"), simpleToolCode("tool_b", "Tool B"));

      const result = discoverUserTools([dir, dir2]);
      expect(result).toHaveLength(2);
      const names = result.map((t) => t.function.name);
      expect(names).toContain("tool_a");
      expect(names).toContain("tool_b");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("多路径：同名工具靠前路径优先", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ai-zen-usertools2-"));
    try {
      writeTool("shared.js", simpleToolCode("shared_tool", "From first path"));
      writeFileSync(join(dir2, "shared.js"), simpleToolCode("shared_tool", "From second path"));

      const result = discoverUserTools([dir, dir2]);
      expect(result).toHaveLength(1);
      expect(result[0].function.description).toBe("From first path");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("支持 exports.default 导出格式", () => {
    writeTool("esm-tool.js", `
const tool = {
  function: {
    name: "esm_tool",
    description: "ESM style tool",
    parameters: { type: "object", properties: {}, required: [] }
  },
  exec: async function(args) {
    return "ok";
  }
};
module.exports = { default: tool };
`);

    const result = discoverUserTools([dir]);
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe("esm_tool");
  });

  it("支持 CallbackTool 格式（{ function, callback }）", () => {
    writeTool("callback-tool.js", `
module.exports = {
  function: {
    name: "my_callback",
    description: "Callback based tool",
    parameters: { type: "object", properties: {}, required: [] }
  },
  callback: function(args) {
    return "callback result: " + JSON.stringify(args);
  }
};
`);

    const result = discoverUserTools([dir]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(CallbackTool);
    expect(result[0].function.name).toBe("my_callback");
  });

  it("跳过加载失败的 .js 文件", () => {
    writeTool("broken.js", `module.exports = { this is syntx error!!! }`);
    writeTool("good.js", simpleToolCode("good_tool", "Good tool"));

    const result = discoverUserTools([dir]);
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe("good_tool");
  });

  it("工具 exec 方法可正常调用", async () => {
    writeTool("adder.js", `
module.exports = {
  function: {
    name: "adder",
    description: "Add two numbers",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" }
      },
      required: ["a", "b"]
    }
  },
  exec: async function(args) {
    return (args.a + args.b).toString();
  }
};
`);

    const result = discoverUserTools([dir]);
    expect(result).toHaveLength(1);

    // 模拟 FunctionCallContext
    const mockCtx = {
      parsed_args: { a: 3, b: 4 },
      agent: null,
    };
    const output = await result[0].exec(mockCtx as any);
    expect(output).toBe("7");
  });

  it("空导出不报错", () => {
    writeTool("empty.js", `module.exports = {};`);

    const result = discoverUserTools([dir]);
    expect(result).toHaveLength(0);
  });

  it("无 module.exports 也不报错", () => {
    writeTool("noop.js", `// just a comment`);

    const result = discoverUserTools([dir]);
    expect(result).toHaveLength(0);
  });
});
