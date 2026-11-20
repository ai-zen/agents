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
  /** 挡住这段会话继续跑，缺省就是挡 */
  readonly blocking: boolean;
  readonly createdAt: number;
}
