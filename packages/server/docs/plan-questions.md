# 实施过程中的问题（按波次实施者追加，PM 统一裁定）

- [src/wire/methods.ts] D3 的临时对话（`conversation.transient`）无 id、不落库，可 `run.state` / `message.delta` 事件的载荷里是必填 `conversationId`：临时对话的流式事件用什么标识来关联这一段流？
- [src/wire/methods.ts] D2 要的「取名模型」在 SDK `AppConfig` 里没有对应字段（只有 `autoTitle` 开关），我按 D2 在 `DefaultSelection.namingModel` 里加了它：这个字段是进 SDK 配置，还是服务端在数据根另存一处？
- [src/wire/methods.ts] PRD F-B1 说「配置层不另存默认模型」，但 SDK `AppConfig.defaultModel` 是三级解析的兜底层：`DefaultSelection.defaultModel` 该保留（照 SDK 事实）还是从契约里去掉（照 F-B1）？
- [src/wire/methods.ts] 「三档语气」具体是哪三档？我取 `info / warning / error`（要承接 F-J2 的 warn/error 上通知），但「已保存」这种一秒提示读起来更像 success。
- [src/wire/methods.ts] F-B5「换助手只改默认」里的「默认」是全局一份（SDK 的 `AppConfig.defaultAgent`）还是每个 Workspace 各一份？我目前只做了全局的 `config.setDefaults`。
- [src/wire/methods.ts] F-E5 的能力清单需要一个独立方法（我建了 `server.capabilities`），还是塞进 `server.hello` 的 result 就够？两处现在都能拿到清单。
- [src/wire/methods.ts] F-F9「不可撤销的动作要二次确认」我做成了删除类方法的 `dryRun: true`（先取代价、再真删）两步走，客户端能否接受这种形状（而不是一个 `confirm: true` 参数）？
- [src/wire/methods.ts] `conversation.get`（元信息）与 `conversation.state`（现场：六态、阈值、问题、用量）分成两个方法，是否需要合成一个以减少一次往返？
- [src/wire/methods.ts] F-I7 的子 Agent 消息回看，我加在 `message.list` 的 `toolCallId` 参数上；是否改为独立的 `message.listSubAgent`？
- [src/wire/states.ts] 撤回是硬删（D24），消息不再返回，所以契约里没有「这里曾经有过消息」的标记；客户端展示上需不需要这个事实（例如留一个删除占位）？
- [src/wire/frames.ts] 收到数组（批量请求）时我用 `unsupported` 拒；如果客户端希望按「参数不对」处理，可以换成 `invalid_params`，请定一个。
- [src/config.ts] `resolveListenTarget` 遇到手写错的端口（0 / 越界 / 非整数）我按「当作没给」回落到下一级；要不要改成直接报 `config_invalid` 让用户看见写错了？
- [src/config.ts] plan 的 `ServerPaths` 只有数据根下五条路径，architecture §2 的目录图里还有 `agents/`、`skills/`、`tools/`、`subagents/`、`mcp.json`：这些路径由 `config.ts` 给出（`ServerPaths` 加字段），还是由 SDK `ConfigManager` 自己推导？
