# Changelog

## [3.2.0] - 2026-08-03

### ✨ 新增

- **`inner-loops-start` / `inner-loops-end` 事件** — 整组内循环（一次 send，含多轮工具调用）的开始/结束事件，一次 send 各触发一次，携带当前完整 `messages`。与单轮 `inner-loop-start` / `inner-loop-end`（每轮触发一次）通过复数区分：订阅者可拿到「user + assistant 占位已就绪」与「完整结果」两个整轮时机
- **`onInnerLoopsStart` / `onInnerLoopsEnd` 异步钩子** — 与上述事件同名对应，分别在整组内循环开始前/结束后 `await` 调用（对应单轮钩子 `onInnerLoopStart` / `onInnerLoopEnd`）

## [3.1.0] - 2026-07-26

### ✨ 新增

- **`Message.id` 字段** — 消息唯一标识，构造函数自动生成（优先 `globalThis.crypto.randomUUID`，无 crypto 的老环境降级为时间戳+随机数，兼容 Node.js 与 Web）。实例构造后 id 全程稳定：流式就地修改不换对象、`JSON.stringify` 落库自动携带、读回保留。接口层面 `id` 为可选（`formatHistory` 发给模型的精简白名单对象不含内部字段，类型兼容）

### 🔧 调整

- **`Message.rewrite` 参数类型由 `Message` 改为 `AgentNS.Message`** — 该方法只读写 content/raw_content，依赖接口而非实现类，消除「精简对象无法传给 rewrite」的类型不匹配

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

