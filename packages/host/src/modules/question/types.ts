/**
 * 提问：宿主向用户发问、等人作答的进程内对象，没有表。时间一律是 epoch 毫秒。
 *
 * 文案在这里是成品句，不是「键 + 参数」：题只活在内存里，产生它的那一刻是哪一种语言，它就一直
 * 是那一种语言；存键的写法是为「出口处按连接语言重渲染」准备的，而题没有第二个出口。
 */
export interface Choice {
  readonly value: string;
  readonly label: string;
}

export interface Question {
  readonly id: string;
  readonly sessionId: string;
  /** 产生时按当前语言渲染好的成品句 */
  readonly message: string;
  readonly choices: readonly Choice[];
  /**
   * 「面板被关掉」等于给哪个值（Esc / Ctrl+C）。
   *
   * **不填就不填**：关掉面板不作答，题继续挂在表里等人答（替用户选一个等于替他决定）。
   *
   * 必须由**出题的那一方**填，因为只有它知道这几个候选里哪个是退路。客户端不许按位置猜 ——
   * 把某个列表的第 1 项或最后一项当兜底值是禁止的（`AGENTS.md` 的「禁止隐式兜底」）。
   */
  readonly cancelValue?: string;
  /** 挡住这段会话继续跑，缺省就是挡 */
  readonly blocking: boolean;
  readonly createdAt: number;
}
