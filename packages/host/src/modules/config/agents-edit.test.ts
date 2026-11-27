/**
 * AgentDefinition 与 subagent 的写入口。
 *
 * 这一份验的是那三条判据落到这一个域上的样子：
 *
 * 1. 写进去的非法值被拒且改动留住：标识不是文件名安全的、模板里没有系统提示、参数结构是
 *    一段坏 JSON，三种都被拒在写盘之前 —— 磁盘那一份一个字都不动（改动留在编辑器里是客户端
 *    的事，宿主只保证不接受）；
 * 2. 多行内容原样存：提示词与参数结构都是编辑器里的多行文本，换行与缩进读回来逐字相等；
 * 3. 删与恢复出厂的连带：删默认 AgentDefinition 要连带清默认，恢复出厂要整条换回出厂定义并重新归入
 *    托管（`custom: false`）；
 * 4. 再建与再保存：同 id 再建一次是 `conflict`（磁盘那一份不被覆盖），什么都没改就再保存
 *    一次则不写盘（断言的是文件的修改时间没变）。
 *
 * 落盘全用真的：临时目录 + 真的 `AgentRepository` + 真的 `ConfigManager`。打桩存储只会验到桩，
 * 而这里问的正是「文件里落了什么」。
 */

import { statSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Message } from "@ai-zen/agents-core";
import type { AgentNS } from "@ai-zen/agents-core";
import type { AgentDefinition, AppConfig, ModelDefinition } from "@ai-zen/agents-sdk";
import {
  AgentRepository,
  ConfigManager,
  DEFAULT_AGENT_DEFINITION,
  DEFAULT_AGENT_ID,
} from "@ai-zen/agents-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import { createTranslator } from "../i18n/index.js";
import { AgentDefinitionService } from "./agents.js";
import type { ConfigEvent } from "./events.js";
import { GeneralConfig } from "./general.js";

let dir: string;
let agentsDir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-host-agents-edit-"));
  agentsDir = join(dir, "agents");
  configPath = join(dir, "config.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function model(id: string): ModelDefinition {
  return { id, name: id, endpointId: "ep-a", tokenThresholds: { handoff: 100, guard: 150 } };
}

/**
 * 起手那一份：默认项指着出厂的那个助教，模型表里有出厂定义绑的那一个（`reset` 之后写回去的
 * 是整条常量，写之前不校验模型，但 `add` 那几条要它）。
 */
const CONFIG: AppConfig = {
  endpoints: [{ id: "ep-a", name: "ep-a", baseUrl: "https://ep-a.example/v1", apiKey: "" }],
  models: [model("m-a"), model("deepseek-flash")],
  defaultAgent: DEFAULT_AGENT_ID,
  maxToolOutput: 32_768,
  abortedMessageStrategy: "keep",
  abortedToolRoundStrategy: "fill",
};

/** 一个真目录 + 真的 `AgentRepository` + 真的配置，加这一域的一处服务 */
async function newHost(config: AppConfig = CONFIG) {
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

  const manager = new ConfigManager(configPath);
  const t = createTranslator(() => "zh");
  const configEvents: ConfigEvent[] = [];
  const events = createBus<ConfigEvent>();
  events.subscribe((event) => configEvents.push(event));

  const general = new GeneralConfig({ config: manager, current: await manager.read(), events });

  const definitions = new AgentDefinitionService({
    repository: new AgentRepository(agentsDir),
    // 定义那一侧的事件这一份用例不验：它只是「这个 AgentDefinition 变了」的广播，读的人不在这一层
    events: createBus<ConfigEvent>(),
    t,
    general,
  });

  return { definitions, general, configEvents };
}

/** 一条最省事的合法定义：标识、名字、一条系统提示 */
function definition(
  overrides: Partial<Omit<AgentDefinition, "createdAt" | "updatedAt">> = {},
): Omit<AgentDefinition, "createdAt" | "updatedAt"> {
  return {
    id: "helper",
    name: "Helper",
    messages: [Message.System("你是一个AgentDefinition。")],
    ...overrides,
  };
}

/** 一条合法的 subagent：函数名、说明、参数结构俱全 */
function subagent(
  overrides: Partial<Omit<AgentDefinition, "createdAt" | "updatedAt">> = {},
): Omit<AgentDefinition, "createdAt" | "updatedAt"> {
  return definition({
    id: "sub-helper",
    name: "Sub helper",
    function: {
      name: "sub_helper",
      description: "一个可以独立完成任务的 subagent",
      parameters: { type: "object", properties: {}, required: [] },
    },
    ...overrides,
  });
}

/**
 * 这一段直接调服务，不经过 tRPC：抛出来的就是 `HostError` 本身（跨 wire 那一层只在 router
 * 上）。哪一次没抛错就是用例本身写错了，不是被测行为。
 */
async function errorOf(call: Promise<unknown>): Promise<HostError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof HostError) return error;
    throw error;
  }
  throw new Error("这一次调用没有抛错");
}

/** 磁盘上那份 `config.json` 的字面内容（不经过 `normalizeConfig`：缺的那一格要真的不出现） */
async function rawOnDisk(): Promise<AppConfig> {
  return JSON.parse(await readFile(configPath, "utf-8")) as AppConfig;
}

/** 定义目录里那几个文件的名字；目录还没建出来时是空的 */
async function filesInAgentsDir(): Promise<string[]> {
  return readdir(agentsDir).catch(() => []);
}

/** 去掉两个时间戳之后的那一份：出厂常量里没有它们，其余每一格都要与出厂逐字一样 */
function withoutTimestamps(
  definition: AgentDefinition,
): Omit<AgentDefinition, "createdAt" | "updatedAt"> {
  const { createdAt, updatedAt, ...rest } = definition;
  return rest;
}

describe("AgentDefinition：写之前的校验", () => {
  it("标识不是文件名安全的就拒：invalid_params，目录里一个文件都没多", async () => {
    const host = await newHost();

    const refused = await errorOf(host.definitions.add(definition({ id: "../evil" })));

    expect(refused.code).toBe("invalid_params");
    // 文案带上那个标识：客户端要能在对应那一格上标红
    expect(refused.message).toContain("../evil");
    expect(refused.details).toEqual({
      entity: "agentDefinition",
      agentDefinitionId: "../evil",
    });
    // 拒在写盘之前：仓储那边也会拒（它会抛一句英文的 `Invalid entity id`），但那是宿主的运行
    // 事故，客户端拿不到一条说得清的失败 —— 所以这里要看见目录里一个文件都没多
    expect(await filesInAgentsDir()).toEqual([]);
  });

  it("模板里没有系统提示就拒：这个AgentDefinition没有身份", async () => {
    const host = await newHost();

    const refused = await errorOf(
      host.definitions.add(definition({ messages: [Message.User("你是什么")] })),
    );

    expect(refused.code).toBe("invalid_params");
    expect(refused.message).toContain("system");
    expect(await filesInAgentsDir()).toEqual([]);
  });

  it("参数结构是一段坏 JSON：拒，且磁盘那一份与内存那一份都没变", async () => {
    const host = await newHost();
    const stored = await host.definitions.add(subagent());
    const path = join(agentsDir, `${stored.id}.json`);
    const before = await readFile(path, "utf-8");

    const refused = await errorOf(
      host.definitions.update(stored.id, {
        function: {
          ...(stored.function as AgentNS.FunctionDefine),
          // 编辑器里写坏的那一段，原样送过来
          parameters: "{ 坏" as unknown as AgentNS.FunctionDefine["parameters"],
        },
      }),
    );

    expect(refused.code).toBe("invalid_params");
    // 解析错误原样带上：客户端据此在编辑器里把位置标出来
    expect(refused.message).toContain("JSON");
    expect(refused.message).toContain(stored.id);
    // 文件一个字都没动，读回来的那一份也还是旧的
    expect(await readFile(path, "utf-8")).toBe(before);
    expect(await host.definitions.get(stored.id)).toEqual(stored);
  });

  it("参数结构是一段好 JSON：解析之后按对象存", async () => {
    const host = await newHost();
    const stored = await host.definitions.add(subagent());
    const schema = {
      type: "object",
      properties: { task: { type: "string", description: "要做什么" } },
      required: ["task"],
      additionalProperties: false,
    };

    const updated = await host.definitions.update(stored.id, {
      function: {
        ...(stored.function as AgentNS.FunctionDefine),
        parameters: JSON.stringify(schema) as unknown as AgentNS.FunctionDefine["parameters"],
      },
    });

    // 存下来的是对象，不是那段文本：此后读它的人都当对象用
    expect(typeof updated.function?.parameters).toBe("object");
    expect(updated.function?.parameters).toEqual(schema);
    // 磁盘上那一份也是对象（`get` 每次都从文件读）
    expect((await host.definitions.get(stored.id)).function?.parameters).toEqual(schema);
  });
});

describe("AgentDefinition：删与恢复出厂", () => {
  it("删默认AgentDefinition连带清默认：内存与磁盘上那一格都没了", async () => {
    const host = await newHost();
    await host.definitions.add(definition({ id: DEFAULT_AGENT_ID, name: "默认AgentDefinition" }));
    expect(host.general.read().defaultAgent).toBe(DEFAULT_AGENT_ID);

    await host.definitions.remove(DEFAULT_AGENT_ID);

    expect(host.general.read().defaultAgent).toBeUndefined();
    // `undefined` 那一格在文件里就是不出现（与默认项那几条同一套口径）
    expect("defaultAgent" in (await rawOnDisk())).toBe(false);
    expect(await filesInAgentsDir()).toEqual([]);
  });

  it("恢复出厂：整条换回出厂那一条、custom 置回 false；不是出厂的 id 是 not_found", async () => {
    const host = await newHost();
    // 改得面目全非：名称、提示词都换掉，还标了「这是我自己的」（那样启动时的出厂同步就会跳过它）
    await host.definitions.add({
      ...DEFAULT_AGENT_DEFINITION,
      name: "我改过的名字",
      messages: [Message.System("我改过的提示词")],
      custom: true,
      version: 7,
    });

    const reset = await host.definitions.reset(DEFAULT_AGENT_ID);

    // 整条换，不是把出厂那几格叠上去：用户改过的名称、提示词、多出来的 `version` 一并退场
    expect(withoutTimestamps(reset)).toEqual({ ...DEFAULT_AGENT_DEFINITION, custom: false });
    // 重新归入托管：下一次启动的出厂同步会继续按出厂内容校它的提示词
    expect(reset.custom).toBe(false);
    // 写回磁盘的与返回的是同一份事实
    expect(await host.definitions.get(DEFAULT_AGENT_ID)).toEqual(reset);

    const notFactory = await errorOf(host.definitions.reset("我自己建的"));
    expect(notFactory.code).toBe("not_found");
    expect(notFactory.message).toContain("不是出厂的那两个AgentDefinition之一");
  });
});

describe("AgentDefinition：多行内容", () => {
  it("多行提示词原样存：换行与缩进读回来逐字相等", async () => {
    const host = await newHost();
    const prompt = [
      "你是一个严谨的AgentDefinition。",
      "",
      "## 工作方式",
      "  1. 先读文件再改文件",
      "  2. 一次只问一个问题",
      "",
    ].join("\n");

    const stored = await host.definitions.add(definition({ messages: [Message.System(prompt)] }));

    // 写进去的那一份、从文件读回来的那一份，都是这一段原文
    expect(stored.messages[0]?.content).toBe(prompt);
    expect((await host.definitions.get(stored.id)).messages[0]?.content).toBe(prompt);
    const onDisk = JSON.parse(await readFile(join(agentsDir, `${stored.id}.json`), "utf-8"));
    expect(onDisk.messages[0].content).toBe(prompt);
  });
});

describe("AgentDefinition：再建与再保存", () => {
  it("同一个 id 再建一次是 conflict，磁盘那一份没被覆盖", async () => {
    const host = await newHost();
    const first = await host.definitions.add(definition({ name: "第一次建的名字" }));
    const path = join(agentsDir, `${first.id}.json`);
    const before = await readFile(path, "utf-8");

    const refused = await errorOf(
      host.definitions.add(definition({ id: first.id, name: "第二次建的名字" })),
    );

    expect(refused.code).toBe("conflict");
    // 客户端据此说清是哪个 id 已经在：同 id 两条定义等于「引用的是哪一条」没有答案
    expect(refused.details).toEqual({ entity: "agentDefinition", agentDefinitionId: first.id });
    // 拒在写盘之前：文件里还是第一次那份，名字没被第二次那一次静默盖掉
    expect(await readFile(path, "utf-8")).toBe(before);
    expect(await host.definitions.get(first.id)).toEqual(first);
  });

  it("什么都没改再保存一次：不写盘", async () => {
    const host = await newHost();
    const stored = await host.definitions.add(definition());
    const path = join(agentsDir, `${stored.id}.json`);
    const before = statSync(path).mtimeMs;
    // 修改时间可能粗到一毫秒：先把它推开一点。真写了盘的话，新时间一定比这个基准新
    await sleep(20);

    // 客户端「点了保存」但一个字都没改：手里那份去掉 id 与两个时间戳，原样送回去
    const { id: _id, createdAt: _createdAt, updatedAt, ...same } = stored;
    const saved = await host.definitions.update(stored.id, same);

    // 断言的是文件没被重写（不是内容一样 —— 内容当然一样）：mtime 只在写的那一刻变
    expect(statSync(path).mtimeMs).toBe(before);
    // `updatedAt` 也不是「用户点了一次保存」的时刻：没改动就不该被推到当前
    expect(saved.updatedAt).toBe(updatedAt);
    // 返回的就是当前那一份，逐字一样（客户端不必再叠补丁）
    expect(JSON.stringify(saved)).toBe(JSON.stringify(stored));
  });
});
