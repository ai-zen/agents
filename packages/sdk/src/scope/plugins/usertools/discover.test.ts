import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { discoverUserToolFiles, discoverUserTools } from "./discover.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Tool, CallbackTool } from "@ai-zen/agents-core";
import { setLogger } from "../../../shared/logger.js";

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

/** 把 SDK logger 换成采集器：拒绝原因走 logger，不走任何回调 API */
function captureLogs(): Array<[string, string]> {
  const logs: Array<[string, string]> = [];
  setLogger({
    info: (m) => logs.push(["info", m]),
    warn: (m) => logs.push(["warn", m]),
    error: (m) => logs.push(["error", m]),
  });
  return logs;
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
      writeTool("shared.mjs", simpleToolCode("shared_tool", "From first path (higher priority)"));
      writeFileSync(
        join(dir2, "shared.js"),
        simpleToolCode("shared_tool", "From second path (lower priority)"),
      );

      const result = await discoverUserTools([dir, dir2]);
      expect(result).toHaveLength(1);
      // dir 在前（高优先级），应优先
      expect(result[0].function.description).toBe("From first path (higher priority)");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("支持 CallbackTool 格式（{ function, callback }）", async () => {
    writeTool(
      "callback-tool.mjs",
      `
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
`,
    );

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
    writeTool(
      "adder.js",
      `
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
`,
    );

    const result = await discoverUserTools([dir]);
    expect(result).toHaveLength(1);

    const mockCtx = {
      parsedArgs: { a: 3, b: 4 },
      agent: null,
    };
    const output = await result[0].exec(mockCtx as any);
    expect(output).toBe("7");
  });

  it(".mjs 工具 exec 方法可正常调用", async () => {
    writeTool(
      "mjs-adder.mjs",
      `
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
`,
    );

    const result = await discoverUserTools([dir]);
    expect(result).toHaveLength(1);

    const mockCtx = { parsedArgs: { a: 10, b: 20 }, agent: null };
    const output = await result[0].exec(mockCtx as any);
    expect(output).toBe("30");
  });

  it("空导出不报错", async () => {
    writeTool("empty.mjs", `export default {};`);

    const result = await discoverUserTools([dir]);
    expect(result).toHaveLength(0);
  });

  it("加载 .mjs 文件（export default）", async () => {
    writeTool(
      "mjs-tool.mjs",
      `
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
`,
    );

    const result = await discoverUserTools([dir]);
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe("mjs_tool");
    expect(result[0]).toBeInstanceOf(Tool);
  });

  it("加载 .js 文件（export default）", async () => {
    writeTool(
      "js-tool.js",
      `
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
`,
    );

    const result = await discoverUserTools([dir]);
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe("js_tool");
    expect(result[0]).toBeInstanceOf(Tool);
  });

  it("加载 .mjs 文件（export 具名）", async () => {
    writeTool(
      "named-export.mjs",
      `
export const toolFn = {
  name: "named_export_tool",
  description: "Tool with named export",
  parameters: { type: "object", properties: {}, required: [] }
};
export async function exec(args) {
  return "from named export";
}
`,
    );

    const result = await discoverUserTools([dir]);
    // 具名 export，mod.default 为 undefined，mod 本身是命名空间对象
    // normalizeToolExport 会 fallback 到 mod 自身，不含 {function, exec} 格式
    expect(result).toHaveLength(0);
  });

  it("同名 .js 和 .mjs 文件不冲突（只加载一个）", async () => {
    writeTool(
      "shared.mjs",
      `export default { function: { name: "shared", description: "from .mjs", parameters: { type: "object", properties: {}, required: [] } }, exec: async () => "mjs" };`,
    );
    writeTool("shared.js", simpleToolCode("shared", "from .js"));

    const result = await discoverUserTools([dir]);
    // 同名文件只加载先遇到的那个（按文件名排序，shared.js 排在 shared.mjs 前）
    expect(result).toHaveLength(1);
  });
});

// ==================================================================
// 宿主护栏：tools/ 目录里的「坏文件」不能伤到宿主
// ==================================================================
//
// 起因是一次真实事故：用户把一次性开发脚本（无参数时 `process.exit(2)`）放进
// tools 目录，于是每次启动都在初始化途中被脚本杀掉；另有脚本在顶层直接写 PNG。
// 这一组用例把四类危害逐个钉住。
describe("discoverUserTools —— 坏文件不能伤到宿主", () => {
  it("没有 export 的文件：跳过且**不执行**（顶层副作用不会发生）", async () => {
    const marker = join(dir, "executed.marker");
    writeTool(
      "cli-script.mjs",
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(marker)}, "ran");\n` +
        `console.log("顶层副作用");\n`,
    );
    const logs = captureLogs();

    const result = await discoverUserTools([dir]);

    expect(result).toEqual([]);
    // 关键：连求值的机会都不给，副作用根本没发生
    expect(existsSync(marker)).toBe(false);
    const warned = logs.filter(([level]) => level === "warn");
    expect(warned).toHaveLength(1);
    expect(warned[0]![1]).toContain("cli-script.mjs");
    expect(warned[0]![1]).toContain("no `export`");
  });

  it("顶层 process.exit()：抑制成异常，宿主不退出，后续文件照常加载", async () => {
    // 有 export → 能过静态预检 → 必须靠执行期护栏兜住
    writeTool("a-fatal.mjs", `export default {};\nprocess.exit(2);\n`);
    writeTool("z-good.mjs", simpleToolCode("good_tool", "Good tool"));
    const logs = captureLogs();

    const result = await discoverUserTools([dir]);

    // 能走到这里就说明宿主还活着
    expect(result.map((t) => t.function.name)).toEqual(["good_tool"]);
    const failed = logs.filter(([level]) => level === "error");
    expect(failed).toHaveLength(1);
    expect(failed[0]![1]).toContain("a-fatal.mjs");
    expect(failed[0]![1]).toContain("process.exit(2)");
  });

  it("顶层 console.log：不写 stdout（宿主的界面），改写 stderr", async () => {
    writeTool("chatty.mjs", `console.log("SHOULD_NOT_REACH_STDOUT");\nexport default {};\n`);
    // 生产实现里护栏把 console.log 指到 console.error（→ stderr）；vitest 自己也接管了
    // console，所以这里断言「出口」而不是「绑定」：stdout 一个字没收到、error 收到了。
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await discoverUserTools([dir], { silent: true });
      const stdoutText = outSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(stdoutText).not.toContain("SHOULD_NOT_REACH_STDOUT");
      expect(errSpy.mock.calls.flat().join(" ")).toContain("SHOULD_NOT_REACH_STDOUT");
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("顶层 await 永不 settle：超时放弃，不拖死启动", async () => {
    writeTool("hangs.mjs", `await new Promise(() => {});\nexport default {};\n`);
    const logs = captureLogs();
    const t0 = Date.now();

    const result = await discoverUserTools([dir], { importTimeoutMs: 100 });

    expect(result).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(3000);
    const failed = logs.filter(([level]) => level === "error");
    expect(failed[0]![1]).toContain("timed out");
  });

  it("护栏用完即还原：process.exit / console.log 变回原函数（宿主还能退出）", async () => {
    writeTool("ok.mjs", simpleToolCode("ok_tool", "ok"));
    const realExit = process.exit;
    const realLog = console.log;

    await discoverUserTools([dir], { silent: true });

    expect(process.exit).toBe(realExit);
    expect(console.log).toBe(realLog);
  });
});

/**
 * 文件级出口：与 `discoverUserTools` 共用同一条扫描规则，只是把「文件」也交出来。
 *
 * 为什么需要它：`AssetSummary.path`（`asset.list` 的载荷）要的是文件本身，而 `Tool` 不记
 * 自己来自哪个文件。让调用方按工具名去目录里再找一遍，就等于把「目录顺序 / 同名去重 /
 * 扩展名」这套规则抄第二份 —— 两份扫描规则迟早不一致。
 */
describe("discoverUserToolFiles", () => {
  it("给出文件路径与文件名，顺序与 discoverUserTools 逐条一致", async () => {
    writeTool("b_tool.mjs", simpleToolCode("b_tool", "b"));
    writeTool("a_tool.js", simpleToolCode("a_tool", "a"));

    const files = await discoverUserToolFiles([dir], { silent: true });
    const tools = await discoverUserTools([dir], { silent: true });

    expect(files.map((item) => item.name)).toEqual(["a_tool", "b_tool"]);
    expect(files.map((item) => item.path)).toEqual([
      join(dir, "a_tool.js"),
      join(dir, "b_tool.mjs"),
    ]);
    // 同一个工具实例、同一个顺序：两个出口不是两条扫描
    expect(files.map((item) => item.tool)).toEqual(tools);
  });

  it("靠前的目录优先：同名文件只出靠前那一个（去重规则也没分叉）", async () => {
    const other = mkdtempSync(join(tmpdir(), "ai-zen-usertools-other-"));
    try {
      writeTool("same.mjs", simpleToolCode("same", "from-first"));
      writeFileSync(join(other, "same.mjs"), simpleToolCode("same", "from-second"));

      const files = await discoverUserToolFiles([dir, other], { silent: true });

      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(join(dir, "same.mjs"));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
