import { AgentNS } from "@ai-zen/agents-core";
import type { AgentDefinition, AgentRepository } from "@ai-zen/agents-sdk";
import {
  DEFAULT_AGENT_DEFINITION,
  DEFAULT_AGENT_ID,
  DEFAULT_SUBAGENT_DEFINITION,
  DEFAULT_SUBAGENT_ID,
} from "@ai-zen/agents-sdk";

import type { Bus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import type { Translator } from "../i18n/index.js";
import type { ConfigEvent } from "./events.js";
import type { GeneralConfig } from "./general.js";

export interface AgentDefinitionDeps {
  readonly repository: AgentRepository;
  readonly events: Bus<ConfigEvent>;
  readonly t: Translator;
  readonly general: GeneralConfig;
}

/** 四维权限的四个名字：写前逐维校验，报错时点名是哪一维，客户端据此标红对应那一格 */
const PERMISSION_DIMENSIONS = ["tools", "skills", "mcps", "subagents"] as const;

/**
 * 一份定义去掉 `updatedAt` 之后的字面样子。
 *
 * 「这一次改了没有」要比的是除它以外的每一格：`updatedAt` 是**这次写盘的瞬时**，带着它比，
 * 任何一次保存都会被判成改过。逐字比（`JSON.stringify`）就够 —— 定义是纯数据、没有函数与
 * 循环引用，键序由同一个写入口统一（`{ ...当前, ...change }` 只覆盖已有的键，位置不变）。
 */
function withoutUpdatedAt(definition: AgentDefinition): string {
  const { updatedAt: _updatedAt, ...rest } = definition;
  return JSON.stringify(rest);
}

/**
 * 标识就是磁盘上的文件名（`<数据根>/agents/<id>.json`）。
 *
 * `AgentRepository` 那里也会拒掉逃出目录的 id，但它抛的是一句英文 `Invalid entity id` ——
 * 那是宿主自己的运行事故的报法，客户端拿不到一条说得清的失败。
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * AgentDefinition 的增删改查。一个定义一个文件（`<数据根>/agents/<id>.json`），落盘交给 SDK 的
 * `AgentRepository`。
 *
 * 写之前先过一遍校验（{@link AgentDefinitionService.validated}）：仓储只负责读写文件，判断不了
 * 写进去之后还能不能用；而写进去的那几格坏了，失败会发生在很久之后那一句请求里（权限同现是
 * 取工具那一刻，模板没有系统提示是模型开始乱答的那一刻），那时已经看不清是谁写的。
 *
 * 写完之后广播「这个 AgentDefinition 变了」。用这个定义的会话要不要跟着变（失效、重建）属于运行时，
 * 这一层只发出这个事实。
 */
export class AgentDefinitionService {
  constructor(private readonly deps: AgentDefinitionDeps) {}

  list(): Promise<AgentDefinition[]> {
    return this.deps.repository.list();
  }

  async get(id: string): Promise<AgentDefinition> {
    const definition = await this.deps.repository.read(id);
    if (definition === null) throw this.notFound(id);
    return definition;
  }

  async add(
    definition: Omit<AgentDefinition, "createdAt" | "updatedAt">,
  ): Promise<AgentDefinition> {
    const now = new Date().toISOString();
    const created = this.validated({ ...definition, createdAt: now, updatedAt: now });

    // 与端点、模型同一条规矩：id 是别人引用一条定义的**唯一**方式（默认项、会话行、别人定义里
    // 的 subagent 权限，记的都是这个字符串）。同 id 两条定义并存之后，「客户端引用的是哪一条」
    // 这件事没有答案 —— 它不会报错，只会让某一段会话悄悄用上另一份提示词。
    //
    // 所以再建一次是 `conflict`，不是静默覆盖：改已有的那一条走 `update`（同一份文件、同一个
    // 写盘口，而且那边还连着「改完重装」）。
    //
    // 放在校验之后：`read` 会对逃出目录的 id 抛一句英文的 `Invalid entity id`，而那种 id 要先
    // 被上面那一步答成 `invalid_params`。`read` 只有「文件不在」答 `null`，非 `null` 就是那个
    // id 上已经有一份了。
    if ((await this.deps.repository.read(created.id)) !== null) {
      throw new HostError(
        "conflict",
        this.deps.t("已经有 id 为 {agentDefinitionId} 的AgentDefinition了，改它走 update", {
          agentDefinitionId: created.id,
        }),
        { entity: "agentDefinition", agentDefinitionId: created.id },
      );
    }

    await this.deps.repository.write(created);
    this.deps.events.emit({ kind: "agentDefinition", agentDefinitionId: created.id });
    return created;
  }

  /**
   * 改一条定义：先把 `change` 合到当前那份上，再判「到底改了没有」。
   *
   * **没改动就不写盘**（与 `GeneralConfig.write` 同一条判据）：合出来与当前那份逐字一样 ——
   * 去掉 `updatedAt` 再比，见{@link withoutUpdatedAt} —— 就原样返回当前那份：不写文件、
   * `updatedAt` 不动、也不发事件。判据是「用户改动了什么」，不是「用户点了保存」：一次没带改动
   * 的保存不该产生一次写盘（文件被重写、`updatedAt` 被推到当前时刻，客户端那一栏就显示「刚刚
   * 改过」，而用户什么也没改）。
   *
   * 返回的一律是「改完之后那一份」：没改动时就是当前那份（同一个对象）。
   */
  async update(
    id: string,
    change: Partial<Omit<AgentDefinition, "id" | "createdAt">>,
  ): Promise<AgentDefinition> {
    const current = await this.get(id);
    const next = this.validated({
      ...current,
      ...change,
      updatedAt: new Date().toISOString(),
    });
    if (withoutUpdatedAt(next) === withoutUpdatedAt(current)) return current;

    await this.deps.repository.write(next);
    this.deps.events.emit({ kind: "agentDefinition", agentDefinitionId: id });
    return next;
  }

  async remove(id: string): Promise<void> {
    // 先确认存在：仓储的 `delete` 把「本来就没有」也当成功，那样客户端会以为自己删掉了一个 AgentDefinition
    await this.get(id);
    await this.deps.repository.delete(id);
    // 删掉的是默认 AgentDefinition 时，默认项也要跟着让位（PRD 3.4）：留着它指向一个不存在的定义，
    // 下一次新建会话会在解析模型那一步失败，而界面上看不出原因。
    //
    // 走 `write` 而不是 `patch` 之后再 `patch`：删定义与清默认是同一次保存，中间那一次写盘会
    // 让客户端看见一个「定义没了、默认项还指着一个不存在的 id」的中间态。
    const config = this.deps.general.read();
    if (config.defaultAgent === id) {
      await this.deps.general.write({ ...config, defaultAgent: undefined });
    }
    this.deps.events.emit({ kind: "agentDefinition", agentDefinitionId: id });
  }

  /**
   * 恢复出厂：整条换回出厂那一条（`default` 与 `sub-agent-default` 两个），`custom` 置回
   * `false` —— 「换回出厂定义、然后重新归入托管」（`prd/03-legacy.md` 3.4）。
   *
   * **整条换，不是把出厂那几格叠到用户那份上**：出厂之后要给用户的是「出厂长什么样」，
   * 用户此前改过的名称、提示词、权限一并退场；`custom` 置回 `false` 之后，下一次启动的出厂同步
   * 会继续按出厂内容校它的提示词，那正是「重新归入托管」的意思。
   *
   * 不重跑{@link validated}：出厂那两条是常量，形状由 SDK 保证；而它们绑的模型可能已经被用户
   * 删掉了，要求模型在配置里才能恢复出厂，等于让这个动作在最需要的时候失败（模型不在时那句
   * 定义会落到 `defaultModel` 兜底，而不是变成一条坏的）。
   */
  async reset(id: string): Promise<AgentDefinition> {
    const factory = this.factory(id);
    if (factory === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("「{agentDefinitionId}」不是出厂的那两个AgentDefinition之一", {
          agentDefinitionId: id,
        }),
        { entity: "agentDefinition", agentDefinitionId: id },
      );
    }

    const now = new Date().toISOString();
    // 文件读不出来（手改坏了）当作「没有当前这一份」：写进去的是整条常量，与旧文件里剩了什么
    // 无关，而恢复出厂正是那种处境下的出路
    const current = await this.deps.repository.read(id).catch(() => null);
    // 出厂那两份常量里的数组与对象是共享的：拷一份再写，写盘与返回的都不是常量本身
    const next: AgentDefinition = {
      ...structuredClone(factory),
      custom: false,
      // 创建时间是这个文件的出生时间，恢复出厂不重造它；文件不在时（删过又恢复）就是现在
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    await this.deps.repository.write(next);
    this.deps.events.emit({ kind: "agentDefinition", agentDefinitionId: id });
    return next;
  }

  private factory(id: string): Omit<AgentDefinition, "createdAt" | "updatedAt"> | undefined {
    if (id === DEFAULT_AGENT_ID) return DEFAULT_AGENT_DEFINITION;
    if (id === DEFAULT_SUBAGENT_ID) return DEFAULT_SUBAGENT_DEFINITION;
    return undefined;
  }

  /**
   * 写之前的校验，返回要落盘的那一份。
   *
   * `function.parameters` 允许是一段文本：编辑器里写的就是一段 JSON（`prd/03-legacy.md` 3.4 的
   * 「多行内容」）。解析失败就拒，并且**一个字都不写盘** —— 「非法 JSON 被拒且改动保留」在宿主
   * 这一侧只有这一个落点：改动留在编辑器里是客户端的事，宿主只保证不接受。解析成功就按对象存，
   * 此后磁盘上那一份与对象形状没有区别。
   */
  private validated(definition: AgentDefinition): AgentDefinition {
    const { t, general } = this.deps;

    if (!ID_PATTERN.test(definition.id)) {
      throw new HostError(
        "invalid_params",
        t(
          "AgentDefinition标识 {agentDefinitionId} 只能由字母、数字、点、下划线与连字符组成，且不以点、下划线与连字符开头",
          { agentDefinitionId: definition.id },
        ),
        { entity: "agentDefinition", agentDefinitionId: definition.id },
      );
    }

    // 模板里没有系统提示 = 这个 AgentDefinition 没有身份：它会以任一句话为准则去答，而文件本身看得过去
    if (
      !Array.isArray(definition.messages) ||
      !definition.messages.some((message) => message.role === AgentNS.Role.System)
    ) {
      throw new HostError(
        "invalid_params",
        t("AgentDefinition {agentDefinitionId} 的模板里至少要有一条 system 消息", {
          agentDefinitionId: definition.id,
        }),
        { entity: "agentDefinition", agentDefinitionId: definition.id },
      );
    }

    const permissions = definition.permissions;
    if (permissions !== undefined && permissions !== null) {
      for (const dimension of PERMISSION_DIMENSIONS) {
        const policy = permissions[dimension];
        if (policy === undefined) continue;

        const allow: unknown = (policy as { allow?: unknown }).allow;
        const deny: unknown = (policy as { deny?: unknown }).deny;
        // 两者同现（或都不出现）时 `PermissionEvaluator` 会抛，但那是运行期的事故：会话开着、
        // 用户问了一句，才在取工具那一刻失败
        if ((allow === undefined) === (deny === undefined)) {
          throw new HostError(
            "invalid_params",
            t("AgentDefinition {agentDefinitionId} 的 {dimension} 权限只能是 allow 或 deny 其一", {
              agentDefinitionId: definition.id,
              dimension,
            }),
            { entity: "agentDefinition", agentDefinitionId: definition.id, dimension },
          );
        }

        const entries = allow ?? deny;
        if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
          throw new HostError(
            "invalid_params",
            t("AgentDefinition {agentDefinitionId} 的 {dimension} 权限必须是字符串数组", {
              agentDefinitionId: definition.id,
              dimension,
            }),
            { entity: "agentDefinition", agentDefinitionId: definition.id, dimension },
          );
        }
      }
    }

    // 指着一个不在配置里的模型：下一次新建会话会在解析模型那一步失败，而界面上看不出原因
    if (
      definition.modelId !== undefined &&
      !general.read().models.some((model) => model.id === definition.modelId)
    ) {
      throw new HostError(
        "invalid_params",
        t("配置里没有 id 为 {modelId} 的模型", { modelId: definition.modelId }),
        { entity: "model", modelId: definition.modelId },
      );
    }

    const fn = definition.function;
    if (fn === undefined) return definition;

    if (typeof fn.name !== "string" || fn.name === "") {
      throw new HostError(
        "invalid_params",
        t("subagent {agentDefinitionId} 的函数名不能为空", {
          agentDefinitionId: definition.id,
        }),
        { entity: "agentDefinition", agentDefinitionId: definition.id },
      );
    }

    const written: unknown = fn.parameters;
    let parameters: unknown = written;
    if (typeof written === "string") {
      try {
        parameters = JSON.parse(written);
      } catch (error) {
        // 解析错误原样带上：客户端据此在编辑器里把位置标出来
        throw new HostError(
          "invalid_params",
          t("subagent {agentDefinitionId} 的参数结构不是合法的 JSON：{reason}", {
            agentDefinitionId: definition.id,
            reason: (error as Error).message,
          }),
          { entity: "agentDefinition", agentDefinitionId: definition.id },
        );
      }
    }

    if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
      throw new HostError(
        "invalid_params",
        t("subagent {agentDefinitionId} 的参数结构必须是一个对象：它是一份 JSON Schema", {
          agentDefinitionId: definition.id,
        }),
        { entity: "agentDefinition", agentDefinitionId: definition.id },
      );
    }

    return {
      ...definition,
      function: { ...fn, parameters: parameters as AgentNS.FunctionDefine["parameters"] },
    };
  }

  private notFound(id: string): HostError {
    return new HostError(
      "not_found",
      this.deps.t("找不到 id 为 {agentDefinitionId} 的AgentDefinition", { agentDefinitionId: id }),
    );
  }
}
