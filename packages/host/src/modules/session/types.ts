/**
 * 会话行：一段持续的身份与历史，一行记录，永远存在。时间一律是 epoch 毫秒。
 */
export interface SessionRecord {
  id: string;
  workspaceId: string;
  name: string;
  /** 是不是自动起的名字：这样的名字在用户改过之后就不再被改动 */
  nameIsAuto: boolean;
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
 * 不落半成品行；`nameIsAuto` 必填，因为「这个名字是自动起的还是人给的」只有调用方知道，
 * 给一个默认值就是替它猜。
 */
export interface NewSession {
  workspaceId: string;
  name: string;
  agentId: string;
  modelId: string;
  nameIsAuto: boolean;
  autoHandoff: boolean;
  lineage: string | null;
}
