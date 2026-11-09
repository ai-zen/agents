/**
 * @ai-zen/agents-server — 会话/工作区服务层。
 *
 * 定位：**客户端无关**的业务层。CLI（TUI）与 Desktop 都只做「渲染 + 输入」，会话编排、
 * 能力装配、持久化、迁移都在这里。
 *
 * 依赖方向（单向，永不反向）：
 *
 *   @ai-zen/cli ─────┐
 *                    ├──→ @ai-zen/agents-server ──→ @ai-zen/agents-sdk ──→ @ai-zen/agents-core
 *   desktop/main ────┘
 *
 * 两条硬约束（可用 grep 检验，命令见 README）：
 *   1. 本包**不得**依赖任何 UI 栈（ink / react / 终端库）——包边界就是进程边界；
 *   2. 本包**不得**读进程级全局（当前工作目录、全局配置路径、全局 locale）——
 *      一切从构造参数来，否则「局部可实例化」和「一个进程服务多个工作区」同时破产。
 *      （该检查的正则写在 README 里；这里刻意不把字面量写进源码，否则 grep 会命中注释本身。）
 */

export {
  PhaseTracker,
  pendingToolCalls,
  type PhaseInfo,
  type PhaseKind,
  type PhaseMessageLike,
  type ToolCallRef,
} from "./service/progress/PhaseTracker.js";
