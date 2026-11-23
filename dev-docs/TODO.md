# 还没做的事

`PLAN.md` 只收两种东西：PRD 里的需求、说得出交付物的专项。这份文件装不下那两样的东西 —— 还没归到需求上的改动、要动手前先讨论一嘴的事。

每条要写清三样：现在是什么行为、要变成什么行为、怎么算做完了。写不全就说明还没想清，别写进来。被做掉、或者变成 `PLAN.md` 的一行之后，从这里删掉，不许长期躺着。

## 一、OpenCode Go 这类订阅式 provider

链接：<https://opencode.ai/docs/console/go/#where-can-i-use-it>

那一页讲的是它的订阅（Go 每月 10 美元、Go Plus 40、Go Teams 每人 20），订阅之后拿到一个 API key，当 provider 用。跟我们有关的是「Where can I use it?」那节对客户端提的两条要求：

- 用自己的 user agent 标识自己（例如 `my-coding-agent/1.0`），不要用通用 SDK 或 HTTP 库的名字；
- 每个会话带一个稳定的 session id，放在 `x-opencode-session` 头里，方便他们做路由与 prompt 缓存。

页面上还列了验证过能用的客户端（Hermes、Claude Code、Codex、ZCode、Pi、jcode、Kilo Code CLI）与已知有问题的几个（DeepSeek Harness、GitHub Copilot Chat），后者的共同点是 session 头缺或不完整。

要做：先定我们要不要按这两条走。要的话，落点在哪儿 —— 端点配置的 `headers`（每台服务器各自配），还是建 `openai` 客户端那一刻统一带（那就得让配置能塞进去）。会话 id 我们现成有（会话 id 本身就是稳定的一串），不必新造。

做完的样子：对着这类端点跑一轮，请求里带的是我们自己的 user agent 与 `x-opencode-session`（值取自会话 id）；这件事可配，不配时别的 provider 一个字节都不变；文档里写一句为什么这么带。
