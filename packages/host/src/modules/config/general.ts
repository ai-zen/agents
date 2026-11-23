import type { AppConfig, ConfigManager, ReasoningPresets } from "@ai-zen/agents-sdk";

import type { Bus } from "../../infra/bus.js";
import type { Language } from "../i18n/index.js";
import type { ConfigEvent } from "./events.js";

export interface GeneralConfigDeps {
  readonly config: ConfigManager;
  /** 启动时读到的那一份配置（`ensureDefaultConfig()` 的返回） */
  readonly current: AppConfig;
  readonly events: Bus<ConfigEvent>;
}

/**
 * 写盘之后发哪一种事件：模型那一片单独一种（`models`），其余一律 `general`
 * （见 `events.ts`：`general` 是端点、默认项、全局开关这些）。
 */
export type ConfigSlice = "general" | "models";

/**
 * 宿主看到的配置。解析、缺字段补位、坏文件恢复出厂全在 SDK 那一处，宿主不另立一份 `AppConfig`。
 *
 * **内存里这一份就是活着的配置，文件是它的持久化。** 读不需要碰磁盘，所以 `language()` 能同步
 * 给出答案；磁盘上的改动（手改、别的进程写）要通过 `reload()` 显式引进来。不这么做就得同时
 * 维护“文件里那份”和“内存里那份”两个答案，而它们一定会在某次之后不一致。
 *
 * 反过来说，**写必须经过这里**（{@link write}）：绕过它直接写 `ConfigManager`，内存那份就留在
 * 旧值上，而运行期读的正是内存那一份（Scope 的 `getConfig`、模型解析的兜底、`setModel` 的
 * 校验）—— 那时「改完下一句话就按新的走」只在文件层面成立。
 */
export class GeneralConfig {
  private current: AppConfig;

  constructor(private readonly deps: GeneralConfigDeps) {
    this.current = deps.current;
  }

  read(): AppConfig {
    return this.current;
  }

  async reload(): Promise<AppConfig> {
    this.current = await this.deps.config.read();
    return this.current;
  }

  /**
   * 改几格：合进当前那一份，再照{@link write}的规矩落盘。
   *
   * 合出来与当前逐字一样就原样返回 —— **不写盘、不发事件**。「没改就不写盘」这一条落在
   * `write` 里，所以走 `patch` 的写口（默认项、全局两项）与走 `write` 的写口（端点、模型、
   * 图片模型）是同一条判据。
   */
  async patch(change: Partial<AppConfig>): Promise<AppConfig> {
    return this.write({ ...this.current, ...change });
  }

  /**
   * 写一份整配置 —— 配置面的写盘口只有这一个。
   *
   * 与当前逐字一样就原样返回（同一个对象）：不写文件、不发事件。比较用 `JSON.stringify`
   * 逐字比就够 —— 配置是纯数据、没有函数与循环引用，键序由写入方统一（`patch` 在原有那份上
   * 覆盖，位置不变）。
   *
   * `slice` 只决定发哪一种事件，不参与「写不写」的判断：一次写要么是模型那一片变了，要么是
   * 其余部分变了，两件事的读者不同（见 `events.ts`）。
   */
  async write(next: AppConfig, slice: ConfigSlice = "general"): Promise<AppConfig> {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return this.current;

    await this.deps.config.write(next);
    this.current = next;
    this.deps.events.emit({ kind: slice });
    return next;
  }

  language(): Language {
    return this.current.language ?? "en";
  }

  /**
   * 思考档位表。它不是 `AppConfig` 的一格（那份表在 `reasoning-presets.json`，与 `config.json`
   * 各自独立），所以这一格没有「内存里那份」可读，每次现读磁盘。
   *
   * 不把它并进 `current`：那样一份内存副本就同时代表两个文件，其中一个在磁盘上被改过之后，
   * 一次 `reload()` 会把另一个的结果一起抹掉。
   */
  presets(): Promise<ReasoningPresets> {
    return this.deps.config.readReasoningPresets();
  }
}
