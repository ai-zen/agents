# 客户端重写 — 实施计划

上游：`packages/server/docs/PRD.md` + `architecture.md`（A1–A13）；服务端实现见 `packages/server/src`（`npx vitest run` 679 绿）。
用户裁定（2026-11-13）：

- **R68**：`@ai-zen/agents-client` 按新服务端契约重写。
- **R69**：cli 与 desktop **可以共享代码，但禁止发包** —— 共享包一律 `private: true`，只允许跨仓私有引用；**cli / desktop 打包时各自把这些共享代码捆进自己的产物**，不许依赖任何已发布版本。

## 分工

| 波次 | 内容 | 依赖 |
|---|---|---|
| C1 | `packages/client` 重写（private）：连接、鉴权、方法调用、事件订阅、重连补拉、本地起服务端 | 服务端契约 |
| C2 | `cli`（`ai-zen/cli-old` 迁到新契约，UI 层 Ink 保留） | C1 |
| C3 | `desktop`（render 保留，main 的桥改成新契约） | C1 |
| C4 | 打包验证：cli 与 desktop 各自产物里**内联**共享代码，不残留对共享包的运行时依赖 | C2/C3 |

## 契约要点（C1 必须照此实现）

- 一条 WS；首帧 `server.hello { token, language?, clientInfo }`，凭证**不进 URL**
- 方法名与形状以 `packages/server/src/wire/methods.ts` 为唯一来源（64 个方法），客户端 `import type`，不另抄一份
- 推送是 JSON-RPC 通知（无 id）：`run.state` / `message.delta` / `conversation.changed` / `notice` / `question` / `usage`
- **不重放、不 ack**：重连后客户端自己 `conversation.state` + `message.list({ after })` 补拉（`after` 命中则含该条最新内容，未命中返回全部）
- 语言挂连接（`server.setLanguage`），断开即忘
- 本地服务端：`<数据根>/run/server.json` 拿地址、`<数据根>/run/token` 拿凭证；没有就 spawn `agents-server serve`
- 消息本体是 core 的 `AgentNS.Message`，客户端不包装
