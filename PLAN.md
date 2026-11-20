# 宿主实施顺序

需求见 `PRD.md`，结构与判据见 `packages/host/ARCHITECTURE.md`，风格见 `packages/host/STYLE.md`，术语见 `GLOSSARY.md`。

本文件只剩一件事：**先做哪一块，做完怎么算过关。** 旧 `src` 已整包退到 `packages/host/src-bad`，只作行为参照。

## 顺序

| # | 做什么 | 过关标准 |
|---|---|---|
| 1 | `infra/`（db / json-table / bus / errors / files）+ `session/`（行与消息，不含自动命名） | 只有一个 `Session` 类型；加一个业务字段不改表也不改类型；用例不超过两条 |
| 2 | `config/`（general、models、agents、mcp、discovery）+ `workspace/` + `scope/` + `session/auto-name.ts` | 配置改动只从一个口广播，消费方自己订阅；能力容器按目录存活 |
| 3 | `agent/`（assembly、subscription、delivery、service、transient） | 一段会话一个执行体、跨投递复用；投递不唤醒；中断不销毁 |
| 4 | `connection/` + tRPC router + 事件流 | 起宿主、连 WS、发一句话、收到流——一条跨进程用例 |
| 5 | `asset/`、`credential/`、`question/`、`handoff/`、`search/`、`notice/` | 每域 0~2 条用例；第 3 条要说出它证明的是哪个人会犯的错 |

## 门禁

- `tsc --noEmit` 通过；
- `npm test` 通过——用例是行为的证明，不是结构的证明；
- 提交信息一行标题说清改了什么，正文写「改前 / 改后 / 为什么」。

## 并行时的边界

同一波次的目录不重叠；跨域共用的单文件（`src/index.ts`、`app.ts`、`modules/events.ts`）由主 Agent 统一改。

## 不再维护

- **方法清单**：真相是 router 的键，手抄一份就多一份会对不上的账。
- **落点表**：文件结构归 `ARCHITECTURE.md`，写在两处必然漂移。
- **波次编号与欠账清单**：做完就删，不留账——账本越厚，越没人读。
- **文档坐标**（`见 PRD D8` 这类）：会过期，而且过期之后没人发现。旧 `PLAN.md` 里 `PRD D8`、`D9`、`D25`、`R47`、`R58`、`R66`、`R67` 指向的编号在 `PRD.md` 里一条定义都没有，就是这条的实证。
