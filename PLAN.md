# 宿主实施顺序

需求见 `PRD.md`，结构与判据见 `packages/host/ARCHITECTURE.md`，风格见 `packages/host/STYLE.md`，术语见 `GLOSSARY.md`。

本文件只剩一件事：**先做哪一块，做完怎么算过关。** 旧 `src` 已整包退到 `packages/host/src-bad`，只作行为参照。

## 顺序

做完的不留在这里（结构与判据归 `ARCHITECTURE.md`）。下面是还没做的：

| # | 做什么 | 过关标准 |
|---|---|---|
| 1 | `modules/config/mcp.ts` + `modules/config/discovery.ts` | 五层 MCP 链与四层 Skill 按优先级合并成一份有效清单；只读、不写 |
| 2 | `modules/scope/` | 能力容器按目录存活；被显式处置时拒绝撞上活着的执行体，不级联 |
| 3 | `modules/session/auto-name.ts` | 变闲那一刻给名字还是自动起的会话起一次名，用户改过的不动 |
| 4 | `modules/agent/`（assembly、subscription、delivery、service、transient） | 一段会话一个执行体、跨投递复用；投递不唤醒；中断不销毁 |
| 5 | `modules/connection/` + tRPC router + 事件流 | 起宿主、连 WS、发一句话、收到流——一条跨进程用例 |
| 6 | `modules/asset/`、`credential/`、`question/`、`handoff/`、`search/`、`notice/` | 每域 0~2 条用例；多加的每一条要说出它证明的是哪个人会犯的错 |

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
