import type { ConfigManager, ReasoningPresets } from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import { writeTextFile } from "../../infra/files.js";
import type { Translator } from "../i18n/index.js";
import type { GeneralConfig } from "./general.js";

export interface PresetDeps {
  /** 读的那一路：档位表不在 `AppConfig` 里，出口在 `GeneralConfig.presets()` */
  readonly general: GeneralConfig;
  /** 写的那一路：文件路径与「磁盘上现在是哪一份」都只能问它（同一个文件的两个问题） */
  readonly config: ConfigManager;
  readonly t: Translator;
}

/**
 * 思考档位表的读写。
 *
 * 它是**独立的一份文件**（`<数据根>/reasoning-presets.json`），不是 `AppConfig` 的一格 ——
 * 所以它没有 `GeneralConfig` 里那份内存副本，读与写都是现碰磁盘（理由见 `GeneralConfig.presets()`）。
 *
 * 写完**不发配置事件**：能力容器的装配不读这张表，读它的是「选档位那一刻」
 * （`session.setThinkingLevel` 现读磁盘）与模型写入时的校验（`ModelService.assertWritable`）。
 * 发一个没人需要重读的事件，只会让每个容器白刷一次。
 */
export class PresetService {
  constructor(private readonly deps: PresetDeps) {}

  read(): Promise<ReasoningPresets> {
    return this.deps.general.presets();
  }

  /**
   * 写整张表。**先校验形状，不合法就一个字都不写**：客户端从界面上改一格就提交一次，
   * 写坏一次的结果是这个模型从此选不了档 —— 而那时文件已经覆盖了（`prd/PLAN.md` 第 9 行：
   * 「写进去的非法值被拒且改动留住」）。
   *
   * 与磁盘那份逐字一样 → 不写盘。
   */
  async write(table: ReasoningPresets): Promise<ReasoningPresets> {
    assertShape(table, this.deps.t);

    const onDisk = await this.deps.config.readReasoningPresets();
    if (JSON.stringify(table) === JSON.stringify(onDisk)) return onDisk;

    // 与 `ConfigManager` 写自己那几个文件同一个路子：格式一致（缩进 2），原子写。
    // 路径问它要：文件放在哪、叫什么名字是 SDK 那一处的事（`REASONING_PRESETS_FILE`）。
    writeTextFile(this.deps.config.reasoningPresetsPath, JSON.stringify(table, null, 2));
    return table;
  }
}

/**
 * 形状校验。合法的表是「策略名 → `{ custom?: boolean, levels: { 档位名: 补丁 } }`」，
 * 补丁本身必须是一个普通对象（`{ reasoning_effort: "high" }` 这种）：
 *
 * - 补丁是数组 / `null` / 字符串 → 展开进请求体时要么什么都不是、要么把请求体搞坏，
 *   而失败点在真正发请求那一刻 —— 用户那时已经记不住自己刚才改了哪一格；
 * - 所以拒在写入口，并且说清是**哪张表的哪一档**。表坏了要能一眼找到那一行。
 */
function assertShape(table: ReasoningPresets, t: Translator): void {
  if (!isPlainObject(table)) {
    throw new HostError("invalid_params", t("思考档位表必须是一张「策略名 → 档位」的表"), {
      entity: "reasoningPreset",
    });
  }

  for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
    if (!isPlainObject(value)) {
      throw invalid(t("思考档位表 {preset} 必须是一个对象", { preset: name }), { preset: name });
    }

    // `custom` 缺省是「出厂托管」，写别的值（如字符串 "true"）会让 SDK 那一句
    // `custom === true` 判不成，于是这一张表被静默当成托管的覆盖掉
    const custom = value.custom;
    if (custom !== undefined && typeof custom !== "boolean") {
      throw invalid(t("思考档位表 {preset} 的 custom 只有 true / false 两种", { preset: name }), {
        preset: name,
      });
    }

    const levels = value.levels;
    if (!isPlainObject(levels)) {
      throw invalid(t("思考档位表 {preset} 缺少 levels", { preset: name }), { preset: name });
    }

    for (const [level, patch] of Object.entries(levels)) {
      if (isPlainObject(patch)) continue;
      throw invalid(
        t("思考档位表 {preset} 的 {level} 这一档必须是一个对象：一档的补丁是「参数名 → 值」", {
          preset: name,
          level,
        }),
        { preset: name, level },
      );
    }
  }
}

function invalid(message: string, details: Record<string, unknown>): HostError {
  return new HostError("invalid_params", message, { entity: "reasoningPreset", ...details });
}

/** 普通对象：不是数组、不是 `null`、不是标量（配置里的「一格补丁」只能是这个形状） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
