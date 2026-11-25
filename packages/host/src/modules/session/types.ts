/**
 * 这个名字是从哪儿来的。
 *
 * 为什么要分这么细：`name` 这一格在列表、`/load`、`/rename` 的提示语里都是拿去认会话的，
 * 而四种来源的“好名字”不是一回事 —— 建行时那个占位名就该显示成「新会话 · 时刻」，自动起的就
 * 该原样显示，交接存档那一行要标得出「它是存档」，用户自己写的不容任何人再改。
 * 一个布尔（`nameIsAuto`）只能回答「能不能再改」，答不出「该显示成什么」，于是老代码只能把
 * 「已存档_」这种展示文本提前烘进名字里 —— 界面语言一变，库里的旧名字就跟不上了。
 */
export type SessionNameSource =
  /** 建行时那个占位名（时间串）：显示成「新会话 · 时刻」，自动起名可以覆盖它 */
  | "default"
  /** 自动起名写的，还能被下一个名字覆盖 */
  | "auto"
  /** 用户自己改的，此后不再自动改它 */
  | "user"
  /** 交接存档：名字沿用原会话的，界面上标「存档」而不是改名 */
  | "handoff"
  /** 这一格出现之前写下的行：不知道名字从哪来，原样显示 */
  | "legacy";

/**
 * 会话行：一段持续的身份与历史，一行记录，永远存在。时间一律是 epoch 毫秒。
 */
export interface SessionRecord {
  id: string;
  workspaceId: string;
  name: string;
  /** 这个名字是从哪儿来的（见 {@link SessionNameSource}） */
  nameSource: SessionNameSource;
  pinned: boolean;
  agentId: string;
  /** `null` 表示这段会话当前指不到任何模型（那个端点上没有剩下的可指） */
  modelId: string | null;
  /** `null` 表示跟随 AgentDefinition 的档位 */
  thinkingLevel: string | null;
  autoHandoff: boolean;
  /** 谁开的这段会话，`null` 表示用户建的 */
  lineage: string | null;
  handoffThreshold: number | null;
  guardThreshold: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 建行要的事实。`modelId` 在创建那一刻必须已经解析出来——解析不出就在调用方失败，
 * 不落半成品行；`nameSource` 必填，因为「这个名字是从哪儿来的」只有调用方知道，
 * 给一个默认值就是替它猜。
 */
export interface NewSession {
  workspaceId: string;
  name: string;
  agentId: string;
  modelId: string;
  nameSource: SessionNameSource;
  autoHandoff: boolean;
  lineage: string | null;
}
