import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverUserTools } from "./usertools.js";
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

// 辅助：生成一个简单的 ESM 工具文件内容（适用于 .js 和 .mjs）
function simpleToolCode(name: string, description: string) {
  return `
export default {
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
  it("空目录返回空数组", async () => {
    await expect(discoverUserTools([dir])).resolves.toEqual([]);
  });

  it("目录不存在返回空数组", async () => {
    await expect(discoverUserTools([join(dir, "nonexistent")])).resolves.toEqual([]);
  });

  it("发现所有 .js 和 .mjs 文件并加载为 Tool 实例", async () => {
    writeTool("my-tool.mjs", simpleToolCode("my_tool", "My custom tool"));
    writeTool("code-review.js", simpleToolCode("code_review", "Review code"));
    writeTool("deploy.mjs", simpleToolCode("deploy", "Deploy to server"));

    const result = await discoverUserTools([dir]);
    expect(result).toHaveLength(3);
    expect(result[0]).toBeInstanceOf(Tool);

    const names = result.map((t) => t.function.name);
    expect(names).toContain("my_tool");
    expect(names).toContain("code_review");
    expect(names).toContain("deploy");
  });

  it("忽略非 .js/.mjs 文件", async () => {
    writeTool("valid.js", simpleToolCode("valid_tool", "Valid tool"));
    writeFileSync(join(dir, "README.md"), "docs");
    writeFileSync(join(dir, "config.json"), "{}");
    writeFileSync(join(dir, "script.py"), "print('hello')");

    const result = await discoverUserTools([dir]);
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe("valid_tool");
  });

  it("按文件名排序以保证确定性", async () => {
    writeTool("c.mjs", simpleToolCode("tool_c", "Third"));
    writeTool("a.js", simpleToolCode("tool_a", "First"));
    writeTool("b.mjs", simpleToolCode("tool_b", "Second"));

    const result = await discoverUserTools([dir]);

    expect(result).toHaveLength(3);
    const names = result.map((t) => t.function.name);
    expect(names).toEqual(["tool_a", "tool_b", "tool_c"]);
  });

  it("多路径扫描：合并所有路径的工具", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ai-zen-usertools2-"));
    try {
      writeTool("tool-a.mjs", simpleToolCode("tool_a", "Tool A"));
      writeFileSync(join(dir2, "tool-b.js"), simpleToolCode("tool_b", "Tool B"));

      const result = await discoverUserTools([dir, dir2]);
      expect(result).toHaveLength(2);
      const names = result.map((t) => t.function.name);
      expect(names).toContain("tool_a");
      expect(names).toContain("tool_b");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("多路径：同名工具靠前路径优先（先到先得）", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "ai-zen-usertools2-"));
    try {
      writeTool("shared.mjs", simpleToolCode("shared_tool", "From first path（高优先级）"));
      writeFileSync(join(dir2, "shared.js"), simpleToolCode("shared_tool", "From second path（低优先级）"));

      const result = await discoverUserTools([dir, dir2]);
      expect(result).toHaveLength(1);
      // dir 在前（高优先级），应优先
      expect(result[0].function.description).toBe("From first path（高优先级）");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("支持 CallbackTool 格式（{ function, callback }）", async () => {
    writeTool("callback-tool.mjs", `
export default {
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

    const result = await discoverUserTools([dir]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(CallbackTool);
    expect(result[0].function.name).toBe("my_callback");
  });

  it("跳过加载失败的文件", async () => {
    writeTool("bad-syntax.mjs", `export default { this is invalid syntax }`);
    writeTool("good-tool.js", simpleToolCode("good_tool", "Good tool"));

    const result = await discoverUserTools([dir]);
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe("good_tool");
  });

  it(".js 工具 exec 方法可正常调用", async () => {
    writeTool("adder.js", `
export default {
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

    const result = await discoverUserTools([dir]);
    expect(result).toHaveLength(1);

    const mockCtx = {
      parsed_args: { a: 3, b: 4 },
      agent: null,
    };
    const output = await result[0].exec(mockCtx as any);
    expect(output).toBe("7");
  });

  it(".mjs 工具 exec 方法可正常调用", async () => {
    writeTool("mjs-adder.mjs", `
export default {
  function: {
    name: "mjs_adder",
    description: "Add from ESM",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" }
      },
      required: ["a", "b"]
    }
  },
  exec: async function(args) {
    return String(args.a + args.b);
  }
};
`);

    const result = await discoverUserTools([dir]);
    expect(result).toHaveLength(1);

    const mockCtx = { parsed_args: { a: 10, b: 20 }, agent: null };
    const output = await result[0].exec(mockCtx as any);
    expect(output).toBe("30");
  });

  it("空导出不报错", async () => {
    writeTool("empty.mjs", `export default {};`);

    const result = await discoverUserTools([dir]);
    expect(result).toHaveLength(0);
  });

  it("加载 .mjs 文件（export default）", async () => {
    writeTool("mjs-tool.mjs", `
export default {
  function: {
    name: "mjs_tool",
    description: "ESM module tool",
    parameters: { type: "object", properties: {}, required: [] }
  },
  exec: async function(args) {
    return "from esm";
  }
};
`);

    const result = await discoverUserTools([dir]);
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe("mjs_tool");
    expect(result[0]).toBeInstanceOf(Tool);
  });

  it("加载 .js 文件（export default）", async () => {
    writeTool("js-tool.js", `
export default {
  function: {
    name: "js_tool",
    description: "JS module tool",
    parameters: { type: "object", properties: {}, required: [] }
  },
  exec: async function(args) {
    return "from js";
  }
};
`);

    const result = await discoverUserTools([dir]);
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe("js_tool");
    expect(result[0]).toBeInstanceOf(Tool);
  });

  it("加载 .mjs 文件（export 具名）", async () => {
    writeTool("named-export.mjs", `
export const toolFn = {
  name: "named_export_tool",
  description: "Tool with named export",
  parameters: { type: "object", properties: {}, required: [] }
};
export async function exec(args) {
  return "from named export";
}
`);

    const result = await discoverUserTools([dir]);
    // 具名 export，mod.default 为 undefined，mod 本身是命名空间对象
    // normalizeToolExport 会 fallback 到 mod 自身，不含 {function, exec} 格式
    expect(result).toHaveLength(0);
  });

  it("同名 .js 和 .mjs 文件不冲突（只加载一个）", async () => {
    writeTool("shared.mjs", `export default { function: { name: "shared", description: "from .mjs", parameters: { type: "object", properties: {}, required: [] } }, exec: async () => "mjs" };`);
    writeTool("shared.js", simpleToolCode("shared", "from .js"));

    const result = await discoverUserTools([dir]);
    // 同名文件只加载先遇到的那个（按文件名排序，shared.js 排在 shared.mjs 前）
    expect(result).toHaveLength(1);
  });
});
