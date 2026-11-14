/**
 * `config.*` 接线壳的验收。
 *
 * 接线壳自己的两件事：把入参交给服务、把出参里的句子按**这条连接**的语言重渲染（D8）。
 * 另外确认七个方法都注册上了（漏一个客户端就会拿到 `unsupported`）。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ConfigManager } from "@ai-zen/agents-sdk";
import type { AppConfig } from "@ai-zen/agents-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MethodCallContext } from "../net/WsHub.js";
import { ConfigService } from "../services/ConfigService.js";
import type { Language } from "../i18n/index.js";
import type { ConfigGetResult, MethodName } from "../wire/index.js";
import { createConfigHandlers, localizeLocalizedTexts } from "./configHandlers.js";

let dataRoot: string;
let configService: ConfigService;
let handlers: ReturnType<typeof createConfigHandlers>;

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
}

/** 造一次调用的现场（只需要 `language` 与 `params`） */
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

function baseConfig(): AppConfig {
  return {
    endpoints: [
      { id: "ep-a", name: "Endpoint A", baseUrl: "https://a.example/v1", apiKey: "sk-aaaaaaaa1111" },
      { id: "ep-empty", name: "Endpoint Empty", baseUrl: "https://e.example/v1", apiKey: "" },
    ],
    models: [
      {
        id: "m-a1",
        name: "Model A1",
        endpointId: "ep-a",
        tokenThresholds: { handoff: 100, guard: 150 },
      },
    ],
    defaultModel: "m-missing",
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "ai-zen-config-handlers-"));
  await writeJson(join(dataRoot, "config.json"), baseConfig());
  await writeJson(join(dataRoot, "reasoning-presets.json"), {});
  configService = new ConfigService({
    configManager: new ConfigManager(join(dataRoot, "config.json")),
  });
  handlers = createConfigHandlers({ config: configService });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("createConfigHandlers", () => {
  it("八个方法都注册上了", () => {
    expect(Object.keys(handlers).sort()).toEqual([
      "config.deleteEndpoint",
      "config.deleteMcp",
      "config.get",
      "config.getDiscovery",
      "config.patch",
      "config.saveEndpoint",
      "config.saveMcp",
      "config.setDefaults",
    ]);
  });

  it("config.get 把句子换成这条连接的语言", async () => {
    const en = (await handlers["config.get"]!(call("config.get", {}, "en"))) as ConfigGetResult;
    const zh = (await handlers["config.get"]!(call("config.get", {}, "zh"))) as ConfigGetResult;

    const enIssue = en.issues.find((issue) => issue.code === "endpoint_no_key");
    const zhIssue = zh.issues.find((issue) => issue.code === "endpoint_no_key");
    expect(enIssue?.text.messageKey).toBe("endpoint.noKey");
    expect(zhIssue?.text.messageKey).toBe("endpoint.noKey");
    expect(enIssue?.text.message).toContain("no access key");
    expect(zhIssue?.text.message).toContain("密钥");
  });

  it("config.patch 与 config.setDefaults 转发并回完整配置", async () => {
    const patched = await handlers["config.patch"]!(
      call("config.patch", { patch: { limits: { maxToolOutput: 1_024 } } }),
    );
    expect(patched.config.limits.maxToolOutput).toBe(1_024);
    expect(patched.applied.reloaded.config).toBe(true);

    const defaults = await handlers["config.setDefaults"]!(
      call("config.setDefaults", { defaults: { defaultModel: "m-a1" } }),
    );
    expect(defaults.config.defaults.defaultModel).toBe("m-a1");
  });

  it("config.saveEndpoint / config.deleteEndpoint 转发", async () => {
    const saved = await handlers["config.saveEndpoint"]!(
      call("config.saveEndpoint", {
        endpoint: { id: "ep-b", name: "B", baseUrl: "https://b.example/v1", apiKey: "sk-bbbbbbbb2222" },
      }),
    );
    expect(saved.endpoint.apiKeyMasked).not.toContain("bbbbbbbb");
    expect(saved.endpoint.apiKeySet).toBe(true);

    const removed = await handlers["config.deleteEndpoint"]!(
      call("config.deleteEndpoint", { endpointId: "ep-b" }),
    );
    expect(removed.removed).toBe(true);
  });

  it("config.getDiscovery / config.saveMcp / config.deleteMcp 转发（没给项目就只报用户级那几层）", async () => {
    const discovery = await handlers["config.getDiscovery"]!(call("config.getDiscovery", {}));
    expect(discovery.discovery.workspaceId).toBeNull();
    expect(discovery.discovery.mcps.map((layer) => layer.depth)).toEqual([3, 4]);
    expect(discovery.discovery.mcps.map((layer) => layer.scope)).toEqual(["user", null]);

    const written = await handlers["config.saveMcp"]!(
      call("config.saveMcp", {
        scope: "user",
        entry: { id: "pty", transport: "stdio", command: "npx" },
      }),
    );
    expect(written.layer.path).toBe(join(dataRoot, "mcp.json"));
    expect(written.applied.reloaded.mcp).toBe(true);
    expect(written.layer.entries.map((entry) => entry.id)).toEqual(["pty"]);

    const removed = await handlers["config.deleteMcp"]!(
      call("config.deleteMcp", { scope: "user", id: "pty" }),
    );
    expect(removed.removed).toBe(true);
    expect(removed.layer.entries).toEqual([]);
  });
});

describe("localizeLocalizedTexts", () => {
  it("嵌套结构里的每一处 LocalizedText 都重渲染，其余字段原样", () => {
    const input = {
      name: "x",
      problem: {
        code: "endpoint.noKey",
        messageKey: "endpoint.noKey",
        params: { endpoint: "E" },
        message: "rendered in en",
        detail: { reason: "no_key" },
      },
      list: [
        { code: "error.notFound", messageKey: "error.notFound", params: { entity: "端点" }, message: "en" },
      ],
    };
    const zh = localizeLocalizedTexts(input, "zh");
    expect(zh.problem.message).toContain("密钥");
    expect(zh.problem.detail).toEqual({ reason: "no_key" });
    expect(zh.list[0]?.message).toContain("端点");
    expect(zh.name).toBe("x");
  });

  it("认不出来的文案键原样留着（不吞字段）", () => {
    const input = {
      code: "x",
      messageKey: "not.a.real.key",
      params: {},
      message: "keep me",
    };
    expect(localizeLocalizedTexts(input, "zh")).toEqual(input);
  });
});
