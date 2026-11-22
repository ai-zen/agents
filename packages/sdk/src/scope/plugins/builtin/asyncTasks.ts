import type { Agent, AgentPlugin } from "@ai-zen/agents-core";
import { SILENT_LOG, type LogSink } from "../../../shared/logger.js";

/** `async_exec`：起一条命令就跑，结果推回发起它的会话 */
export const ASYNC_EXEC_TOOL = "async_exec";
/** `async_timeout`：定时器，到点推一条回发起它的会话 */
export const ASYNC_TIMEOUT_TOOL = "async_timeout";

/**
 * 两个后台工具的名字。
 *
 * 组装执行体时按这份名单把它们从一次性执行体手上摘掉：它们的结果在将来某个时刻才回来，
 * 那时一次性执行体的调用栈已经退了，没有收件人。
 */
export const ASYNC_TASK_TOOL_NAMES = [ASYNC_EXEC_TOOL, ASYNC_TIMEOUT_TOOL] as const;

/** 一个执行体名下的后台任务 */
interface AgentTasks {
  /** 还没结束的后台命令（每项自己会按进程组回收） */
  readonly commands: Set<{ kill(): void }>;
  /** 还没到点的定时器 */
  readonly timers: Set<NodeJS.Timeout>;
  /** 「要没了」那一拍是否已经挂上（一个执行体只挂一次） */
  supervised: boolean;
  /** 开出过几个后台任务：任务 id 的序号 */
  count: number;
}

const registry = new WeakMap<Agent, AgentTasks>();

function tasksOf(agent: Agent): AgentTasks {
  let tasks = registry.get(agent);
  if (tasks === undefined) {
    tasks = { commands: new Set(), timers: new Set(), supervised: false, count: 0 };
    registry.set(agent, tasks);
  }
  return tasks;
}

/**
 * 挂上「要没了」那一拍：执行体关门或被杀时，把名下还没结束的后台命令与定时器一起收掉。
 *
 * 挂在 `onStop` / `onKill` 上而不是由工具自己等：工具调用当场就返回了，此后手上没有第二个
 * 时机知道这个执行体已经被收掉。两个钩子在 core 里先于「已经死了」那一步跑，所以这一刻
 * 队列已经关门（推回来的结果会在投递那一步被丢掉并记一行日志）。
 *
 * 一个执行体只挂一次：同一段会话上先后开的多个后台任务共用这一份清点。
 */
function supervise(agent: Agent, log: LogSink): AgentTasks {
  const tasks = tasksOf(agent);
  if (tasks.supervised) return tasks;
  tasks.supervised = true;

  const reap = (how: string) => {
    const commands = [...tasks.commands];
    const timers = [...tasks.timers];
    tasks.commands.clear();
    tasks.timers.clear();
    for (const command of commands) command.kill();
    for (const timer of timers) clearTimeout(timer);
    if (commands.length > 0 || timers.length > 0) {
      log.info(
        `[async] agent ${agent.id} ${how}: ${commands.length} command(s) killed, ` +
          `${timers.length} timer(s) cleared`,
      );
    }
  };

  const plugin: AgentPlugin = {
    onStop: () => reap("stopped"),
    onKill: () => reap("killed"),
  };
  agent.use(plugin);

  return tasks;
}

/**
 * 下一个任务 id。
 *
 * 序号按执行体递增：结果推回来时，模型与人都能按它对上「这是第几次」。前缀是工具名，
 * 两个工具各数各的。
 */
export function nextTaskId(agent: Agent, kind: string): string {
  const tasks = tasksOf(agent);
  tasks.count += 1;
  return `${kind}-${tasks.count}`;
}

/** 登记一条还没结束的后台命令；交回来的函数在它自己结束时摘掉这一项 */
export function trackCommand(agent: Agent, run: { kill(): void }, log?: LogSink): () => void {
  const tasks = supervise(agent, log ?? SILENT_LOG);
  tasks.commands.add(run);
  return () => tasks.commands.delete(run);
}

/** 登记一个还没到点的定时器；交回来的函数在它到点（或被清掉）之后摘掉这一项 */
export function trackTimer(agent: Agent, timer: NodeJS.Timeout, log?: LogSink): () => void {
  const tasks = supervise(agent, log ?? SILENT_LOG);
  tasks.timers.add(timer);
  return () => tasks.timers.delete(timer);
}

/**
 * 把一次后台任务的结果投回发起它的那段会话 —— 只有这一个动作。
 *
 * 投递不创建、也不复活会话：那段会话已经没有执行体、或者队列已经关门时，`push` 抛错，
 * 这条结果就此丢掉并记一行日志。不抛给谁、不重试、不留下来等。
 *
 * 优先级取低：结果不该插进那段会话手上那一批的工具调用之间，它排在队尾，那一批跑完就取到。
 */
export function deliverAsyncResult(input: {
  agent: Agent;
  /** 来源标签，同时是工具名 */
  label: string;
  content: string;
  log?: LogSink;
}): void {
  const { agent, label, content } = input;
  const log = input.log ?? SILENT_LOG;

  try {
    agent.push({ content, priority: "low", source: { kind: "system", label } });
  } catch (error) {
    log.warn(`[${label}] result could not be delivered to agent ${agent.id}; dropped`, { error });
  }
}
