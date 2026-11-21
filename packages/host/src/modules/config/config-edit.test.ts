/**
 * 配置面的读与改（`config.json` 与思考档位表那一半）。
 *
 * 这一份验的是 `prd/PLAN.md` 第 9 行那三条判据落到代码上的样子：
 *
 * 1. **删之前说清还有谁指它**：删端点时还挂着模型 → `conflict`，并说清是哪几个；
 * 2. **没改就不写盘**：合出来与当前逐字一样 → 文件一个字都不动（这一条断言的是**文件的
 *    修改时间没变**，见那一条用例的注释）；
 * 3. **非法值被拒且改动留住**：形状不对的档位补丁、指不到东西的默认项都被拒，磁盘那份不变。
 *
 * 另外两条是同一条判据的另一半：删图片模型时默认项要改指（不然默认项指着一条不在的），
 * 改中断策略时活着的执行体要当场按新的走（不然「下一句话就按新的来」只在文件层面成立）。
 *
 * 语言也是全局那几格之一（`setGlobal` 是它的写口，不另开一条 procedure）：写完宿主那份语言当场
 * 跟着变（`t` 在调用那一刻现读，不重建任何执行体），非法值在边界上被拒、文件一个字都不动。
 *
 * 落盘全用真的：临时目录 + 真的 `ConfigManager`（打桩磁盘只会验到桩）。只有执行体那一条给
 * `runtime` / `workspaces` / `sessions` 替身 —— 造一个真的运行时得先有一个能出网的模型，
 * 而那条用例问的是「哪几格被赋了新值」。
 */

import { statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  AgentRuntime,
  AppConfig,
  Endpoint,
  ImageModel,
  Model,
  ReasoningPresets,
} from "@ai-zen/agents-sdk";
import { ConfigManager, DEFAULT_APP_CONFIG } from "@ai-zen/agents-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import { configRouter } from "../api/config.js";
import type { HostApiDeps } from "../api/deps.js";
import { createTrpc } from "../api/trpc.js";
import { createTranslator } from "../i18n/index.js";
import type { AgentDefinitionService } from "./agents.js";
import { EndpointService } from "./endpoints.js";
import type { ConfigEvent } from "./events.js";
import { GeneralConfig } from "./general.js";
import { ImageModelService } from "./imageModels.js";
import { ModelService } from "./models.js";
import { PresetService } from "./presets.js";
import type { SessionService } from "../session/service.js";
import type { WorkspaceService } from "../workspace/service.js";

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-host-config-edit-"));
  configPath = join(dir, "config.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function endpoint(id: string): Endpoint {
  return { id, name: id, baseUrl: `https://${id}.example/v1`, apiKey: "" };
}

function model(id: string, endpointId: string): Model {
  return { id, name: id, endpointId, tokenThresholds: { handoff: 100, guard: 150 } };
}

function imageModel(id: string, endpointId: string): ImageModel {
  return { id, name: id, endpointId, modelName: id };
}

/**
 * 起手那一份：两个端点，`ep-a` 上挂两个模型（第二个是「同端点的下一条」），`ep-b` 上挂一个
 * —— 改指那几条用例全靠这个布局才验得出「不跨端点」。
 */
const CONFIG: AppConfig = {
  endpoints: [endpoint("ep-a"), endpoint("ep-b")],
  models: [model("m-a1", "ep-a"), model("m-a2", "ep-a"), model("m-b1", "ep-b")],
  imageModels: [
    imageModel("img-a1", "ep-a"),
    imageModel("img-a2", "ep-a"),
    imageModel("img-b1", "ep-b"),
  ],
  defaultAgent: "default",
  defaultModel: "m-a1",
  defaultMigrationModel: "m-b1",
  defaultImageModel: "img-a1",
  namingModel: "m-a1",
  maxToolOutput: 32_768,
  abortedMessageStrategy: "keep",
  abortedToolRoundStrategy: "fill",
};

/** 一段活着的执行体只需要这两格 —— 这条路上会去赋的就是它们 */
interface FakeAgent {
  abortedMessageStrategy?: string;
  abortedToolRoundStrategy?: string;
}

interface HostOptions {
  /** 起手写到磁盘上的那一份，缺省 {@link CONFIG} */
  readonly config?: AppConfig;
  /** 项目与它名下的会话（`workspaces.list` / `sessions.list` 返回的东西） */
  readonly liveSessions?: string[];
  /** 谁活着：会话 id → 执行体。不在表里的那一段就是「没有执行体」 */
  readonly agents?: Map<string, FakeAgent>;
}

/**
 * 一个真磁盘 + 真的 `ConfigManager` + 四个写口，加一个只挂了 `config` 的 router。
 *
 * `definitions` / `workspaces` / `sessions` / `runtime` 是替身：这几条用例问的是「文件里落了
 * 什么、内存那份是什么、执行体上被赋了什么」，造真的那几个只会让人以为它们也在被验。
 */
async function newHost(options: HostOptions = {}) {
  await writeFile(configPath, JSON.stringify(options.config ?? CONFIG, null, 2), "utf-8");

  const t = createTranslator(() => "zh");
  const configEvents: ConfigEvent[] = [];
  const events = createBus<ConfigEvent>();
  events.subscribe((event) => configEvents.push(event));

  const manager = new ConfigManager(configPath);
  const config = new GeneralConfig({
    config: manager,
    current: await manager.read(),
    events,
  });

  const agents = options.agents ?? new Map<string, FakeAgent>();
  const sessionIds = options.liveSessions ?? [];

  const deps = {
    config,
    endpoints: new EndpointService({ general: config, t }),
    models: new ModelService({ general: config, t }),
    imageModels: new ImageModelService({ general: config, t }),
    presets: new PresetService({ general: config, config: manager, t }),
    definitions: { list: async () => [{ id: "default" }] } as unknown as AgentDefinitionService,
    workspaces: {
      list: () => (sessionIds.length === 0 ? [] : [{ id: "ws-1" }]),
    } as unknown as WorkspaceService,
    sessions: {
      list: (workspaceId: string) =>
        workspaceId === "ws-1" ? sessionIds.map((id) => ({ id })) : [],
    } as unknown as SessionService,
    runtime: {
      get: (sessionId: string) => agents.get(sessionId),
    } as unknown as AgentRuntime,
    t,
  } as unknown as HostApiDeps;

  const api = createTrpc(t);
  const router = api.router({ config: configRouter(deps, api) });

  return {
    deps,
    caller: router.createCaller({}),
    configEvents,
    agents,
  };
}

type Host = Awaited<ReturnType<typeof newHost>>;

/**
 * 这一次调用抛出的是哪个 `HostError`。tRPC 把 resolver 抛出的原始错误放在 `cause` 里（出网那
 * 一层换成 tRPC 自己的码），所以码要从 `cause` 上读。
 */
async function hostErrorOf(call: Promise<unknown>): Promise<HostError> {
  try {
    await call;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof HostError) return cause;
    throw error;
  }
  throw new Error("这一次调用没有抛错");
}

/** 磁盘上那份 `config.json` 读回来的样子（每次都新开一个 `ConfigManager`：它不留缓存） */
async function onDisk(): Promise<AppConfig> {
  return new ConfigManager(configPath).read();
}

describe("配置面：端点", () => {
  it("删端点时先看还有谁挂着：conflict 里说清是哪几个模型（图片模型也算），处理掉才删得掉", async () => {
    const host = await newHost();

    const refused = await hostErrorOf(host.caller.config.endpoint.remove({ id: "ep-a" }));

    expect(refused.code).toBe("conflict");
    // 客户端据此告诉用户「先处理这两个」—— 列表要给全，只说「有模型在用」等于让人自己去翻
    expect(refused.details).toEqual({
      entity: "endpoint",
      endpointId: "ep-a",
      models: ["m-a1", "m-a2"],
      // 图模也挂在端点 id 上：只报模型的话，删完就留下一条指不到端点的图模
      imageModels: ["img-a1", "img-a2"],
    });
    expect(refused.message).toContain("m-a1");
    expect(refused.message).toContain("img-a1");
    // 拒绝就是拒绝：文件里的端点还在，模型一个都没被改指（跨端点改指等于换一家服务商）
    expect((await onDisk()).endpoints.map((item) => item.id)).toEqual(["ep-a", "ep-b"]);
    expect((await onDisk()).models.map((item) => item.endpointId)).toEqual([
      "ep-a",
      "ep-a",
      "ep-b",
    ]);

    await host.caller.config.model.remove({ id: "m-a1" });
    await host.caller.config.model.remove({ id: "m-a2" });
    await host.caller.config.imageModel.remove({ id: "img-a1" });
    await host.caller.config.imageModel.remove({ id: "img-a2" });
    const { config } = await host.caller.config.endpoint.remove({ id: "ep-a" });

    expect(config.endpoints.map((item) => item.id)).toEqual(["ep-b"]);
    expect((await onDisk()).endpoints.map((item) => item.id)).toEqual(["ep-b"]);
  });

  it("端点增改：id 重名是 conflict，改不存在的 id 是 not_found", async () => {
    const host = await newHost();

    await host.caller.config.endpoint.add({ endpoint: endpoint("ep-c") });
    expect((await onDisk()).endpoints.map((item) => item.id)).toContain("ep-c");

    const duplicate = await hostErrorOf(
      host.caller.config.endpoint.add({ endpoint: endpoint("ep-c") }),
    );
    expect(duplicate.code).toBe("conflict");
    expect(duplicate.details).toEqual({ entity: "endpoint", endpointId: "ep-c" });

    const { config } = await host.caller.config.endpoint.update({
      id: "ep-b",
      change: { name: "改过的名字" },
    });
    expect(config.endpoints.find((item) => item.id === "ep-b")?.name).toBe("改过的名字");
    // 改的是名字，id 不动：模型引用端点用的就是它
    expect(
      config.models.every((item) => item.endpointId === "ep-b" || item.endpointId === "ep-a"),
    ).toBe(true);

    const missing = await hostErrorOf(
      host.caller.config.endpoint.update({ id: "ep-nowhere", change: { name: "x" } }),
    );
    expect(missing.code).toBe("not_found");
  });
});

describe("配置面：图片模型", () => {
  it("删图片模型时默认项改指到同端点的下一条，同端点没有就清空", async () => {
    const host = await newHost();

    const afterFirst = await host.caller.config.imageModel.remove({ id: "img-a1" });

    // 同端点还剩 img-a2：默认项跟着它
    expect(afterFirst.config.defaultImageModel).toBe("img-a2");
    expect((await onDisk()).defaultImageModel).toBe("img-a2");

    const afterSecond = await host.caller.config.imageModel.remove({ id: "img-a2" });

    // 同端点一条都不剩了：清空，而**不是**跨到 ep-b 上那条 img-b1
    expect(afterSecond.config.defaultImageModel).toBeUndefined();
    expect(afterSecond.config.imageModels?.map((item) => item.id)).toEqual(["img-b1"]);
    // `undefined` 那一格在文件里就是不出现
    expect("defaultImageModel" in (await onDisk())).toBe(false);
  });
});

describe("配置面：没改就不写盘", () => {
  it("写回与当前一样的值：文件的修改时间不变、不发事件、内存那份原样返回", async () => {
    const host = await newHost();
    const before = statSync(configPath).mtimeMs;
    const beforeEvents = host.configEvents.length;
    const beforeConfig = host.deps.config.read();
    // 修改时间可能粗到一毫秒：先把它推开一点。真写了盘的话，新时间一定比这个基准新
    await sleep(20);

    // `setGlobal` 走的就是 `GeneralConfig.patch`：合出来的那份与当前逐字一样
    const { config } = await host.caller.config.setGlobal({
      maxToolOutput: host.deps.config.read().maxToolOutput,
    });

    // 断言的是**文件没被重写**（不是内容一样 —— 内容当然一样）：mtime 只在写的那一刻变
    expect(statSync(configPath).mtimeMs).toBe(before);
    // 「原样返回」是同一个对象：客户端拿到的那一份不必再叠补丁
    expect(config).toBe(beforeConfig);
    expect(host.configEvents.length).toBe(beforeEvents);
  });

  it("删掉一条再改回去之间，真改的那一次还是会写盘（这条用例证明上一条的 mtime 断言不是永真）", async () => {
    const host = await newHost();
    const before = statSync(configPath).mtimeMs;
    await sleep(20);

    await host.caller.config.setGlobal({ maxToolOutput: 1_000 });

    expect(statSync(configPath).mtimeMs).not.toBe(before);
    expect((await onDisk()).maxToolOutput).toBe(1_000);
  });
});

describe("配置面：读", () => {
  it("一次取回整份配置与整张档位表（两张分开的文件，同一个请求）", async () => {
    const host = await newHost();
    const presetsPath = join(dir, "reasoning-presets.json");
    const presets = { openai: { levels: { off: { reasoning_effort: "none" } } } };
    await writeFile(presetsPath, JSON.stringify(presets, null, 2), "utf-8");

    const got = await host.caller.config.get();

    expect(got.config.endpoints.map((item) => item.id)).toEqual(["ep-a", "ep-b"]);
    expect(got.config.defaultImageModel).toBe("img-a1");
    expect(got.presets).toEqual(presets);
  });
});

describe("配置面：语言", () => {
  /**
   * 语言是宿主的全局那一格，写口就是 `config.setGlobal`（不另开一条 procedure）。写完的即时效果
   * 不靠重建任何执行体：宿主那份 `t` 是 `createTranslator(() => general.language())`，调用那一刻
   * 现读，所以下一次渲染就是新语言 —— 这里用同一个造法造一个 `t`，验证的正是那条现读的线。
   *
   * 起手那份配置不写 `language`（缺省按 `en`），写完读回 `zh`：两个方向都验到了。
   */
  it("写 language 之后读回来是新的，宿主那份语言当场跟着变", async () => {
    const host = await newHost();
    const t = createTranslator(() => host.deps.config.language());
    expect(t("交接失败：{reason}", { reason: "x" })).toBe("Handoff failed: x");

    const { config } = await host.caller.config.setGlobal({ language: "zh" });

    expect(config.language).toBe("zh");
    // 读口看到的是改完之后那一份：客户端不必自己把补丁叠到手里那份快照上
    expect((await host.caller.config.get()).config.language).toBe("zh");
    // 宿主那份语言跟着变，且不需要重建任何执行体
    expect(host.deps.config.language()).toBe("zh");
    expect((await onDisk()).language).toBe("zh");
    // 同一刻产生的下一句就是新语言：语言不是造 `t` 那一刻的快照
    expect(t("交接失败：{reason}", { reason: "x" })).toBe("交接失败：x");
  });

  /**
   * 非法值在边界上被拒（而不是写进文件之后由 `normalizeConfig` 静默修）：静默修的话界面上写着
   * 「已保存」，而宿主照旧回落成 `en`。
   */
  it("language 给了 `en` / `zh` 之外的值：边界上拒掉，文件一个字都不动", async () => {
    const host = await newHost();
    const beforeText = await readFile(configPath, "utf-8");

    await expect(
      host.caller.config.setGlobal({ language: "fr" as unknown as "en" }),
    ).rejects.toThrow();

    expect(await readFile(configPath, "utf-8")).toBe(beforeText);
    // 内存那一份也没动：拒的是这一次调用，不是「不让改语言」
    expect(host.deps.config.language()).toBe("en");
    // 合法的值照样写得进去
    const { config } = await host.caller.config.setGlobal({ language: "zh" });
    expect(config.language).toBe("zh");
  });
});

describe("配置面：思考档位表", () => {
  it("某一档的补丁是字符串 / 数组 → invalid_params，磁盘那份一个字都不动", async () => {
    const host = await newHost();
    const presetsPath = join(dir, "reasoning-presets.json");
    const good = { reasoning: { levels: { low: { reasoning_effort: "low" } } } };
    await writeFile(presetsPath, JSON.stringify(good, null, 2), "utf-8");
    const beforeText = await readFile(presetsPath, "utf-8");
    const beforeMtime = statSync(presetsPath).mtimeMs;
    await sleep(20);

    const asString = await hostErrorOf(
      host.caller.config.presets.set({
        presets: { reasoning: { levels: { low: "low" } } } as unknown as ReasoningPresets,
      }),
    );
    expect(asString.code).toBe("invalid_params");
    // 文案说清是哪张表的哪一档：表多了之后「有一档不对」等于没说
    expect(asString.message).toContain("reasoning");
    expect(asString.message).toContain("low");
    expect(asString.details).toMatchObject({ preset: "reasoning", level: "low" });

    const asArray = await hostErrorOf(
      host.caller.config.presets.set({
        presets: { reasoning: { levels: { low: ["low"] } } } as unknown as ReasoningPresets,
      }),
    );
    expect(asArray.code).toBe("invalid_params");

    const missingLevels = await hostErrorOf(
      host.caller.config.presets.set({
        presets: { reasoning: {} } as unknown as ReasoningPresets,
      }),
    );
    expect(missingLevels.code).toBe("invalid_params");

    expect(await readFile(presetsPath, "utf-8")).toBe(beforeText);
    expect(statSync(presetsPath).mtimeMs).toBe(beforeMtime);

    // 合法的写得进去（被拒的是形状，不是「不让改」），与磁盘一样的那一次不写盘
    const next = {
      reasoning: {
        levels: { low: { reasoning_effort: "low" }, high: { reasoning_effort: "high" } },
      },
    } as unknown as ReasoningPresets;
    const written = await host.caller.config.presets.set({ presets: next });
    expect(Object.keys(written.presets.reasoning.levels)).toEqual(["low", "high"]);
    expect(JSON.parse(await readFile(presetsPath, "utf-8"))).toEqual(next);

    const afterWrite = statSync(presetsPath).mtimeMs;
    await sleep(20);
    await host.caller.config.presets.set({ presets: next });
    expect(statSync(presetsPath).mtimeMs).toBe(afterWrite);
  });
});

describe("配置面：中断策略两项", () => {
  it("改完当场赋到每一段活着的执行体上，不碰没有执行体的那一段，也不碰 maxToolOutput", async () => {
    const agents = new Map<string, FakeAgent>([
      ["s-1", {}],
      ["s-2", {}],
    ]);
    // 三段session，两段活着（s-3 重启之后还没被叫醒）
    const host: Host = await newHost({ liveSessions: ["s-1", "s-2", "s-3"], agents });

    const { config } = await host.caller.config.setGlobal({
      abortedMessageStrategy: "drop",
      abortedToolRoundStrategy: "drop",
      maxToolOutput: 1_000,
    });

    expect(config.abortedMessageStrategy).toBe("drop");
    expect(config.abortedToolRoundStrategy).toBe("drop");

    // 两段活着的执行体都拿到了新值：不杀会话、不等下一次唤醒
    for (const sessionId of ["s-1", "s-2"]) {
      const agent = agents.get(sessionId);
      expect(agent?.abortedMessageStrategy).toBe("drop");
      expect(agent?.abortedToolRoundStrategy).toBe("drop");
      // `maxToolOutput` 不在执行体上（由能力容器现读），这条路上一个字都不该写到那里
      expect("maxToolOutput" in (agent as object)).toBe(false);
    }

    // 没有执行体的那一段没有被凭空造出来
    expect(agents.has("s-3")).toBe(false);

    expect((await onDisk()).abortedMessageStrategy).toBe("drop");
    expect((await onDisk()).maxToolOutput).toBe(1_000);
  });
});

describe("配置面：默认项", () => {
  it("指到不存在的 id 被拒（invalid_params，不写盘），清空不校验", async () => {
    const host = await newHost();
    const beforeText = await readFile(configPath, "utf-8");

    const badModel = await hostErrorOf(
      host.caller.config.setDefaults({ defaultModel: "no-such-model" }),
    );
    expect(badModel.code).toBe("invalid_params");
    expect(badModel.details).toEqual({ entity: "model", modelId: "no-such-model" });

    const badAgent = await hostErrorOf(
      host.caller.config.setDefaults({ defaultAgent: "no-such-agent" }),
    );
    expect(badAgent.code).toBe("invalid_params");
    expect(badAgent.details).toEqual({
      entity: "agentDefinition",
      agentDefinitionId: "no-such-agent",
    });

    // 拒了就是没写：文件、内存那份都没变
    expect(await readFile(configPath, "utf-8")).toBe(beforeText);
    expect(host.deps.config.read().defaultModel).toBe("m-a1");

    // 清空不校验引用（清空之后没有指向，也就没有指错）
    const { config } = await host.caller.config.setDefaults({
      defaultModel: null,
      defaultImageModel: null,
    });
    expect(config.defaultModel).toBeUndefined();
    expect(config.defaultImageModel).toBeUndefined();
    expect((await onDisk()).defaultModel).toBeUndefined();
  });
});

describe("配置面：恢复出厂", () => {
  /** 出厂那一条模型 / 图模，拷一份当「用户把它改过、还标了自建」的样子 */
  function modifiedFactoryModel(): Model {
    const factory = DEFAULT_APP_CONFIG.models.find((item) => item.id === "gpt-6-astra");
    if (factory === undefined) throw new Error("出厂清单里没有 gpt-6-astra");
    return {
      ...factory,
      name: "我改过的名字",
      tokenThresholds: { handoff: 10, guard: 20 },
      custom: true,
      // 出厂那条里没有这一格：恢复出厂要连它一起退场（整条换，不是叠补丁）
      version: 7,
    };
  }

  it("模型：换回出厂清单同 id 的那一条并把 custom 置回 false；不是出厂的 id 是 not_found", async () => {
    const factory = DEFAULT_APP_CONFIG.models.find((item) => item.id === "gpt-6-astra");
    const config: AppConfig = {
      ...CONFIG,
      endpoints: [...CONFIG.endpoints, endpoint("openai")],
      models: [...CONFIG.models, modifiedFactoryModel()],
    };
    const host = await newHost({ config });

    const reset = await host.caller.config.model.reset({ id: "gpt-6-astra" });

    expect(reset.config.models.find((item) => item.id === "gpt-6-astra")).toEqual({
      ...factory,
      custom: false,
    });
    // 重新归入托管：下一次启动的出厂同步会按出厂清单再校一次
    expect(reset.config.models.find((item) => item.id === "gpt-6-astra")?.custom).toBe(false);
    expect((await onDisk()).models.find((item) => item.id === "gpt-6-astra")).toEqual({
      ...factory,
      custom: false,
    });

    const notFactory = await hostErrorOf(host.caller.config.model.reset({ id: "m-a1" }));
    expect(notFactory.code).toBe("not_found");
    expect(notFactory.message).toContain("不是出厂的那几个模型之一");
  });

  it("图片模型：同一套口径", async () => {
    const factory = DEFAULT_APP_CONFIG.imageModels?.find((item) => item.id === "cogview-4");
    if (factory === undefined) throw new Error("出厂清单里没有 cogview-4");
    const config: AppConfig = {
      ...CONFIG,
      endpoints: [...CONFIG.endpoints, endpoint("bigmodelcn")],
      imageModels: [
        ...(CONFIG.imageModels ?? []),
        { ...factory, name: "我改过的图模", custom: true },
      ],
    };
    const host = await newHost({ config });

    const reset = await host.caller.config.imageModel.reset({ id: "cogview-4" });

    expect(reset.config.imageModels?.find((item) => item.id === "cogview-4")).toEqual({
      ...factory,
      custom: false,
    });

    const notFactory = await hostErrorOf(host.caller.config.imageModel.reset({ id: "img-a1" }));
    expect(notFactory.code).toBe("not_found");
    expect(notFactory.message).toContain("不是出厂的那几个图片模型之一");
  });
});
