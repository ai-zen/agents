import type { AppConfig, ConfigManager } from "@ai-zen/agents-sdk";

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
 * 宿主看到的配置。解析、缺字段补位、坏文件恢复出厂全在 SDK 那一处，宿主不另立一份 `AppConfig`。
 *
 * **内存里这一份就是活着的配置，文件是它的持久化。** 读不需要碰磁盘，所以 `language()` 能同步
 * 给出答案；磁盘上的改动（手改、别的进程写）要通过 `reload()` 显式引进来。不这么做就得同时
 * 维护“文件里那份”和“内存里那份”两个答案，而它们一定会在某次之后不一致。
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

  async patch(change: Partial<AppConfig>): Promise<AppConfig> {
    const next: AppConfig = { ...this.current, ...change };
    await this.deps.config.write(next);
    this.current = next;
    this.deps.events.emit({ kind: "general" });
    return next;
  }

  language(): Language {
    return this.current.language ?? "en";
  }
}
