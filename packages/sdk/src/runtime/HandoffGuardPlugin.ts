import { resolve as resolvePath } from "node:path";
import { AgentNS } from "@ai-zen/agents-core";
import type {
  AgentPlugin,
  OuterLoopContext,
  ToolCallContext,
  ToolHookContext,
} from "@ai-zen/agents-core";

/** 交接那条指令的来源标签（`HandoffService` 投递时填的就是它，这里按同一个值认回来） */
export const HANDOFF_SOURCE_LABEL = "handoff";

/**
 * 自交接这一趟的结局。
 *
 * 四格都只说事实，不看模型说的话：
 *   - `written`：写这份文档的那次工具调用跑完了；
 *   - `interrupted`：那一下被掐（用户按了中断），或者取消信号响了；
 *   - `gone`：这一段已经不在了（关门 / 硬杀）；
 *   - `missing`：那一批收口了，还是没见到写这份文档的那次调用。
 */
export type SelfHandoffOutcome = "written" | "interrupted" | "gone" | "missing";

/** 挂上守卫之后拿到的两个承诺：这次写文档的结果，以及这一批收口的时刻 */
export interface SelfHandoffWatch {
  /** 那次写文档的结果（四格见 {@link SelfHandoffOutcome}） */
  outcome: Promise<SelfHandoffOutcome>;
  /** 这一批收口：此后这一段的消息不会再长，谁要接着动这份记忆就得等它 */
  over: Promise<void>;
}

/**
 * 交接期间的守卫：门 + 那次写文档的观察点。
 *
 * 交接由**同一个 agent** 在自己的会话里完成，它天然有继续干活的动力，所以两件事都得在这里：
 *
 * 1. **门**（PRD 3.6）：只放行对交接文档那一份文件的写入 ——
 *    - `write`：仅当目标路径（按交接时给定的 cwd 归一后）等于交接文档路径时放行；
 *    - `edit` / `batch_edit` / `rm` / `rename` / `mkdir` / `copy`：一律拒绝；
 *    - 读取类工具与其他工具：放行。
 *    拒绝方式是**软拒绝**（返回字符串）：core 会把该字符串作为那条 tool 消息的正文回给模型并
 *    接着跑，模型读到引导（「只允许写交接文档」）能自己转回正题。反例：抛错会穿到 `start()`
 *    外面把整个循环打死。
 * 2. **那次写文档的结果**：`onToolEnd` 认出「写文件的工具 + 路径等于交接路径」那一次，结果
 *    回来就落定；这一批收口了还没见到它，就是「没写出来」。判据是那次调用的输入与结果，
 *    不是状态，也不是模型的话。
 *
 * 边界（如实记录，不要当成安全边界）：
 *   - **挡不住 `exec`**：`echo > file`、`cat > file <<EOF` 永远能绕过。本插件降低的是
 *     「顺手改代码」的误操作概率，不是沙箱。
 *   - **料不到的参数不算放行**：参数解析失败时 `parsedArgs` 为 `undefined`，`write` 会被
 *     当成「没给路径」而拒绝（宁可让模型重试一次，也不放一个看不清的写操作）。
 *   - 一次性：`arm()` 后生效，`disarm()` 后完全让行。`Agent.use()` 没有移除 API，
 *     故用「同一实例 + 开关」而非反复注册，避免插件数组无限增长。
 */
export class HandoffGuardPlugin implements AgentPlugin {
  /** 写入类工具（除白名单的 write 外一律拒绝） */
  private static readonly WRITE_TOOLS = new Set([
    "edit",
    "batch_edit",
    "rm",
    "rename",
    "mkdir",
    "copy",
  ]);

  /** 当前交接文档绝对路径；undefined 表示未处于交接回合（完全让行） */
  private handoffPath?: string;
  /** 相对路径解析基准（交接时 agent 的 cwd） */
  private cwd = process.cwd();

  /** 结果落定的那一手（已经有结论之后再来的不算） */
  private conclude?: (outcome: SelfHandoffOutcome) => void;
  /** 这一批收口的那一手 */
  private concludeRound?: () => void;
  /** 那条指令进了这一批没有：没认出它，这一批的收口就与我无关 */
  private carrying = false;

  /**
   * 进入交接：只允许写 handoffPath，并交出这一趟的两个观察点。
   *
   * 每次交接都重造一份承诺：上一个交接的结论不留给下一个看。
   */
  arm(handoffPath: string, cwd?: string): SelfHandoffWatch {
    this.cwd = cwd ? resolvePath(cwd) : process.cwd();
    this.handoffPath = resolvePath(this.cwd, handoffPath);
    this.carrying = false;

    let settled = false;
    let ended = false;
    const outcome = new Promise<SelfHandoffOutcome>((resolve) => {
      this.conclude = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
    });
    const over = new Promise<void>((resolve) => {
      this.concludeRound = () => {
        if (ended) return;
        ended = true;
        resolve();
      };
    });
    return { outcome, over };
  }

  /**
   * 离开交接：完全让行。
   *
   * 还没落定的两件承诺在这里一并给个答案 —— 谁在等它们，都不该因为收摊而永远等下去。
   */
  disarm(): void {
    this.conclude?.("missing");
    this.concludeRound?.();
    this.handoffPath = undefined;
    this.carrying = false;
    this.conclude = undefined;
    this.concludeRound = undefined;
  }

  /** 是否处于交接回合（供上层/测试观察） */
  get armed(): boolean {
    return this.handoffPath !== undefined;
  }

  /** 门：交接期间只放行写这份文档的那一次工具调用 */
  onToolStart({ toolCall }: ToolHookContext): string | undefined {
    const handoffPath = this.handoffPath;
    if (handoffPath == null) return;

    const name = toolCall.tool_call?.function?.name ?? "";

    if (name === "write") {
      if (this.documentPathOf(toolCall) === handoffPath) return;
      return `During the handoff round the only allowed write is the handoff document: ${handoffPath} (pass that path to write exactly as given), start writing now.`;
    }

    if (HandoffGuardPlugin.WRITE_TOOLS.has(name)) {
      return `Modifying the workspace is not allowed during the handoff round (${name}): your only task is to write the handoff document to ${handoffPath}.`;
    }

    return;
  }

  /**
   * 那次写文档的结果回来了：跑完就是「写完了」，标成 Aborted 就是「被掐」。
   *
   * 只看「工具名 + 路径」对得上的那一次：别的写操作要么被门拒了、要么与这份文档无关。
   */
  onToolEnd({ toolCall }: ToolHookContext): void {
    if (this.handoffPath == null) return;
    if (this.documentPathOf(toolCall) !== this.handoffPath) return;
    const status = toolCall.resultMessage?.status;
    this.conclude?.(status === AgentNS.MessageStatus.Aborted ? "interrupted" : "written");
  }

  /** 这一批从队里取走了：里面带着交接那条指令，这一批的收口才算我的 */
  onOuterLoopStart({ entries }: OuterLoopContext): void {
    if (this.handoffPath == null) return;
    if (entries.some((entry) => isHandoffEntry(entry))) this.carrying = true;
  }

  /**
   * 这一批收口：还没见到那次写就是「没写出来」，顺带把「这一批完了」告诉等着的人。
   *
   * 收口只能由 core 的钩子报：那一拍之后这一批的消息不再增长，谁要接着动这份记忆都得等它。
   */
  onOuterLoopEnd(): void {
    if (this.handoffPath == null || !this.carrying) return;
    this.carrying = false;
    this.conclude?.("missing");
    this.concludeRound?.();
  }

  /** 用户按了中断（`abort()` 一定翻上这个开关）：这一趟不写了，也不算写失败 */
  onOutputPaused(): void {
    if (this.handoffPath == null) return;
    this.conclude?.("interrupted");
  }

  /** 关门 / 硬杀：这一段已经不在了 */
  onStop(): void {
    if (this.handoffPath == null) return;
    this.conclude?.("gone");
  }

  onKill(): void {
    if (this.handoffPath == null) return;
    this.conclude?.("gone");
  }

  /** 这一次工具调用写的是哪个路径（不是 `write`、或参数里没有路径 → undefined） */
  private documentPathOf(toolCall: ToolCallContext): string | undefined {
    if (toolCall.tool_call?.function?.name !== "write") return undefined;
    const raw = toolCall.parsedArgs?.path;
    if (typeof raw !== "string" || raw.trim() === "") return undefined;
    return resolvePath(this.cwd, raw);
  }
}

/** 这一条入队的东西是不是交接那条指令（按来源标签认，不看正文） */
function isHandoffEntry(entry: AgentNS.InboxEntry): boolean {
  const source = (entry as AgentNS.InboxEntryWithContent).source;
  return source?.kind === "system" && source.label === HANDOFF_SOURCE_LABEL;
}
