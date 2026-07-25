# Changelog

## [3.0.1] - 2026-07-26

### ♻️ 重构

- **`CallbackTool` 从 `implements Tool` 改为 `extends Tool`** — 继承 Tool 抽象类，构造函数委托 `super()`，确保 `toBeInstanceOf(Tool)` 通过

### ✅ 测试

- **集成测试模型名更新** — `deepseek-chat` → `deepseek-v4-flash`

## [3.0.0-alpha.1] - 2026-07-19

### 💥 破坏性变更

- **重命名 `onBeforeSend` 钩子为 `onInnerLoopStart`** — 更清晰地表达该钩子在内循环开始时的语义
- **新增 `onInnerLoopEnd` 钩子** — 在内循环结束时调用，可用于后处理
- **重命名事件 `"run"` 为 `"inner-loop-start"`** — 与钩子命名对齐，语义更明确
- **重命名事件 `"run-end"` 为 `"inner-loop-end"`** — 与钩子命名对齐，语义更明确

### 🛠 优化

- `Agent.ts` 中变量 `matchTools` 重命名为 `matchedTool`，命名更规范
- 补充内循环注释，代码可读性提升

### 迁移指南

如果你使用了以下 API，请相应更新：

| 旧名称 | 新名称 |
|--------|--------|
| `onBeforeSend` | `onInnerLoopStart` |
| `events.on("run", ...)` | `events.on("inner-loop-start", ...)` |
| `events.on("run-end", ...)` | `events.on("inner-loop-end", ...)` |

