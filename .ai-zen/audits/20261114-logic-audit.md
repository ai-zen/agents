# 三仓逻辑清查（2026-11-14）

只读清查，未改动任何代码、未提交 git、未执行 `git add/commit/checkout`、未跑测试套件、未 build/格式化。
`cli-old-archive` 全程未打开（连 `git status` 都没执行）。

清查对象与基线：

| 仓 | 分支 | HEAD |
|---|---|---|
| `agents` | `feat/server-rewrite` | `e685d03`（能力清单去文案） |
| `cli` | `main` | `0f789a0`（`/help` 用本地命令表） |
| `desktop` | `feat/new-server` | `95e0cbd` |

---

## 怎么查的

**读过的判据文档**：`agents/packages/host/docs/PRD.md`（全文）、`PLAN.md`、`architecture.md`（按关键词定位）、三仓的 `AGENTS.md` / 关键文件头注释。PRD 是唯一需求来源，凡是「代码这么写」与 PRD 冲突的，一律记在「需人拍」。

**覆盖的目录**（生产码，排除 `node_modules` / `dist` / `out`）：

- `agents/packages/host/src`（71 个生产 ts 文件）、`agents/packages/client/src`、`agents/packages/testing/src`
- `cli/src`（94 个生产 ts/tsx）
- `desktop/packages/main/src`、`render/src`、`shared/src`

**用过的命令/手法**：

1. **零消费者扫描**（自写脚本，跑在内存里，不落盘）：抽出每个生产文件里的 `export const/function/class/interface/type/enum`，统计该符号在三仓**所有**生产文件（含 `.vue`）与测试文件里的出现次数，`生产出现次数 = 1`（只有定义本身）即候选，再逐个人工核实。跨仓计数很重要 —— 单仓计数会把「定义在 shared、被 render 用」误判成死代码（第一版脚本就踩了这个坑，`ConversationSummary` 等 10 个 shared 类型其实是活的）。
2. **i18n 键扫描**：抽出 `en.ts` / `zh.ts` / `en-wizard.ts` / `zh-wizard.ts` 的全部键，统计「作为字面量出现在生产代码里」的次数；再人工核对 `t(\`x.${y}\`)` 这类动态键，避免把 `label.${id}` 误判为死键。一个已知偏差：注释里用反引号引用键名（如 `wire/states.ts:40` 的「稳定码（如 `notice.settingsSaved`…）」）会被算成"被引用"，所以扫描只能**漏报**、不会误报 —— 报告里那 8 条"只有用例在用"就是这么找出来的（先算活的，再 grep 确认生产里只有注释提到它）。
3. **契约面覆盖扫描**：从 `wire/methods.ts` 的 `METHOD_NAMES` 取 63 个方法名，逐个在 cli / desktop 生产代码里搜字面量，找出「两端都不调」的方法。
4. **定点 grep 复核**：每个「零消费者」结论都再用 `grep -rn` 在三个仓的 `src` 里确认一次（排除 test/dist/node_modules），并列出「只有测试在用」的具体位置。
5. **文档 ↔ 代码对读**：PRD §2 决策 / §4 能力行与实现对照（D5 上限、D8 语言、D25 发现文件、D32 恢复出厂、F-E1 命令集、F-I6 状态栏、F-I13 一次往返）。

**没覆盖的部分（以及原因）**：

- `agents/packages/host/src/runtime/ChatRunner.ts`（1689 行）与 `app.ts`（1391 行）：只做了符号级扫描 + 关键路径（落盘/事件/退出判据）抽读，没有逐行通读。这两处如果还藏着结构问题，本报告没有覆盖。
- 三仓的 e2e / 集成测试只抽读了与本报告结论直接相关的几条（`handlers/index.test.ts`、`wire/methods.test.ts`、`cli/commands/handlers.test.ts`）。
- `desktop` 处于分波次施工中（`PLAN.md` 的 W1–W5）：**「桌面端还没调某个方法」不算问题**，本报告没有把它算进零消费者；只有「两端都不调、且用例在替它续命」才记。
- 没有跑 `tsc --noEmit`（结论不依赖类型检查通过与否）、没有跑测试、没有构建 —— 按任务口径避免耗时与写盘。

**排序口径**：危害 × 确定性降序。确定性分「确证」（我按上面 4 步核实过）与「疑似」（有证据链但有一处置疑点）。

---

## 发现

### 1. 能力清单（63 条 × 4 字段）与 `host.capabilities` 全链路零消费者，只剩宿主自己的用例在读

**类型**：1（零消费者）+ 4（职责错位）

**证据**

- 清单本体：`agents/packages/host/src/handlers/capabilities.ts:139-153`

```ts
export function createCapabilities(): CapabilityView[] {
  const used = new Set<string>();
  return FACTS.map((fact) => {
    const id = used.has(fact.prd) ? `${fact.prd}#${actionOf(fact.method)}` : fact.prd;
    used.add(fact.prd);
    return { id, domain: methodDomain(fact.method), method: fact.method, blocking: fact.blocking, destructive: fact.destructive };
  });
}
```

- 契约面：`wire/methods.ts:72-89`（`CapabilityView`）、`:220`（`capabilities: CapabilityView[]`）、`:1847`（`"host.capabilities"`）、`:156-165`（`hello` 里的 `capabilities: string[]`）。
- 唯一的注册点：`handlers/hostHandlers.ts:62` → `"host.capabilities": () => ({ capabilities: deps.capabilities() })`。
- **三仓生产代码里对 `host.capabilities` 的调用：0 处。** 三仓里出现的全部是测试：`host/src/app.test.ts:312`、`host/src/handlers/hostHandlers.test.ts:151`、`host/src/host.integration.test.ts:306`、`net/WsHub.test.ts:54`、`agents/packages/client/src/integration.test.ts:105`、`cli/src/commands/handlers.test.ts:338`（stub 成 `{ capabilities: [] }`）。
- `hello.capabilities`（63 个 id 字符串）同样零读取：desktop 明确丢弃（`desktop/packages/main/src/host/index.ts:90-100`：「回执还带 `capabilities` / `limits` / `startedAt`，而它们对界面没有意义（一个字段只要没人读，就会有人以为它该被读）」）；CLI 只把整个 hello 存下来的接口引用着（`cli/src/session/types.ts:120`），生产代码里没有任何一处读 `.capabilities`。
- `blocking` / `destructive` 想服务的那个界面行为也没有接上：CLI 既不读能力清单，也不读自己的 `blocksInput`（见第 6 条），输入框是靠 `busy` 状态挡的（`cli/src/tui/screens/chat.tsx:232-234`、`:1373`）。

**为什么不合逻辑**：刚删掉 `title` / `description` 的那一刀，理由是「宿主里的客户端文案零消费者」。删完剩下这四个字段（编号、域、方法名、两条布尔）同样是**零消费者**，只是从「没有人读的句子」变成了「没有人读的事实」。更绕的是：能力清单存在的理由写在注释里是「F-E6 让界面显示正在执行什么」，而界面的那件事由另一条路（`busy`）实现了，且实现时并不知道「这个操作会不会阻塞」这个属性 —— 于是「阻塞是能力属性」这句话在代码里没有任何落点。

**影响面**：占地方（63 条 × 4 字段 + `hello` 里 63 个字符串每连接一次）+ 会骗人（下一个人读 F-E5/F-E6 与 `architecture.md:309` 会以为两端在用）。它不是"会漂"，它是"从来没有被用过"。

**建议**：二选一 —— (a) 客户端真去读，用它做二次确认与「正在执行什么」（`destructive` → 确认框，`blocking` → 忙提示），同时也就能删掉 CLI 那份死掉的 `blocksInput`；(b) 从契约面删掉 `host.capabilities` 与 `hello.capabilities`，`CapabilityView` 只留宿主内部用于自检，PRD F-E5/F-E6 跟着订正。

**置信度**：确证。

**需人拍**：是。拍什么：F-E5「帮助由客户端清单渲染」已经定了文案归客户端，但 F-E6 说「这个操作会阻塞是能力属性」—— 那这条属性究竟由谁用、用在哪一屏？不给答案，这 63 条就只能继续挂着。

---

### 2. 状态栏块名 `StatusBlock.label` 是「绑在宿主里的客户端文案」（8 块 × 2 语言），唯一消费者是 CLI 状态栏

**类型**：4（职责错位）—— 与已修的 `title`/`description` 完全同一类

**证据**

- 宿主导出块名：`agents/packages/host/src/wire/states.ts:515-542`

```ts
  | { id: "thinking"; label: LocalizedText; facts: ThinkingState }
  | { id: "context"; label: LocalizedText; facts: ContextState }
  | { id: "usage"; label: LocalizedText; facts: UsageSnapshot }
  | { id: "cwd"; label: LocalizedText; facts: FolderFact }
  | { id: "tools"; label: LocalizedText; facts: { running: RunningTool[] } }
  | { id: "subagents"; label: LocalizedText; facts: { items: SubAgentSnapshot[] } };
```

- 宿主渲染：`handlers/conversationHandlers.ts:328-332`

```ts
function blockLabel(id: StatusBlockId, language: Language): StatusBlock["label"] {
  const messageKey = `label.${id}` as MessageKey;
  return { code: messageKey, messageKey, params: {}, message: render(language, messageKey) };
}
```

- 词条：`host/src/i18n/zh.ts:90-97`（`label.agent` 助手 / `label.cwd` 目录 / …）、`en.ts:94-101`。
- 唯一把 `label.message` 放上屏的地方：`cli/src/tui/components.tsx:168-181`

```ts
 * 「块名 + 值」的写法统一：块名用宿主渲染好的 `label.message`（`助手` / `模型` / `上下文` …），
  const label = (text: string, color: string): StatusSegment[] => [
    { text: `${block.label.message} `, color: theme.dim },
```

- desktop 不读：`render/src/stores/chat.ts:283` 只取 `run` / 消息等字段；`shared/src/types.ts` 里 `statusBlocks` 只是注释提及。

**为什么不合逻辑**：和那 252 条一模一样的病 —— 屏幕上那几个词（助手 / 模型 / 思考强度 / 上下文 / 用量 / 目录 / 在跑的工具 / 子 Agent）住在宿主里，宿主版本不升就改不动；而它们没有任何事实成分（不带数字、不带状态），纯粹是界面词汇。CLI 自己的 i18n 里根本没有 `label.*` 这一族键（说明了这套词本来就不属于它，是被迫接受的）。

**影响面**：会骗人 + 会漂：一旦某端想改叫法（CLI 刚做过一轮「术语统一」`ae9d988`），这一块只能等宿主发版；桌面端将来做状态栏时又会自己再造一套中文。

**建议**：`label` 从 `StatusBlock` 删掉，8 个 `label.*` 键从宿主 i18n 删掉，CLI 在自己的词典里写 `status.block.agent` 等 8 条。事实（`facts`）/ 顺序（`STATUS_BLOCK_IDS`）留在宿主不动 —— 那两样确实是 S+C 里 S 的那一半。

**置信度**：确证。

**需人拍**：是。拍什么：PRD F-I6 的边界只写了「字段结构化，不能给一坨字符串」，没说块名归谁；按 F-E5 的订正方向（文案归界面）应当搬走，但这会动 `conversation.state` 的出参形状。

---

### 3. 宿主 i18n 里 34 组键（两语言共 68 条句子）没有生产产出：其中 26 组彻底没人用，8 组只靠用例活着

**类型**：1（零消费者 / 零生产者）+ 6（用例续命）

**证据**（`agents/packages/host/src/i18n/en.ts`，行号同 `zh.ts` 的一组）

```
40  "notice.workspaceDeleted": "Project removed, along with its {count} conversation(s)…"
53-62  "status.connected" … "status.error"（六态 10 条）
73  "notice.hardLimitHit"
77  "message.reverted"
78  "message.cwdMissing": "This project's folder no longer exists ({cwd})…"
88-91  "usage.turn" / "usage.total" / "usage.rate" / "usage.withSubAgents"
143  "model.unavailable"
147-149 "handoff.noDocuments" / "workspace.removalCost" / "attachment.tooLarge"
```

（`label.*` 那一族 8 条**不在**本清单里：它们由 `label.${id}` 动态取用、`conversationHandlers.ts:330` 真的在渲染，虽然同为"宿主替客户端说话"，但它们是活的 —— 那条问题记在第 2 条。）

核实方法：把每个键当字面量在三仓生产码里搜（无命中），再确认没有动态拼法（`status.` / `usage.` 前缀在宿主里没有任何模板字面量使用；`label.${id}` 是唯一一处动态键，所以 `label.*` 的 5 条**不是**死键，已从名单里剔除）。通知的产出点只有 7 个 code：`notice.handoffWritten`、`notice.autoNamed`、`notice.configRecovered`、`notice.upgradeRestarting`、`notice.logWarning`/`logError`、`notice.settingsApplied`（`HandoffService.ts:314`、`AutoNaming.ts:228`、`app.ts:625/889/1113/1226`、`NoticeService.ts:246`）+ `notice.attachmentDropped`（`AssetService.ts:388/542`）。`notice.conversationDeleted` / `workspaceDeleted` / `assetsUploaded` / `languageChanged` / `hardLimitHit` 一个都造不出来。

**彻底零产出（26 组）**：`notice.conversationDeleted`、`notice.workspaceDeleted`、`notice.assetsUploaded`、`notice.languageChanged`、`notice.hardLimitHit`、`status.*` 10 条里除 `connected` / `idle` 之外的 8 条、`message.reverted`、`message.cwdMissing`、`message.subagentFinished`、`message.attachmentTooMany`、`usage.turn` / `usage.total` / `usage.rate` / `usage.withSubAgents`、`model.unavailable`、`handoff.declined`、`handoff.noDocuments`、`workspace.removalCost`、`attachment.tooLarge`。

**只有用例在用的 8 组**：`notice.settingsSaved`、`status.connected`、`status.idle`、`question.confirm.prompt` / `.accept` / `.decline`、`endpoint.missing`、`model.visionRequired`。其中 `notice.settingsSaved` 最典型：生产代码里一处都不造它（真正会发的那条是 `notice.settingsApplied`，`app.ts:1226`），它今天活在 5 个用例文件里当固定夹具（`services/NoticeService.test.ts:81` 起 10 处、`wire/frames.test.ts:189`、`net/WsHub.test.ts:409/500`、`storage/migrations.test.ts:207`、`handlers/noticeHandlers.test.ts:69`），而它作为"稳定码"的示例还写在契约注释里：`wire/states.ts:40`「稳定码（如 `notice.settingsSaved`、`tool.failed`），与文案键分开」—— 拿一个没人产出的码当范例。

**为什么不合逻辑**：这类键的存在意味着「曾经打算由宿主说这句话」，现在说这句话的人换成了客户端或干脆没人说 —— 但键还留着，且**术语已经跟客户端相反**：`notice.workspaceDeleted` 说 "Project / 项目"，`message.cwdMissing` 说 "这个项目"，而 CLI 那一轮术语统一（`cli` `ae9d988`）把 workspace 定成「工作区」，用的正是已被判定为非法的「项目」这个词。其中 `notice.languageChanged` 更直接：CLI 自己有一模一样的一条并在生产里发（`cli/src/commands/handlers.ts:800` → `push(t("notice.languageChanged"))`），宿主那条是同一句话的第二份。

**影响面**：占地方 + 会骗人（读代码的人会以为「删对话会有一条通知」这种能力已实现）。

**建议**：删。删之前逐条确认是不是「功能缺失」而不是「文案多余」—— 尤其是 `notice.conversationDeleted` / `workspaceDeleted` / `hardLimitHit`：如果产品上本来该有这三条提示，那是缺功能；如果本来就不该有（客户端自己说），那就删键。

**置信度**：确证（零产出这一事实），需人拍（其中几条到底是多余文案还是漏掉的功能）。

**需人拍**：是（见上）。

---

### 4. 去文案那一刀留下的三处假注释 / 假用例名

**类型**：5（假注释、假文档）

**证据**

1. `agents/packages/host/src/wire/methods.ts:145-149`

```ts
 * 除了握手成功本身，还把「这条连接以后说哪种语言」「宿主是什么版本」「有哪些能力」
 * 一次给全：客户端连上就能把界面语言定下来（D8）。能力只给 id 列表（R57）：握手这一帧
 * 要小，完整清单（标题、说明、阻塞与不可撤销）走 `host.capabilities`，那一份按连接语言渲染。
```

→ `title` / `description` 已删（`e685d03`），`createCapabilities()` 也已不收语言参数，这两句全假。

2. `agents/packages/host/src/i18n/en.ts:168-169`（文件末尾，`zh.ts` 里已删、`en.ts` 漏了）

```ts
  // 每个方法一条标题（`capability.<方法名>`）加一句说明（`.detail`）；
  // 编号与阻塞 / 不可撤销属性见 `handlers/capabilities.ts`
} as const;
```

→ 那 126 条 `capability.*` 已删，这行注释在说「每个方法一条标题」。

3. `agents/packages/host/src/handlers/index.test.ts:181`

```ts
  it("每个方法都在清单里，标题与说明的文案键真的存在", () => {
```

→ 用例体（183-200 行）现在断言的是**反面**：「清单里只有事实：没有文案字段」。

**为什么不合逻辑**：一个专治「假注释」的改动，自己留下了三处假注释，其中一处还在**用例名**里 —— 用例名是下一个人 `grep` 能力清单时最先读到的一行。

**影响面**：会骗人（比占地方严重：它会把下一个人往「去加 title/description」的方向拽）。

**建议**：methods.ts 那两句改成「清单只有四个事实字段，与语言无关」；en.ts 末尾两行删；用例名改成「每个方法都在清单里，清单只有事实字段」。

**置信度**：确证。

**需人拍**：否。

---

### 5. 「20MB / 4 张」这套上限有 4 份独立定义，而宿主一直在把它们发给客户端，客户端却不读

**类型**：2（同一事实两处维护）+ 1

**证据**

- 宿主真相：`host/src/wire/states.ts:399-402`

```ts
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_ASSETS_PER_MESSAGE = 4;
```

- 宿主随握手/配置发出去：`wire/methods.ts:167-173`（`TransferLimits`）、`net/WsHub.ts:684-685`（`hello.limits`）、`services/ConfigService.ts:468-469`（`config.get` 的 `limits`）。
- 客户端层的缺省副本：`agents/packages/client/src/upload.ts:46-50`

```ts
export const DEFAULT_MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_ASSETS_PER_MESSAGE = 4;
```

（这一份用法是对的：`limitsOf(client)` 优先取 `hello.limits`，常量只是 fallback。）
- CLI 的两份副本，**完全不看宿主的数**：

```
cli/src/clipboard.ts:45-46
/** 单张粘贴图片上限：与 SDK 默认内联上限（8MB）同量级，留出 base64 膨胀余量 */
export const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;

cli/src/tui/screens/chat.tsx:158
export const MAX_PASTED_IMAGES = 4;
```

并且 `chat.tsx:667` 拿 `MAX_CLIPBOARD_IMAGE_BYTES` 换算成 MB 直接写进提示语（`limit: Math.round(MAX_CLIPBOARD_IMAGE_BYTES / 1024 / 1024)`），也就是**这句提示是客户端算的**，而宿主其实把 `maxAssetBytes` 都发过来了（`config.get` / `hello`）。

**为什么不合逻辑**：PRD D5 是宿主侧决策（上限、在 `asset.begin` 就拒），事实只有一份；客户端却各自写死。CLI 那两份是"本地先拒"的体验优化，可以留，但取值应当来自宿主（`hello.limits` 或 `config.get().limits`），否则宿主把上限从 20MB 调到 10MB 之后：CLI 仍然允许粘贴 20MB 并显示「最大 20MB」，等到 `asset.begin` 才被拒。另外 `clipboard.ts:45` 那句注释本身也偏了：20MB 是 D5 的单张上限，不是「与 SDK 8MB 内联上限同量级」的推算结果。

**影响面**：会漂（两处数字 + 一处提示文案），漂了之后症状是「提示说 20MB，实际被拒」。

**建议**：CLI 的 `MAX_CLIPBOARD_IMAGE_BYTES` / `MAX_PASTED_IMAGES` 改成从连接上拿（`hello.limits` 或 `config.get().limits.maxAssetsPerMessage`），保留常量只作「拿不到时」的兜底（与 client 层同一写法）；注释改成「与 PRD D5 一致」。

**置信度**：确证。

**需人拍**：是（小口径）：上限的真相在宿主这一条要不要贯彻到客户端本地预检 —— 若贯彻，CLI 需要在连接建立后把 limits 落进 context（今天没有这个字段）。

---

### 6. CLI 命令表里三条导出只有用例在读，且注释把消费者说错了（其中一条说"宿主据此拦住输入框"，而同一文件 100 行后写着"宿主不知道命令这回事"）

**类型**：1 + 5

**证据**

1. `cli/src/commands/registry.ts:40-47`

```ts
  /**
   * 执行期间会调用模型（较慢，几十秒）。
   *
   * 宿主据此**拦住输入框**：否则用户以为没反应、继续打字，按键会被静默吞进隐藏的
   * 输入缓冲，等命令结束后才突然冒出来（迁移过程中出现过这个 bug）。
   * 这是命令的属性而不是宿主的白名单 —— 新增命令只改本文件，宿主自动跟上。
   */
  blocksInput?: boolean;
```

- 与之矛盾的是同一文件 `:170`：「命令名的解析**只有这一处**（宿主不知道命令这回事，它只认方法名）」。
- 真实消费者：`commandBlocksInput`（`:141-143`）在生产代码里**零调用**（三仓 grep：只有 `registry.ts` 自己与 `registry.test.ts`）；真正挡住输入框的是 `chat.tsx:232` 的 `busy` 状态（`:1090` 的 `{ isActive: !busy && !pickerState && !wizardStep }`）。
- 所以 `handoff` / `migrate` 上的 `blocksInput: true`（`:103-104`）不影响任何行为。

2. `cli/src/commands/registry.ts:205-211`

```ts
/**
 * 命令列展示宽度：按最长展示命令串对齐，供 `/help` 与输入提示共用。
 * 展示命令串均为 ASCII，`padEnd` 的字符数即显示宽度。
 */
export const COMMAND_LABEL_WIDTH = Math.max(...getCommandHints().map((hint) => hint.label.length)) + 3;
```

→ 生产零引用（`/help` 与输入提示都没用过它），只有 `registry.test.ts:63` 断言它大于最长 label。

3. `cli/src/commands/registry.ts:224-231`

```ts
/** 全部命令名（含别名，升序），供启动横幅等场景展示 */
export function getCommandNames(): string[] {
```

→ 生产零引用，只有 `registry.test.ts` 用了 7 处。

**为什么不合逻辑**：`blocksInput` 是「属性已声明、机制没接」，还配了一句把机制指到宿主的注释 —— 而下一个人要修「命令执行时输入框没被拦住」这个真 bug 时，会先信这条注释去找宿主的白名单（不存在），而不是去看 `busy`。另两条是纯死代码 + 假注释（各自声称一个不存在的消费者）。

**影响面**：会骗人（上面第 1 小点）+ 占地方（第 2、3 小点）。

**建议**：`blocksInput` / `commandBlocksInput` 要么接进 `chat.tsx`（命令执行前判一次），要么删字段与注释；`COMMAND_LABEL_WIDTH` / `getCommandNames` 删（连同对应用例 —— 那是「用例在给死代码续命」）。

**置信度**：确证。

**需人拍**：否（删是安全的；若选择"接上"，那是小改动不是裁决）。

---

### 7. 「PRD 能力号 ↔ 方法名」这张映射有两份，且已经对不上（`destructive` 10 条 vs 对照表 2 条）

**类型**：2（同一事实两处维护）+ 6（用例钉的是另一份副本）

**证据**

- 实现侧：`host/src/handlers/capabilities.ts` 里 `destructive: true` 共 **10 条**：`:64` `workspace.remove`、`:72` `conversation.delete`、`:75` `conversation.revert`、`:94` `config.deleteMcp`、`:96` `config.deleteEndpoint`、`:102` `agent.delete`、`:105` `agent.restoreFactory`、`:111` `model.delete`、`:112` `model.restoreFactory`、`:114` `model.deleteImage`。
- 用例侧：`host/src/wire/methods.test.ts:179-247` 手写了一份 `coverage: Record<string, MethodName[]>`（注释自称「这张表是 PM 复核用的对照关系」），其中 `:222`

```ts
      "F-F9": ["conversation.delete", "workspace.remove"],
```

- 这张表唯一的断言是「这些方法名在 `METHOD_NAMES` 里」（`:240-246`），**从不与 `capabilities.ts` 交叉核对**：把某个方法从 `FACTS` 里删掉或改 `destructive`，这条用例照样绿。

**为什么不合逻辑**：同一条事实（哪个方法服务哪条 PRD 能力、哪些不可撤销）被记了两遍，两遍的口径还不一样：实现说 10 个方法不可撤销，对照表说 F-F9 只有 2 个（其余 8 个在对照表里根本没挂在 F-F9 下）。而对照表的读者恰恰是「拿它复核」的人 —— 他读到的是一份过期的图。

**影响面**：会骗人（复核者）+ 会漂（两张表各自演进）。注意：这不是「用例在测一个不存在的风险」，它测的确实存在，只是测的是**副本**。

**建议**：删掉 `methods.test.ts` 里那张手写 coverage 表，改成「`FACTS` 的 `prd` 集合 ⊆ PRD §4 编号集合」这类从实现反推出的性质断言；若 PM 复核真的需要一份对照表，就由 `createCapabilities()` 现场生成，不手写。

**置信度**：确证。

**需人拍**：是（轻）：复核用的对照关系要不要留成代码资产 —— 留就得有唯一一份。

---

### 8. 思考档位名有三处维护（SDK 策略表 / CLI 的 `KNOWN_EFFORT_LEVELS` / CLI 词典），已经漂了一条：`effort.custom` 永远显示不出来

**类型**：2 + 1

**证据**

- CLI 的档位白名单：`cli/src/reasoning-effort.ts:26-39`

```ts
export const KNOWN_EFFORT_LEVELS: readonly string[] = ["off","none","minimal","low","medium","high","xhigh","max"];
export function effortLabel(level: string): string {
  return KNOWN_EFFORT_LEVELS.includes(level) ? t(`effort.${level}`) : level;
}
```

- CLI 词典里多一条：`cli/src/i18n/en.ts:32` `"effort.custom": "custom"`、`zh.ts:47` `"effort.custom": "自定义"` —— `custom` 不在白名单里，所以这两条**永远取不到**（动态键 `effort.${level}` 的取值域就是白名单）。
- 真相在 SDK：`agents/packages/sdk/src/config/reasoning-presets.ts:23`（档位名由策略表决定：`none/minimal/low/medium/high/xhigh/max`…）、`:44`。

**为什么不合逻辑**：档位名是宿主/SDK 侧事实（用户可以自建策略、自定档位名），CLI 这份白名单只是为了让 `t()` 有个取值域。它现在处于「既不是穷举（注释也这么说）又要靠它决定翻不翻译」的中间态；而词典那一侧是按另一份名单写的（多了 `custom`），于是同一个集合有三份口径、已经漂了一条。

**影响面**：会漂 + 会骗人（`custom` 档在中文界面会显示英文原文 `custom`；读词典的人以为它在用）。

**建议**：把「要翻译的档位名」这一份收成一处 —— 或者让 SDK 的档位名带上 `label` 事实（那是 S+C 里 S 的一半），或者干脆承认「未收录就显示原文」并删掉白名单外的 `effort.custom`。

**置信度**：确证。

**需人拍**：是（轻）：档位名要不要由宿主给一份可本地化的清单（会动 `ThinkingState` 形状）。

---

### 9. CLI 词典里还有 8 组键零产出（`effort.err.*` 5 条 + `ws.empty` / `ws.created` + `common.disabledSuffix`）—— 与已修的 case 同一类：规则搬到宿主后错误文案没删

**类型**：1

**证据**

- `cli/src/i18n/en.ts:211-215`（`zh.ts` 对应）

```
211  "effort.err.agentMissing": 'Agent "{id}" does not exist',
212  "effort.err.noModel": 'Agent "{id}" has no model bound — pick one for it first',
213  "effort.err.modelMissing": 'Model "{id}" does not exist — check with /model or /config',
214  "effort.err.noPreset": 'Model "{id}" has no usable reasoning levels, so the effort cannot be set',
215  "effort.err.unknownLevel": 'Preset "{preset}" has no level "{level}" (available: {options})',
```

- `cli/src/i18n/en.ts:266` `"ws.empty"`、`:274` `"ws.created"`
- `cli/src/i18n/en-wizard.ts:122` `"common.disabledSuffix"`（`zh-wizard.ts:126`）

核实：三仓生产码里这些键作为字面量出现 0 次；也没有 `effort.err.${x}` 这类动态拼法（唯一动态键是 `effort.${level}`、`wiz.reload.${key}`、`cmd.model.scope.${…}`）。

**为什么不合逻辑**：`effort.err.*` 是「CLI 自己校验档位」年代的产物 —— 现在这件事归宿主（`conversation.setThinking` / `agent.setThinking` 会回 `invalid_params` + 一句宿主渲染的话）。规则搬走了，五句错误文案留下来，且写得很具体（会让人以为 CLI 还会报这些错）。这与 `capability.*` 那 126 条是同一个病因。

**影响面**：占地方 + 会骗人（小）；`/ws` 的两条（`ws.empty` / `ws.created`）更值得注意：它们对应的工作区屏文案已被 `cmd.ws.*` 那组取代（`en.ts:69,137-146`），两组并存说明同一屏有两套话。

**同族的第二条（弱一些，故并入本条）**：CLI 词典本身没有编译期守卫，也不存在「每个键都被引用」的检查。

- 词典是 `Record<string, string>` 且两张表靠 spread 合并：`cli/src/i18n/index.ts:38-41`

```ts
const DICTS: Record<Locale, Record<string, string>> = {
  zh: { ...zh, ...zhWizard },
  en: { ...en, ...enWizard },
};
```

- `t()` 在缺词条时把 key 本身当文案返回：`i18n/index.ts:105-110`（`if (template === undefined) return key;`）—— 设计意图写在 `:10` 的注释里。
- **有**一条对称性用例：`i18n/index.test.ts:84-93`「中英文词条一一对应（英文不缺 key）」，覆盖 `zh/en` 与 `zh-wizard/en-wizard` 两组。所以"两张表会漂"这条**不成立**，我没有把它算进危害。
- 缺的是另外两样：`t("…")` 里打错一个字不会被任何东西发现（今天只有第 8 条举出的 `effort.custom` 那种"词条多出来"的反向漏），因为词典没类型、也没有"所有键至少被引用一次"的用例；另外宿主那边有 `} satisfies Record<keyof typeof en, string>`（`host/src/i18n/zh.ts` 末尾）+ `MessageKey = keyof typeof en`，CLI 这边把这类错误从"构建失败"降级成"用户看到 `cmd.xxx.desc`"。

**建议（含上一条）**：删这 8 组（16 条）；`en*` 用 `as const` + `zh*` 用 `satisfies Record<keyof typeof en, string>`（照宿主）；补一条「词典里每个键在生产码里至少出现一次」的用例（动态键那 3 处各自写显式白名单）。

**置信度**：确证。

**需人拍**：否。

---

### 10. `cli/src/mode.ts` 说发现文件是 `run/server.json` —— 全仓没有这个文件

**类型**：5（假注释）

**证据**：`cli/src/mode.ts:15-18`

```
 * 三条**会连服务端**的路径（stdio / TUI / `--server-status`）都把它带在结果上，由根（`app.ts` 的 `CliApp`）
 * 交给 `env.ts` 与环境变量一起定优先级，再往下递给三条路径；接什么后端（发现文件
 * `run/server.json`、凭证文件 `run/token`）由 `@ai-zen/agents-client` 决定。
```

核实：三仓（含三个仓的 `.md`）里 `server.json` 只有这一处；真实文件是 `<数据根>/run/host.json`（PRD D25；实现 `client/src/connection.ts:194-197` `hostFilePath`、宿主 `net/discovery.ts:47-62`）。

**为什么不合逻辑**：这是「实现已改名、注释没跟」的典型 —— 读这段注释去排查的人会在数据根下找一个不存在的文件名，而 `run/token`（同一句里的另一个文件）是对的，更让人信以为真。

**影响面**：会骗人。

**建议**：改成 `run/host.json`。

**置信度**：确证。

**需人拍**：否。

---

### 11. `host.reload` 的 `scope` 参数从来没有调用方传过；宿主侧却为它维护 5 值枚举 + 校验 + 映射

**类型**：3（可选参数从来没有调用方传 / 分支永远只走一条）

**证据**

- 契约：`host/src/wire/methods.ts:223-234`

```ts
export type HostReloadScope = "config" | "agents" | "tools" | "skills" | "mcp";
export interface HostReloadParams {
  scope?: HostReloadScope;
}
```

- 唯一调用方：`cli/src/session.ts:345` → `await this.connection.call("host.reload", {});`（desktop 生产码不调）。
- 宿主实现：`services/ConfigService.ts:109-110`（`RELOAD_SCOPES`）、`:280-302`（校验 + `reloadedOf(scope)`）；注释自称"不给 `scope` 表示全部"（`methods.ts:231-233`）。

**为什么不合逻辑**：五个档位一个都没人用过 —— 要么客户端本该提供"只重载 MCP"这种入口（今天 `/reload` 只能全量），要么这层参数是凭空的扩展点。同时 `applied.reloaded` 这个出参是**真的有消费者**（CLI 与向导会把"重新加载了什么"念出来，见 `cli/src/tui/config-wizard/engine.ts:104` 的 `wiz.reload.${key}`），也就是说：报告一侧在用，输入一侧没人用。

**影响面**：占地方（契约面 + 校验 + 5 条词条 `wiz.reload.*`）+ 会让下一个人以为"只重载某一类"已经可用。

**建议**：二选一 —— (a) 删 `scope` 参数（契约小改），`reloaded` 报告照旧；(b) 给 `/reload` 加 `config|agents|tools|skills|mcp` 子参数（CLI 侧一行），让这个能力真的有入口。

**置信度**：确证。

**需人拍**：是（动契约面二选一）。

---

### 12. 桌面端把 `hello` 回执翻成 `{protocol, version}` 有两份实现

**类型**：2

**证据**

- `desktop/packages/main/src/host/index.ts:204-212`

```ts
function helloOf(hello: HostHelloResult | null): LayerHello | null {
  if (!hello) return null;
  const protocol = Number.parseInt(hello.protocolVersion, 10);
  return { protocol: Number.isFinite(protocol) ? protocol : 0, version: hello.hostVersion };
}
```

- `desktop/packages/main/src/connection/controller.ts:381-391`

```ts
      const hello = client.hello;
      if (!hello) { return { ok: false, message: "连上了宿主，但它的握手回执里没有身份（拿不到协议版本）" }; }
      const protocol = Number.parseInt(hello.protocolVersion, 10);
      return { ok: true, protocol: Number.isFinite(protocol) ? protocol : 0, version: hello.hostVersion, elapsedMs: ... };
```

**为什么不合逻辑**：同一句 `Number.parseInt(protocolVersion, 10)` + `Number.isFinite ? : 0` 的口径写了两遍（一处给 `ready` 状态、一处给"测试连接"探针）。`protocolVersion` 将来改成 `"1.0"` 或加后缀时，两处要同时改，漏一处就是"设置页显示 1、状态栏显示 0"。

**影响面**：会漂（小，但表现是两块屏不一致）。

**建议**：`controller.ts` 复用 `helloOf()`（它已经在同一个包、同一个依赖方向上）。

**置信度**：确证。

**需人拍**：否。

---

### 13. 一批只被用例续命的导出 / 类型（跨三仓，同一条）

**类型**：1 + 6（用例在给死代码续命）

**证据与清单**（三仓生产码出现次数 = 1，即只有定义；括号内是用例引用处）

宿主（`agents/packages/host/src`）：

- `services/ModelService.ts:130` `findImageModel`（0 处引用，连用例都没有 —— 与 `findModel` 并列的"按 id 找图片模型"，而图片模型的查找在别处又写了一遍）
- `storage/types.ts:18` `MessageRole`（注释自承「取值与 core 的 `AgentNS.Role` 对齐」—— 同一枚举的第二份，且自己也没人用）
- `wire/states.ts:430` `LocalMessageContent`（类型别名，0 引用；旁边的 `LocalMessageContentSection` 才是活的）
- `handlers/configHandlers.ts:121` `ConfigMethodHandler`（注释说「便于用例直接调」，但没有一个用例调它）

CLI（`cli/src`）：

- `config-editor.ts:167` `uniqueMcpServerId`、`:179` `findMcpServer`、`:188` `mcpServerIdTaken`、`:351` `parseFunctionParameters`（4 个都只有 `config-editor.test.ts` 在读）
- `config.ts:48` `ConfigIssue`（0 引用）、`system-editor.ts:11` `OpenEditor`（0 引用）
- `version-compare.ts:96` `pickNewest`（只有用例）、`tui/highlight.ts:85` `supportedLanguages`（只有用例）、`tui/screens/frame-buffer.ts:30` `isImmediateEvent`（只有用例）

桌面端（`desktop/packages`）：

- `shared/src/types.ts:543` `WindowStateEvent`（0 引用；对应的窗口控制走 `WindowControls.isMaximized()` 这种拉取式接口，没有任何地方推这个事件）

**为什么不合逻辑**：这些不是"接口美观"，而是**死代码 + 用例**的组合：用例的存在让人 `grep` 时看到"有人在用"，于是不敢删。`MessageRole` 更绕：它与 core 的 `AgentNS.Role` 是同一枚举的两份，谁也没用，留着只会诱使下一个人用错那一份。

**影响面**：占地方；`MessageRole` / `findImageModel` 这类"第二份"还有会漂的潜力。

**建议**：删。删完顺手确认用例是否也随之失去意义（`config-editor.test.ts` 里那 4 个函数的用例应当一起删 —— 它们测的是没人调的函数）。

**置信度**：确证。

**需人拍**：否。

---

### 14. 连接层把宿主 `HostFileInfo` 的子集重抄了一份（同一个包里明明可以 import 宿主类型）

**类型**：2

**证据**

- `agents/packages/client/src/connection.ts:67-74`

```ts
/** `run/host.json` 里本模块用到的字段（宿主 `net/discovery.ts` 的 `HostFileInfo` 的子集） */
export interface LocalHostFacts {
  pid: number;
  host: string;
  port: number;
}
```

- 同一个包已经在 import 宿主的类型：`client/src/index.ts:157-162`（`export type { … LocalMessageContentSection } from "@ai-zen/agents-host"`），`upload.ts:40`（`import type { AssetRef } from "@ai-zen/agents-host"`）。
- 路径也各算一份：`client/src/connection.ts:194-197` `join(dataRoot, "run", "host.json")` vs 宿主 `config.ts` 的 `HostPaths.hostFile`。

**为什么不合逻辑**：字段名与文件位置都是"同一份真相"（PRD D25 明说发现文件是唯一真相）；连接层偏偏用结构子集重声明了一次 —— 它不是"顺手少写几行"，而是把"字段名叫什么"这件事抄了第二遍。宿主把 `host` 改成 `hostname` 的那一刻，这里读出来是 `undefined`，症状是"连不上本机宿主，但发现文件明明在那儿"。

**影响面**：会漂（症状出现得晚、定位难）。

**建议**：`LocalHostFacts` 直接 `import type { HostFileInfo } from "@ai-zen/agents-host"` 并 `Pick<…, "pid"|"host"|"port">`；路径复用宿主导出的常量。

**置信度**：确证。

**需人拍**：否（类型层改动，无运行期影响）。

---

## 查过但没问题

1. **`cli/src/server-client/index.ts` 整文件 `export * from "@ai-zen/agents-client"`** —— 看着像"只转一手的空壳绑定层"，其实有两件实质内容：进程身份 `CLIENT_INFO`，以及一条门禁（`package.json` 的 `check:imports` 用 `--forbid @ai-zen/agents-client` 强制 CLI 其它模块只能从这里取连接层）。它存在的理由是"CLI 到底向连接层要了哪些东西能在一屏里读完"，且被机械校验，不是绕路。
2. **`handlers/index.ts` 的 `BRIDGED_METHODS` 只有用例在读** —— 不是死代码：它是「handler 表可以缺哪四个方法」的声明，而 `net/WsHub.ts:586-604` 确实在分发时先处理 `host.setLanguage` / `asset.begin` / `asset.end`（`host.hello` 走 `HELLO_METHOD`，`WsHub.ts:203`）。用例用它做全覆盖断言（每个契约方法要么在表里、要么在名单里），这条断言防的是真实回归（加了契约忘了实现 → 客户端拿到 `unsupported`）。
3. **`cli/src/agent-switch.ts:53` 的 `agent.modelId ?? config.defaults.defaultModel`** —— 初看像"客户端又自己算了一遍 F-B1 三级链"，实际只在选择器里回答「这个助手会用哪个模型」这一句展示文字；可用性判断取的是宿主的 `available` / `unavailableReason`，而三级链里"会话级"那一层在这里本来就不适用（选的是助手，不是会话）。文件头注释与代码一致，没有假注释。
4. **`host/src/storage/dbWorker.ts` 的 worker 线程** —— 不是"为了绕过限制而加的中间状态"：`node:sqlite` 只有同步 API（`DatabaseSync`），主线程上跑会卡住整台宿主的事件循环（多连接同时在线时是全局卡顿）。这一层是有明确物理理由的。
5. **`conversation.state` 的 `includeMessages` 开关** —— 看着像"可选参数永远用不到"，实际两端各有真实用法：CLI 全量载入走 `true`（`cli/src/session.ts:871`），桌面端快照走 `true`（`desktop/packages/main/src/host/services.ts:481`），客户端库的重连补拉同时存在两种（`client/src/resume.ts:77` 带、`:85` 不带）。这正是 PRD F-I13 要的"轮询方不为消息付费"。

---

## 需人拍的清单

| 条目 | 要拍什么 | 不拍的后果 |
|---|---|---|
| **1** 能力清单零消费者 | F-E6「这个操作会阻塞」这条属性究竟归谁用、用在哪一屏？若不用，`host.capabilities` 与 `hello.capabilities` 是否可以一起从契约面删掉（动 `MethodMap` + `host` 域的方法数 7 → 6）？ | 63 条事实继续挂在契约上，两端都不读；下一个人读 PRD 会以为"正在执行什么"已经能显示。同时 CLI 那份死掉的 `blocksInput` 也无法收敛。 |
| **2** 状态栏块名 `label` | 状态栏 8 个块名（助手/模型/思考强度/上下文/用量/目录/在跑的工具/子 Agent）是界面词汇还是宿主事实？搬给客户端就要动 `conversation.state` 的 `statusBlocks[].label` 形状。 | 与已修的 252 条同病继续存在：改一个块名要发宿主版；桌面端将来会再造一套中文。 |
| **3** 宿主 34 组无产出 i18n 键 | 这 34 组里哪几条是"功能缺失"（删对话 / 删项目 / 语言切换 / 撞硬线 / 配置保存是否该有通知），哪几条是"文案多余"、哪几条只是用例夹具？ | 删错 → 抹掉一个本该实现的需求线索；不删 → 68 条句子继续误导（且带"项目"这个已被判非法的术语），用例还得继续替 `notice.settingsSaved` 这种死码当夹具。 |
| **5** 20MB / 4 张的份数与真相 | 「上限的真相只在宿主」要不要贯彻到客户端本地预检（CLI 需要从 `hello.limits` / `config.get().limits` 取值，并在 context 里带 limits）？ | 宿主调上限后 CLI 的本地预检与提示文案仍然说旧数，用户看到"提示 20MB，实际被拒"。 |
| **7** PRD 能力号 ↔ 方法名对照表 | 这张"PM 复核用"的对照关系是否继续作为代码资产存在？若留，唯一一份放哪（由 `createCapabilities()` 生成还是手写）。 | 两张表口径继续分叉（今天 `destructive` 10 vs 2），复核者读到的是过期图。 |
| **11** `host.reload` 的 `scope` | 删参数（契约小改），还是给 `/reload` 加子参数让"只重载某一类"真有入口？ | 5 值枚举 + 校验 + `wiz.reload.*` 5 条词条继续为一个不存在的入口服务；用户以为可以只重载 MCP。 |

（另有两条"轻"判决已写在条目里，不单列：**8** 档位名是否由宿主给可本地化清单；**6** `blocksInput` 是"接上"还是"删掉"。）

## 处理状态（2026-11-14 当日收尾）

| 条目 | 状态 | 落点 |
|---|---|---|
| 1 能力清单零消费者 | **半办**：文案已删（`title` / `description` + 252 条 i18n）；清单本体与 `hello.capabilities` 的 id 列表仍在，**要不要从契约面删待拍** | `agents@e685d03` |
| 2 状态栏块名 | ✅ 已办：`label` 删掉，CLI 用 `status.block.<id>` | `agents@a4ed0aa` + `cli@7222228` |
| 3 宿主 34 组无产出 i18n 键 | **待拍**：哪些是"功能缺失的线索"、哪些是多余文案；待拍后一次清 | — |
| 4 假注释 / 假用例名 | ✅ 已办 | `agents@72d625c` |
| 5 上限 4 份定义 | ✅ 已办：会话透出 `hello.limits`，粘贴预检与提示都跟宿主走 | `cli@207204f` |
| 6 CLI 三条只被用例读的导出 + 注释说错 | ✅ 已办（`method` 字段、假注释一起删）；`blocksInput` 仍有真实消费者，保留 | `cli@0f789a0` |
| 7 PRD 能力号 ↔ 方法名两份映射对不上 | **待拍**：留一份（生成）还是都删；用例要不要交叉核对 `destructive` 条数 | — |
| 8 档位名三处维护、`effort.custom` 永远显示不出来 | ✅ 已办（删死词条 + 守卫） | `cli@c468429` |
| 9 CLI 8 组零产出词条 | ✅ 已办（16 条），并加了「每个词条都得有人取」的守卫 | `cli@c468429` / `cli@fde813e` |
| 10 `mode.ts` 说 `run/server.json` | ✅ 已办 | `cli@c468429` |
| 11 `host.reload` 的 `scope` 没人传 | **待拍**：删参数，还是给 `/reload` 加子参数 | — |
| 12 桌面端 hello 解码两份 | ✅ 已办：`helloOf()` 一处 | `desktop@f8b79d0` |
| 13 只被用例续命的导出 | ✅ 已办：host 4 处 / cli 9 处（连用例）/ desktop 1 处 | `cli@fde813e` / `agents@22dcc7d` / `desktop@f8b79d0` |
| 14 连接层重抄 `HostFileInfo` 子集 | ✅ 已办（类型用 `Pick`；路径那一半受 devDependency 边界限制，已在注释里写清） | `agents@22dcc7d` |

剩下的 1 / 3 / 7 / 11 全部是「动契约面或裁定」的，不是删垃圾，需要人拍。
