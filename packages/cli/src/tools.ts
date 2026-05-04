import { CallbackTool } from "@ai-zen/agents-core";
import { exec } from "child_process";
import * as fsp from "fs/promises";
import * as path from "path";

export const cwd = new CallbackTool({
  function: {
    name: "cwd",
    description: "获取当前工作目录 cwd",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  async callback(): Promise<string> {
    return process.cwd();
  },
});

export const readFileTool = new CallbackTool({
  function: {
    name: "readFile",
    description: "读取文件",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    try {
      // 先获取文件大小
      const stats = await fsp.stat(input.path as string);
      // 正常的代码文件不会超过 300KB
      if (stats.size > 300 * 1024) {
        throw new Error(`文件过大，无法读取，当前文件大小 ${stats.size} 字节`);
      }
      const result = await fsp.readFile(input.path as string, "utf-8");
      return result;
    } catch (error: any) {
      return error?.message;
    }
  },
});

export const writeFileTool = new CallbackTool({
  function: {
    name: "writeFile",
    description: "写入文件",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径",
        },
        content: {
          type: "string",
          description: "文件内容",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    try {
      await fsp.mkdir(path.dirname(input.path as string), { recursive: true });
      await fsp.writeFile(input.path as string, input.content as string);
      return "success";
    } catch (error: any) {
      return error?.message;
    }
  },
});

// export const replaceTool = new CallbackTool({
//   function: {
//     name: "replace",
//     description: "替换文件文本",
//     parameters: {
//       type: "object",
//       properties: {
//         path: {
//           type: "string",
//           description: "文件路径",
//         },
//         oldText: {
//           type: "string",
//           description: "要替换的文本",
//         },
//         newText: {
//           type: "string",
//           description: "替换后的文本",
//         },
//       },
//       required: ["path", "oldText", "newText"],
//       additionalProperties: false,
//     },
//   },
//   async callback(input): Promise<string> {
//     try {
//       const content = await fsp.readFile(input.path as string, "utf-8");
//       if (!content.includes(input.oldText as string)) {
//         throw new Error(`文件中未精确匹配到要替换的文本`);
//       }
//       const newContent = content.replace(
//         input.oldText as string,
//         input.newText as string,
//       );
//       if (!newContent.includes(input.newText as string)) {
//         throw new Error(`尝试替换之后，文件中未找到替换后的文本`);
//       }
//       await fsp.writeFile(input.path as string, newContent);
//       return "success";
//     } catch (error: any) {
//       return error?.message;
//     }
//   },
// });

// export const replaceAllTool = new CallbackTool({
//   function: {
//     name: "replaceAll",
//     description: "替换文件所有文本",
//     parameters: {
//       type: "object",
//       properties: {
//         path: {
//           type: "string",
//           description: "文件路径",
//         },
//         oldText: {
//           type: "string",
//           description: "要替换的文本",
//         },
//         newText: {
//           type: "string",
//           description: "替换后的文本",
//         },
//       },
//       required: ["path", "oldText", "newText"],
//       additionalProperties: false,
//     },
//   },
//   async callback(input): Promise<string> {
//     try {
//       const content = await fsp.readFile(input.path as string, "utf-8");
//       if (!content.includes(input.oldText as string)) {
//         throw new Error(`文件中未精确匹配到要替换的文本`);
//       }
//       const newContent = content.replaceAll(
//         input.oldText as string,
//         input.newText as string,
//       );
//       if (!newContent.includes(input.newText as string)) {
//         throw new Error(`尝试替换之后，文件中未找到替换后的文本`);
//       }
//       await fsp.writeFile(input.path as string, newContent);
//       return "success";
//     } catch (error: any) {
//       return error?.message;
//     }
//   },
// });

export const batchReplaceTool = new CallbackTool({
  function: {
    name: "batchReplace",
    description: "批量替换文件文本，可以优先使用这个工具对文件进行编辑",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径",
        },
        replacements: {
          type: "array",
          description: "要替换的文本数组",
          items: {
            type: "object",
            properties: {
              oldText: {
                type: "string",
                description: "要替换的文本",
              },
              newText: {
                type: "string",
                description: "替换后的文本",
              },
              isReplaceAll: {
                type: "boolean",
                description:
                  "是否替换所有匹配的文本，使用此功能前应确保你提供的 oldText 足够精确，避免误替换",
              },
            },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "replacements"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    try {
      const content = await fsp.readFile(input.path as string, "utf-8");
      let newContent = content;
      const results: {
        oldText: string;
        newText: string;
        result: string;
      }[] = [];
      for (const replacement of input.replacements as any[]) {
        if (!newContent.includes(replacement.oldText as string)) {
          results.push({
            oldText: replacement.oldText as string,
            newText: replacement.newText as string,
            result: `文件中未精确匹配到要替换的文本`,
          });
          continue;
        }
        if (replacement.isReplaceAll) {
          newContent = newContent.replaceAll(
            replacement.oldText as string,
            replacement.newText as string,
          );
        } else {
          newContent = newContent.replace(
            replacement.oldText as string,
            replacement.newText as string,
          );
        }
        if (!newContent.includes(replacement.newText as string)) {
          results.push({
            oldText: replacement.oldText as string,
            newText: replacement.newText as string,
            result: `尝试替换之后，文件中未找到替换后的文本`,
          });
          continue;
        }
        results.push({
          oldText: replacement.oldText as string,
          newText: replacement.newText as string,
          result: `success`,
        });
      }
      await fsp.writeFile(input.path as string, newContent);
      return JSON.stringify(results);
    } catch (error: any) {
      return error?.message;
    }
  },
});

// export const readdirTool = new CallbackTool({
//   function: {
//     name: "readdir",
//     description: "列出目录",
//     parameters: {
//       type: "object",
//       properties: {
//         path: {
//           type: "string",
//           description: "目录路径",
//         },
//         recursive: {
//           type: "boolean",
//           description: "是否递归列出子目录",
//         },
//       },
//       required: ["path"],
//       additionalProperties: false,
//     },
//   },
//   async callback(input): Promise<string> {
//     try {
//       const result = await fsp.readdir(input.path as string, {
//         recursive: input.recursive as boolean,
//       });
//       return JSON.stringify(result);
//     } catch (error: any) {
//       return error?.message;
//     }
//   },
// });

export const mkdirTool = new CallbackTool({
  function: {
    name: "mkdir",
    description: "创建目录",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "目录路径",
        },
        recursive: {
          type: "boolean",
          description: "是否递归创建子目录",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    try {
      await fsp.mkdir(input.path as string, {
        recursive: input.recursive as boolean,
      });
      return "success";
    } catch (error: any) {
      return error?.message;
    }
  },
});

export const rmTool = new CallbackTool({
  function: {
    name: "rm",
    description: "删除文件或目录",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件或目录路径",
        },
        recursive: {
          type: "boolean",
          description: "是否递归删除子目录",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    try {
      await fsp.rm(input.path as string, {
        recursive: input.recursive as boolean,
      });
      return "success";
    } catch (error: any) {
      return error?.message;
    }
  },
});

export const globTool = new CallbackTool({
  function: {
    name: "glob",
    description:
      "使用 glob 模式递归扫描和查找文件。这是进行文件系统搜索的首选工具，功能远优于简单的 'ls' 列表命令。当你需要查找特定类型的文件、遍历目录树或需要排除特定文件时，请优先使用此函数。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "glob cwd",
        },
        pattern: {
          type: "string",
          description: "glob pattern",
        },
        exclude: {
          type: "array",
          description: "glob pattern to exclude",
          items: {
            type: "string",
          },
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    try {
      const result = [];
      for await (const file of fsp.glob(input.pattern as string, {
        exclude: (input.exclude as string[]) || ["**/node_modules/**"],
        cwd: input.path,
      })) {
        result.push(file);
      }
      return JSON.stringify(result);
    } catch (error: any) {
      return error?.message;
    }
  },
});

export const lsTool = new CallbackTool({
  function: {
    name: "ls",
    description: "列出目录",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "目录路径",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    try {
      const result = await fsp.readdir(input.path as string);
      return JSON.stringify(result);
    } catch (error: any) {
      return error?.message;
    }
  },
});

export const existTool = new CallbackTool({
  function: {
    name: "exist",
    description: "检查文件或目录是否存在",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
        },
      },
    },
  },
  async callback(input): Promise<string> {
    return await fsp
      .access(input.path as string)
      .then(() => "true")
      .catch(() => "false");
  },
});

export const execTool = new CallbackTool({
  function: {
    name: "exec",
    description: "执行命令",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的命令",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    const result = await new Promise((resolve) => {
      exec(input.command as string, (error, stdout, stderr) => {
        // 不用管 error 对象，直接返回 stdout，以确保能拿到实际的错误信息
        resolve({ stdout, stderr });
      });
    });
    return JSON.stringify(result);
  },
});

export const findTextTool = new CallbackTool({
  function: {
    name: "findText",
    description: "查找文本出现的位置",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "glob cwd",
        },
        pattern: {
          type: "string",
          description: "glob pattern",
        },
        text: {
          type: "string",
          description: "要查找的文本",
        },
        exclude: {
          type: "array",
          description: "要排除的 glob 模式数组",
          items: {
            type: "string",
          },
        },
      },
      required: ["path", "pattern", "text"],
    },
  },
  async callback(input): Promise<string> {
    try {
      const result = [];
      for await (const file of fsp.glob(input.pattern as string, {
        cwd: input.path,
        exclude: (input.exclude as string[]) || ["**/node_modules/**"],
      })) {
        const fullPath = path.join(input.path as string, file);
        const stats = await fsp.stat(fullPath);
        if (stats.isFile()) {
          const content = await fsp.readFile(fullPath, "utf-8");
          if (content.includes(input.text as string)) {
            result.push(file);
          }
        }
      }
      return JSON.stringify(result);
    } catch (error: any) {
      return error?.message;
    }
  },
});

export const allTools = [
  cwd,
  readFileTool,
  writeFileTool,
  // replaceTool,
  // replaceAllTool,
  batchReplaceTool,
  // readdirTool,
  mkdirTool,
  rmTool,
  globTool,
  lsTool,
  existTool,
  execTool,
  findTextTool,
];
