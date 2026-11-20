export interface Connection {
  readonly id: string;
  /** 这条连接用的哪把宿主访问令牌；这一波还没有凭证校验，先允许 `null` */
  readonly credentialId: string | null;
  readonly openedAt: number;
}

/**
 * 客户端连接是活物：握手时建一条，socket 断开时摘掉。没有数据库表，不落库。
 *
 * 它承载的是身份，不是偏好：语言是用户级的全局设置，存到连接上就是每条连接各一份快照，
 * 而调用方会以为「用哪种语言」由连接决定。
 *
 * 没有「最后一次活动时间」：那要每条消息回来改一次记录，而「这条连接还在不在」的答案
 * 就是它在不在登记表里。
 */
export class Connections {
  private readonly live = new Map<string, Connection>();

  /** 握手成功：建一条，返回它 */
  open(credentialId: string | null): Connection {
    const connection: Connection = {
      id: crypto.randomUUID(),
      credentialId,
      openedAt: Date.now(),
    };

    this.live.set(connection.id, connection);
    return connection;
  }

  /** socket 断开：摘掉。不存在的 id 是空操作 */
  close(id: string): void {
    this.live.delete(id);
  }

  get(id: string): Connection | undefined {
    return this.live.get(id);
  }

  list(): Connection[] {
    return [...this.live.values()];
  }

  /** 进程收尾 */
  closeAll(): void {
    this.live.clear();
  }
}
