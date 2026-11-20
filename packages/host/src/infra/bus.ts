import { EventEmitter } from "node:events";

/**
 * 单通道总线：泛型，不认识任何业务概念。
 *
 * 用 `node:events` 而不是自己维护订阅者数组：`EventEmitter` 在 `emit` 时迭代订阅者快照，
 * 订阅者在处理中被退订也不影响本轮，这个语义正是我们要的，不必再写一遍。
 */
const CHANNEL = "event";

export interface Bus<T> {
  emit(value: T): void;
  /** 返回退订函数 */
  subscribe(listener: (value: T) => void): () => void;
}

export function createBus<T>(): Bus<T> {
  const emitter = new EventEmitter();

  return {
    emit(value: T): void {
      // 不捕获订阅者的异常：吞掉之后，抛异常的订阅者变成静默跳过，调用方看不出这一轮少了人。
      emitter.emit(CHANNEL, value);
    },

    subscribe(listener: (value: T) => void): () => void {
      emitter.on(CHANNEL, listener);
      return () => {
        emitter.off(CHANNEL, listener);
      };
    },
  };
}
