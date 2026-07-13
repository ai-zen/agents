/**
 * 15 个内置工具名称（代码写死）。
 * 这些工具由运行时直接提供实现，不走用户工具加载。
 */
export const BUILTIN_TOOLS = [
  "cwd",
  "readFile",
  "writeFile",
  "batchEdit",
  "mkdir",
  "rm",
  "glob",
  "ls",
  "exist",
  "exec",
  "findText",
  "downloadFile",
  "generateImage",
  "rename",
  "copy",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOLS)[number];
