import { resolve as resolvePath } from "node:path";
import type { AgentPlugin, ToolCallContext } from "@ai-zen/agents-core";

/**
 * 交接回合的工具守卫 —— 保证「原 agent 停下手头一切工作」不只是提示词约定。
 *
 * 交接由**同一个 agent** 在自己的会话里完成，它天然有继续干活的动力。
 * 本插件在交接回合期间拦截写入类工具，只放行对交接文档那一份文件的写入：
 *   - `write`：仅当目标路径（按交接时给定的 cwd 归一后）等于交接文档路径时放行；
 *   - `edit` / `batch_edit` / `rm` / `rename` / `mkdir` / `copy`：一律拒绝；
 *   - 读取类工具与其他工具：放行。
 *
 * 拒绝方式是**软拒绝**（返回字符串）：core 的 `onToolCall` 语义会把该字符串作为
 * 工具结果回给模型并继续下一轮，因此模型能读到引导（「只允许写交接文档」）并转回正题。
 * 反例：抛错会让该工具结果标记为 Error 且 `isPreventDefault`，整轮交接直接中断。
 *
 * 边界（必须如实记录，不要误以为是安全边界）：
 *   - **挡不住 `exec`**：`echo > file`、`cat > file <<EOF` 永远能绕过。本插件降低的是
 *     「顺手改代码」的误操作概率，不是沙箱。
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

  /** 进入交接回合：仅允许写入 handoffPath（相对路径按 cwd 归一） */
  arm(handoffPath: string, cwd?: string): void {
    this.cwd = cwd ? resolvePath(cwd) : process.cwd();
    this.handoffPath = resolvePath(this.cwd, handoffPath);
  }

  /** 离开交接回合：恢复为完全让行 */
  disarm(): void {
    this.handoffPath = undefined;
  }

  /** 是否处于交接回合（供上层/测试观察） */
  get armed(): boolean {
    return this.handoffPath !== undefined;
  }

  onToolCall(ctx: ToolCallContext): string | undefined {
    const handoffPath = this.handoffPath;
    if (handoffPath == null) return;

    const name = ctx.tool_call?.function?.name ?? "";

    if (name === "write") {
      const raw = ctx.parsedArgs?.path;
      if (typeof raw === "string" && resolvePath(this.cwd, raw) === handoffPath) {
        return;
      }
      return `交接回合只允许写交接文档：${handoffPath}（write 的 path 请原样使用该路径），请立即开始撰写。`;
    }

    if (HandoffGuardPlugin.WRITE_TOOLS.has(name)) {
      return `交接回合禁止修改工作区（${name}）：你的唯一任务是把交接文档写入 ${handoffPath}。`;
    }

    return;
  }
}
