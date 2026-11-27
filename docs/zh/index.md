# AI-Zen Agents 文档

自己部署的 agent 运行时。这套文档按「先用起来，再逐层展开」的顺序排：后一页用到的名词，前面已经解释过，不重复。

| 页 | 讲什么 |
|---|---|
| [快速开始](getting-started.md) | 装终端客户端、起宿主、第一次对话；不装宿主的最小示例 |
| [Agent](agent.md) | 定义文件的字段、投递与停止、事件流、异步结果回投、子代理 |
| [能力](capabilities.md) | 工具、技能、子代理、MCP 四类文件的写法；目录层次；四维权限；渐进式披露 |
| [MCP](mcp.md) | `mcp.json` 的写法、五层合并、五个运行期工具、任务与问答 |
| [宿主](host.md) | 会话与历史、唤醒与投递、会话之间互发、凭证与对外实例 |
| [交接](handoff.md) | 两条阈值、两档、两种执行者、九节文档、存档与取消 |
| [花费](cost.md) | 成本来自哪里，以及九条机制各自省在哪 |

各包的 API 见包内 README：

- `packages/core/README.zh.md` —— Agent 的方法与事件、插件钩子、消息与工具的形状
- `packages/sdk/README.zh.md` —— `Scope`、`ConfigManager`、`AgentRuntime`、`HandoffService`、工具工厂
- `packages/host/README.md` —— 宿主的模块划分（英文）
- `packages/fake-llm/README.md` —— 测试用的假模型服务（英文）

仓库根目录的 `README.zh.md` 是总览，`PRINCIPLES.md` 是设计原则，`dev-docs/` 是内部文档，不面向使用者。
