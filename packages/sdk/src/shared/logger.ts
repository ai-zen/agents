/**
 * 日志口：一个三方法的结构类型 + 一份什么都不做的缺省实现。
 *
 * 库**不持有**日志出口：这里没有模块级的可变单例。谁要打日志，谁就从自己的参数里收一个
 * {@link LogSink} 往下传；不注入就什么都不写（{@link SILENT_LOG}）。
 *
 * 为什么不在这里放一份「缺省写 stdout」的实现：库默认往标准输出写，等于把「日志落到哪里」
 * 这件属于进程的事替调用方定了 —— 宿主被拉起时 stdout / stderr 归谁、落到哪个文件，只有
 * 进程自己知道。库缺省沉默，嵌入方（宿主 / 命令行）把自己那一份注入进来。
 *
 * 与 `@ai-zen/agents-logger` 的同名类型**结构相容**，但本包不依赖那个包：「三方法」不值得
 * 让库去认下一个文件日志包。
 */
export interface LogSink {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

/**
 * 什么都不做的 {@link LogSink}：所有「可选日志」参数的缺省值。
 *
 * 一份实例、一处定义：缺省值在构造里写成 `logger ?? SILENT_LOG`，不在每个调用点现拼一个
 * 空对象 —— 那样每一处都是新的一份，且「不注入日志时会发生什么」得读遍调用点才能答上来。
 */
export const SILENT_LOG: LogSink = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
