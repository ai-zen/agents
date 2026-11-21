# 宿主实施顺序

需求见 `PRD.md`，结构与判据见 `packages/host/ARCHITECTURE.md`，风格见 `packages/host/STYLE.md`，术语见 `GLOSSARY.md`。

本文件只剩一件事：**先做哪一块，做完怎么算过关。** 旧 `src` 已整包退到 `packages/host/src-bad`，只作行为参照。

## 顺序

做完的不留在这里（结构与判据归 `ARCHITECTURE.md`）。下面是还没做的：

| # | 做什么 | 过关标准 |
|---|---|---|
| 1 | `effective()` 没有消费者，也表达不了「已停用」：停用条目与不存在的条目在返回值里长得一样 | 客户端要做开关列表只能自己读文件——那就是第三份读法 |
| 2 | 连接上的凭证校验：`credential/` 已建、`CredentialService.verify` 有，而 `createContext` 还是 `open(null)` | 任何客户端都能连，令牌形同虚设 |
| 3 | 交接降级的根因看不见：宿主没给 SDK 传 `logger`，`supportsSelfHandoff` 为假时每一趟都降级、堆一串警告，根因只在 SDK 的静默日志里 | 降级要有可追的原因 |
| 4 | 自动交接在 `autoHandoff` 关着时什么也不做：越线了不问用户，也不记「这次不交接」 | PRD 4.5 要求问一次；现在那个 `null` 只表示「这一趟不迁移」，不代表用户表过态 |
| 5 | 旧库补出来的 `searchText` 是空串：列有了、索引重建了，但正文没回填 | 迁移前的旧消息永远搜不到，直到那行被再次 upsert |
| 6 | 嵌套委派把 `subAgent` 覆盖成子执行体（既有行为，`messageAdded` / `messageChanged` / 现在的 `responseFinished` 都一样） | 孙级的话被记到子那一栏；根治要改事件语义，不是补一处转发 |
| 7 | `failed` 事件不转发：子执行体请求失败时，父级与客户端都不知道 | 将来要给 subagent 画错误态时这里还是空的 |

## 已经拍过、不要重开的

- **题挂着时不挡发送。** 要不要因为一道没答的题把发送按钮按住，是客户端的事：它手上就有那道题，而宿主只知道「有这么一道题」却不知道界面上用户正打算做什么。`blocking` 仍进载荷——客户端靠它决定该不该按，而不是靠宿主替它拦。
- **交接不接 Skill。** 交接不是一种能力：把交接文档的模板放进用户可编辑的 Skill 目录，等于用户改一次 Skill 就意外改掉交接行为。用 SDK 内置的那份模板。
  连带一件要清：`ConfigManager.bootstrap()` 仍会释放 `<数据根>/skills/handoff/SKILL.md`，而没人读它。一份看起来是配置点、实质是死的文件，比没有它更糟——要么让 SDK 不再释放，要么先记在这里。

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
