import { resolve as resolvePath } from "node:path";
import type { AgentPlugin, ToolHookContext } from "@ai-zen/agents-core";

/**
 * 交接回合的工具守卫 —— 保证「原 agent 停下手头一切工作」不只是提示词约定。
 *
 * 交接由**同一个 agent** 在自己的会话里完成，它天然有继续干活的动力。
 * 本插件在交接回合期间拦截写入类工具，只放行对交接文档那一份文件的写入：
 *   - `write`：仅当目标路径（按交接时给定的 cwd 归一后）等于交接文档路径时放行；
 *   - `edit` / `batch_edit` / `rm` / `rename` / `mkdir` / `copy`：一律拒绝；
 *   - 读取类工具与其他工具：放行。
 *
 * 拒绝方式是**软拒绝**（返回字符串）：core 的 `onToolStart` 语义会把该字符串作为那条
 * tool 消息的正文回给模型并继续下一圈，因此模型能读到引导（「只允许写交接文档」）并转回正题。
 * 反例：抛错会穿到 `start()` 外面把整个循环打死（agent 变成僵尸），整轮交接直接停摆。
 *
 * 边界（必须如实记录，不要误以为是安全边界）：
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

  onToolStart({ toolCall }: ToolHookContext): string | undefined {
    const handoffPath = this.handoffPath;
    if (handoffPath == null) return;

    const name = toolCall.tool_call?.function?.name ?? "";

    if (name === "write") {
      const raw = toolCall.parsedArgs?.path;
      if (typeof raw === "string" && resolvePath(this.cwd, raw) === handoffPath) {
        return;
      }
      return `During the handoff round the only allowed write is the handoff document: ${handoffPath} (pass that path to write exactly as given), start writing now.`;
    }

    if (HandoffGuardPlugin.WRITE_TOOLS.has(name)) {
      return `Modifying the workspace is not allowed during the handoff round (${name}): your only task is to write the handoff document to ${handoffPath}.`;
    }

    return;
  }
}
