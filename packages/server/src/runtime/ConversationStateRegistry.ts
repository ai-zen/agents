/**
 * 每段对话的**进程内**状态：临时模型、临时思考档位（裁定 R51）。
 *
 * 这两样按 L7 是「只活在本进程内存」的东西：不进库、不进历史，重开就回默认。所以它们的持有者
 * 只能是运行内存里的一个对象，而不是库里的一列、也不是某个模块的全局变量 ——
 * 本类由单根创建并注入给服务层（`ConversationRuntimePort`）与装配 agent 的地方。
 *
 * 「这段对话现在忙不忙」不在这里另存一份：它只问 `RunRegistry`（PRD D14 的唯一一处），
 * 本类只是把那个窄接口转发出来，好让服务层只需要依赖一个对象。
 *
 * 顺带说明为什么这里没有计时器、没有持久化、没有单例：临时覆盖的寿命就是「进程活着且这段对话
 * 还在」；对话被删就 {@link ConversationStateRegistry.forget}，进程没了就全没了 —— 都是它该有的样子。
 */

import type { ConversationRuntimePort } from "../services/ConversationService.js";
import type { RunsView } from "./RunRegistry.js";

export interface ConversationStateRegistryOptions {
  /** 「有没有在跑一轮」的真相（`RunRegistry` 结构上满足） */
  runs: RunsView;
}

export class ConversationStateRegistry implements ConversationRuntimePort {
  private readonly runs: RunsView;
  /** conversationId → 临时模型 id */
  private readonly modelOverrides = new Map<string, string>();
  /** conversationId → 临时思考档位名 */
  private readonly thinkingOverrides = new Map<string, string>();

  constructor(options: ConversationStateRegistryOptions) {
    this.runs = options.runs;
  }

  /** 这段对话现在是否在跑一轮（转发给 `RunRegistry`，不另存第二份） */
  isRunning(conversationId: string): boolean {
    return this.runs.isRunning(conversationId);
  }

  /** 临时模型覆盖；没设过（或已清回默认）返回 `null` */
  getModelOverride(conversationId: string): string | null {
    return this.modelOverrides.get(conversationId) ?? null;
  }

  /** 设 / 清临时模型（`null` 表示回到创建时定的那个）；只动内存 */
  setModelOverride(conversationId: string, modelId: string | null): void {
    this.write(this.modelOverrides, conversationId, modelId);
  }

  /** 临时思考档位；没设过返回 `null`（`null` 表示跟随助手定义上那份参数） */
  getThinkingOverride(conversationId: string): string | null {
    return this.thinkingOverrides.get(conversationId) ?? null;
  }

  /** 设 / 清临时思考档位；只动内存（写进请求的是参数，见 R41：参数即真相） */
  setThinkingOverride(conversationId: string, level: string | null): void {
    this.write(this.thinkingOverrides, conversationId, level);
  }

  /**
   * 对话（或它所在的项目）被删之后，把这段对话的两样覆盖扔掉。
   *
   * 不扔的话，将来某段新对话若碰巧复用了同一个 id（导入、测试脚手架），会凭空继承一份
   * 「用户从没设过的临时模型」。
   */
  forget(conversationId: string): void {
    this.modelOverrides.delete(conversationId);
    this.thinkingOverrides.delete(conversationId);
  }

  /** 当前记着多少段对话的临时状态（诊断与用例用；不参与业务判断） */
  size(): number {
    const ids = new Set([...this.modelOverrides.keys(), ...this.thinkingOverrides.keys()]);
    return ids.size;
  }

  /** 写一个覆盖项：空串与 `null` 都按「清掉」处理 */
  private write(target: Map<string, string>, conversationId: string, value: string | null): void {
    const key = typeof conversationId === "string" ? conversationId.trim() : "";
    if (key === "") return;
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed === "") target.delete(key);
    else target.set(key, trimmed);
  }
}
