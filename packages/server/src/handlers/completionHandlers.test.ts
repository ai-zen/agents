/**
 * `completion.*` 接线壳的验收：方法齐、转发、未就绪的那句话按连接语言渲染（D8 / D7）。
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Language } from "../i18n/index.js";
import type { MethodCallContext } from "../net/WsHub.js";
import { CompletionService } from "../services/CompletionService.js";
import type { MethodName } from "../wire/index.js";
import { createCompletionHandlers } from "./completionHandlers.js";

const WORKSPACE_ID = "ws-1";

let dataRoot: string;
let project: string;
let handlers: ReturnType<typeof createCompletionHandlers>;

function call<M extends MethodName>(
  method: M,
  params: unknown,
  language: Language = "en",
): MethodCallContext<M> {
  return {
    method,
    params: params as MethodCallContext<M>["params"],
    connection: { id: "conn-1", language, clientInfo: null, credentialId: null },
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "ai-zen-completion-handlers-"));
  project = join(dataRoot, "project");
  await mkdir(project, { recursive: true });
  handlers = createCompletionHandlers({
    completion: new CompletionService({
      findWorkspace: (workspaceId) => (workspaceId === WORKSPACE_ID ? { cwd: project } : undefined),
      runGit: async () => ({ ok: false, files: [], reason: "not a repository" }),
    }),
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("createCompletionHandlers", () => {
  it("completion.files 注册上了", () => {
    expect(Object.keys(handlers)).toEqual(["completion.files"]);
  });

  it("未就绪的那句话说成连接的语言", async () => {
    const en = await handlers["completion.files"]!(
      call("completion.files", { workspaceId: WORKSPACE_ID, prefix: "" }, "en"),
    );
    expect(en.state).toBe("scanning");
    expect(en.problem?.messageKey).toBe("completion.scanning");
    expect(en.problem?.message).toContain("file list");

    const zh = await handlers["completion.files"]!(
      call("completion.files", { workspaceId: WORKSPACE_ID, prefix: "" }, "zh"),
    );
    expect(zh.problem?.message).toContain("文件清单");
  });
});
