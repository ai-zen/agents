# 宿主实施顺序

需求见 `PRD.md`，结构与判据见 `packages/host/ARCHITECTURE.md`，风格见 `packages/host/STYLE.md`，术语见 `GLOSSARY.md`。

本文件只剩一件事：**先做哪一块，做完怎么算过关。** 旧 `src` 已整包退到 `packages/host/src-bad`，只作行为参照。

## 顺序

做完的不留在这里（结构与判据归 `ARCHITECTURE.md`）。下面是还没做的：

| # | 做什么 | 过关标准 |
|---|---|---|
| 1 | `modules/config/discovery.ts`（Skill、工具、subagent 的分层目录扫描） | 按优先级合并成一份有效清单；只发现真实存在的目录 |
| 2 | `modules/session/auto-name.ts` | 变闲那一刻给名字还是自动起的会话起一次名，用户改过的不动 |
| 3 | `modules/handoff/`（交接与压缩：换记忆、断点消息、待交接标记兑现） | 交接期间不落库；收口时一条 memory_replaced |
| 4 | `modules/search/`（全文检索） | messages 表上的 FTS 与 trigram 分词；短查询退化到 LIKE |
| 5 | 三处已知缺口：subagent 最后一片正文（core 不转发 `responseFinished`）、连接上的凭证校验（`credential/` 已建但 `createContext` 还没用它）、题挂着时挡不挡 `agent.send` | 每条要能说出具体可见的后果 |

## 门禁

- `tsc --noEmit -p tsconfig.test.json` 通过；
- `npx vitest run` 通过，跑的是域内用例（不起端口、不写真实磁盘）；
- `npx vitest run --config vitest.e2e.config.ts` 通过，跑的是真的一套（`src/app.e2e.test.ts`：真端口、真磁盘、真 WebSocket）；
- 提交信息一行标题说清改了什么，正文写「改前 / 改后 / 为什么」。

## 并行时的边界

同一波次的目录不重叠；跨域共用的单文件（`src/index.ts`、`app.ts`、`modules/events.ts`）由主 Agent 统一改。

## 不再维护

- **方法清单**：真相是 router 的键，手抄一份就多一份会对不上的账。
- **落点表**：文件结构归 `ARCHITECTURE.md`，写在两处必然漂移。
- **波次编号与欠账清单**：做完就删，不留账——账本越厚，越没人读。
- **文档坐标**（`见 PRD D8` 这类）：会过期，而且过期之后没人发现。旧 `PLAN.md` 里 `PRD D8`、`D9`、`D25`、`R47`、`R58`、`R66`、`R67` 指向的编号在 `PRD.md` 里一条定义都没有，就是这条的实证。
