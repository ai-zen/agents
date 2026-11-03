# @ai-zen/agents-sdk 代码 review 台账

> 版本：2026-11-03（review 当日）
> 范围：`packages/sdk` 全量（8.1k 行生产代码 + 57 个测试文件）+ 关联 `packages/core`；跨仓影响记录到 CLI
> 方法：8 个并行 subagent 分区审查 → 汇总人逐条复核关键结论（读源码 + 跑探针）→ 与维护者逐条定性 → 本文档
> 状态：**7 个阶段全部执行完毕**（2026-11-03），收紧后的验收标准已达成；各阶段提交与偏差见「六、执行结果」

---

## 一、通用判据（定性时遵循）

| 判据 | 结论 |
|---|---|
| 模型不是攻击者 | 「防刻意触发 / 病态输入」类问题一律不修 |
| 工具层不承担安全边界 | 任意路径读写删、出网到任意主机属 agent 正当能力（等价能力可由 `exec` 获得），不做工具级拦截 |
| 工具返回错误文本 | 合法行为。参数解析错误（`ctx.parseError`）才是特例 |
| 只看"正常用法会不会踩到" | 正常操作序列、正常环境（磁盘满、并发、多会话、配置写错）会踩到的，算缺陷 |
| 声明一致性 | SDK 自己声明了语义却未兑现（如 `permissions`、`isSuspended`），算功能 bug，不适用"exec 也能做"的类推 |

---

## 二、逐条台账

### 保留并修复（14 条）

| # | 问题 | 位置 | 原始严重级 | 定性 | 决定 |
|---|---|---|---|---|---|
| 1 | `edit` 传 `oldText: ""` 同步死循环，进程冻结不可中断 | `builtin/EditTool.ts:6-17,72` | P0 | **bug：替换 API 用错** | 改回调式 replacer；空串单独拒绝；`batch_edit` 同批处理 |
| 1b | 同处：`content.replace(old, new)` 把 `newText` 里的 `$&`/`$$`/`` $` ``/`$'` 当替换模式，**静默改坏文件内容** | `EditTool.ts:82-83`、`BatchEditTool.ts:82-86` | P0 | 同上（同一根因） | 回调式 replacer 天然免疫 |
| 4 | `batch_edit` 替换作用在上一条结果上；失败原因文案误导；`replacedCount` 口径与 `edit` 不一致 | `BatchEditTool.ts:71-86` | P1 | 级联=既定语义；文案与计数是缺陷 | 保持级联 + 描述说明 + 修正原因文案 + 统一为实际替换次数 |
| 6 | `download_file` 被 abort 时删掉**调用前已存在**的文件 | `DownloadFileTool.ts:43-53,78-87` | P0 | **bug：静默数据丢失，且清理逻辑在当前设计下不必要** | 删除该清理分支 |
| 7 | `download_file` 全量 `arrayBuffer()` 无上限、无时限 | `DownloadFileTool.ts:58-66` | P1 | 健壮性 | 改流式写盘（不设上限、不做内部超时）；**新增必填 `timeout` 参数**（与 `exec` 一致） |
| 9a | `exec` 命令成功时 `exitCode` 恒为 `null` | `ExecTool.ts:80` | — | **bug**（模型会误判命令未正常结束） | `error ? (error.code ?? 1) : 0` |
| 9b/9d | `exec` 超时只杀 shell，孙进程成孤儿；`sleep 45 &` 可当常驻进程绕过 `spawn` | `ExecTool.ts:80,93` | P1 | **bug**（正常命令也会起子进程） | `detached: true` + `process.kill(-pid)` 杀进程组；Windows 回退 `child.kill()` |
| 9c | `maxBuffer` 未设 → 1MB 处静默截断，`exitCode` 变字符串错误码，文案谎称"完整内容已落盘" | `ExecTool.ts:80` | P1 | **bug**（谎报） | 显式设 `maxBuffer`；超限文案如实说明已截断 |
| 10 | `spawn` 的 `exit` 监听器被 `removeAllListeners()` 摘掉 → 快速失败一律报 `success: true` | `SpawnTool.ts:78-113` | P1 | 假成功 | **只改文案**：`success` → `started`，明确"不跟踪退出状态" |
| 11 | `glob` / `find_text` 对不存在/非目录路径静默返回 `[]` | `GlobTool.ts:46-58`、`FindTextTool.ts:112-115` | P1 | **bug**（模型据此得出"文件不存在"的错误结论） | 基目录 `stat`：不存在→报错，非目录→报错；`exclude` 用描述说明 |
| 13 | `generate_image` 丢弃 `b64_json` 仍返回 `success: true, images: []` | `GenerateImageTool.ts:145-161` | P0 | **bug**（换图片模型即踩） | `success` 按有无图判定；`b64_json` 落盘返回本地路径 |
| 15 | `load_skill` / `call_skill_sub_agent` 不校验 `filteredSkills`，被 deny 的技能仍可加载（顺带 `../` 可越界） | `skills/skillTools.ts:51-60`、`skills/discover.ts:97-111` | P0 | **声明未兑现**（违反权限模型「无命中=拒绝」） | 回调校验 `skill_id ∈ filteredSkills` |
| 16 | `call_mcp_tool` / `read_mcp_resource` 不校验 `filteredMcps`，任一 agent 连上的 server 对全 Scope 敞开 | `mcp/McpScopePlugin.ts:50-68`、`mcp/mcpTools.ts:337-345` | P0 | 同上 | 两个工具接收过滤后的 server 白名单并在回调校验 |
| 18 | `send()` 返回钩子执行前的消息快照，`onAfterSend` 里迁移替换 `messages` 后返回值已过期 | core `Agent.ts:738-744` | P0 | **core 时序缺陷**（core 注释明写 `onAfterSend` 可做迁移） | `await run(); await hooks; return this.messages;`（`run()` 的唯一出口本就是 `this.messages`） |
| 19 | 交接文件名只到秒且 `conversationId` 后缀全 SDK 无人传 | `HandoffService.ts:231-237` | P0 | 死代码 + 罕见碰撞 | **删除后缀逻辑**，不做碰撞兜底 |
| 20a | `migrate()` 在 `definition.messages` 缺失时抛原生 TypeError，且发生在交接回合已跑完之后 | `HandoffService.ts:341,343` | P1 | 边界但报错不可行动 | `definition.messages ?? []` |
| 20b | `lastUsage` 与消息上的 `usage` 是同一事实的两份拷贝，迁移后前者过期 → 护栏误杀新会话 | core `Agent.ts:138,431-433`；sdk `ContextGuardPlugin.ts`、`AutoMigratePlugin.ts`、`HandoffService.ts:533` | P1 | **冗余状态设计缺陷** | **删除 `lastUsage` 字段**，改为**只读派生 getter**（最近一条未 `omit` 且带 `usage` 的 assistant 消息），禁止写入；交接回合的放宽改由 `ContextGuardPlugin.isSuspended` 表达 |
| 22a | 建连过程中 `disconnect()`/`dispose()` → 连接复活、stdio 子进程无人关闭 | `mcp/McpConnectionManager.ts:303-329,247-256` | P0 | **bug**（启动即退出是正常序列） | `doConnect` 结尾检查 `cancelled`，是则关闭资源并放弃写入 |
| 22b | 运行期断线后状态永远 `connected`，`load_mcp` 返回过期清单 | `McpConnectionManager.ts`（无 `onclose/onerror`） | P1 | 功能缺口 | **只做断线检测**（标记 `disconnected` + 日志），不做自动重连 |
| 22c | 无建连超时，SSE 配置错误时 `load_mcp` 永久挂起 | `McpConnectionManager.ts:191` | P1 | **bug** | `start()` 加超时，与现有 60s 请求超时对齐 |
| 23a | 测试代码不参与类型检查，实测 **211 个类型错误**（含 `defaultModel` 已删、`maxTokens`→`handoffTokens` 已改名的真实漂移） | `tsconfig.json:18`、`package.json:22` | — | 工程门禁缺失 | 新增 `tsconfig.test.json`，`pretest` 跑两份，清光错误 |
| 23b | 默认 `npm test` 收进 e2e（依赖仓库外夹具 / 真实 API / 本机 9876），干净 clone 上结果取决于环境；`prepublishOnly` 挂在这条命令上 | `vitest.config.ts:16` | — | 工程门禁缺失 | 对齐 CLI：三命令拆分，默认套件只留 `src/**` + `integration` |
| 23c | `vitest.e2e.config.ts` 漏登记 `test/e2e-mcp-servers.test.ts` | `vitest.e2e.config.ts:8-12` | — | 同上 | 改 `test/e2e-*.test.ts` 通配 |
| 24 | 文档漂移 8 处（`maxTokens`/`ratio`/`maxContextTokens` 三套旧词、`isSuspended` 未实现、`content-blocks` 未收录等） | README×2、`docs/sdk-design-v1.md`、`types/index.ts:93` | — | 文档问题 | **最后统一对齐**，不随代码逐条改 |

### 撤销 / 不管（14 条）

| # | 问题 | 撤销理由 |
|---|---|---|
| 2 | `find_text` 正则 ReDoS（29 字节输入可卡死 30s+） | 不兜底刻意触发；已接受代价：冻结、`signal` 无效、只能杀进程 |
| 3 | `write`/`edit`/`batch_edit` 非原子写；工具吞异常返回文本 | 写文件不在乎；返回错误文本是合法行为，`allowJsonParseError` 的特例点是 `ctx.parseError` |
| 5 | 并行 `edit` 同一文件丢更新（实测 3/3 复现） | 提示词已覆盖；写前校验实测只能拦 1/20（同进程并发必然漏），串行化不值得 |
| 8 | `read` 不判 `isFile`（`/dev/zero`、FIFO） | 防刻意/病态输入 |
| 12 | `outputGuard` 落盘目录永不清理、权限 0664/0775 | 清理已写明依赖系统临时目录策略；同机多用户不设防 |
| 14 | 上传缓存 key 只含 `endpoint.id`（跨端点串 `file_id`）、FIFO 非 LRU、无 TTL | 需同进程出现两份 `AppConfig`，属刻意构造（配置不热重载，`AppConfig` 应用级单份） |
| 17 | 跨维度同名：subagent 叫 `exec` 顶掉内置 `exec` | 覆盖是既定机制（`allInOne` 注释写明优先级），用户自写文件造成 |
| 21 | 配置层：`config.json` 0644 明文 key、损坏被静默吞、并发写互相破坏 | 不管 |
| — | fs 工具路径穿越、`rm {path:""}` 删 cwd、`download_file` SSRF、任意写⇒RCE | 工具层不承担安全边界（等价能力由 `exec` 提供） |
| — | `call_skill_sub_agent` 继承父 Agent 工具集 | 设计文档 §4「隔离」明写为有意的不对称，且父工具集已过滤 |

---

## 三、关键实测数据（存档）

| 场景 | 数据 |
|---|---|
| `edit` 空 `oldText` | `timeout 3 node` → exit 124，事件循环占满 |
| `$&` 损坏 | `PRICE` + `cost: $& ($$)` → 写入 `cost: PRICE ($)` |
| `find_text` ReDoS | 21B→59ms、25B→112ms、27B→497ms、29B→1829ms；`(\w+\s*)+$` 对 29B 跑 30s 未完 |
| `download_file` abort 误删 | 既有文件 `USER'S IMPORTANT DATA` 在 abort 后消失（本次一字节未写） |
| `download_file` 内存 | 200MB 文件 → RSS 63MB→717MB（峰值增量 654MB，约 3.3×） |
| `download_file` 无时限 | undici 兜底：永不发响应头 → 300.8s 报 `TypeError: fetch failed`；**无总时长上限** |
| `exec` | 成功命令 `exitCode: null`；`sleep 30 \| cat` 超时后残留 PPID=1 的 `sleep 30`；`sleep 45 &` 返回 `killed:false` 且进程存活；3MB 输出 → `exitCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"` 且只拿到 1MB |
| `spawn` | `exit 3` / 命令不存在 / 语法错误 → 5/5 全部 `success: true, "Process started"` |
| `glob`/`find_text` | 不存在路径、非目录路径 → 均返回 `[]`；`ls` 同场景正确抛 `ENOENT` |
| `generate_image` | 仅返回 `b64_json` 的端点 → `{success:true, images:[], note:"…use view_image…"}` |
| `load_skill` | `skills.allow:["public-skill"]` 下 `load_skill("secret-skill")` 返回完整被禁正文 |
| `call_mcp_tool` | `mcps.deny:["*"]` 的 Agent 仍可调用其它 Agent 连上的真实 MCP server（返回 `你好，B！`） |
| `send()` | 迁移插件替换 `messages` 后：返回值 3 条旧历史，`agent.messages` 1 条新会话，`=== ` 为 false |
| 交接文件名 | 同一秒两次 `createHandoffFileName()` → 同名 `20261103-102030.md`；`conversationId` 全 SDK 无调用方 |
| MCP 建连 | 建连中 `disconnect` → 完成后 `state = connected`、`close` 调用 0 次 |
| 测试类型检查 | 纳入测试后 `tsc --noEmit` → **211 errors**（全部在测试文件，生产代码 0 错） |

---

## 四、执行计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| 1. core | #18 `send()` 返回 `this.messages`；#20b `lastUsage` 改只读派生 getter（删字段与写入点） | `packages/core` 全量测试；`lastUsage === 最后一条未 omit assistant 的 usage` |
| 2. SDK 工具层 | #1 #1b #4 #6 #7 #9a-c #10 #11 #13 | 各工具单测 + 新增回归用例 |
| 3. SDK 权限 | #15 #16 | 新增负向用例：deny 的 skill / server 必须取不到 |
| 4. SDK 运行时 | #19 #20a #22a-c；`ContextGuardPlugin.isSuspended`；`HandoffService` 删掉清 `lastUsage` 的那行 | 交接/迁移用例；MCP 生命周期用例 |
| 5. CLI 跟进 | `handoff-service.ts:88` 删赋值；接线补 `isSuspended: () => handoffService.busy` | CLI `npm test` 绿 |
| 6. 工程门禁 | #23a-c：三命令拆分 + `tsconfig.test.json` + 清 211 个类型错误 | `npm run test:all` 全绿；`pretest` 覆盖测试 |
| 7. 文档 | #24 统一对齐（含本次行为变更） | 文档示例可编译 |

## 五、跨仓影响

| 仓库 | 影响 | 处理 |
|---|---|---|
| `packages/core` | `send()` 返回值、`lastUsage` 只读 | 本仓内改（同一 git 根） |
| `packages/sdk` | 主体改动 | 本仓内改 |
| `ai-zen/cli`（本地 `/home/ubuntu/projects/ai-zen/cli`） | `agent.lastUsage = undefined` 赋值会编译报错 / 运行时 `TypeError`；交接回合需 `isSuspended` 才不会被打回 | 阶段 5 跟进 |
| `ai-zen/desktop` | 不写不读 `lastUsage`，无需改 | — |

---

## 六、执行结果

| 阶段 | 提交 | 结果与偏差 |
|---|---|---|
| 1. core | `e5e709b` | `send()` 末尾返回 `this.messages`；`lastUsage` 改为只读派生 getter（删字段与写入点）。SDK 侧同步删除 `HandoffService` 清 `lastUsage` 的那行，并给 `ContextGuardPlugin` 加 `isSuspended`（#20b 的 SDK 半边跟着阶段 1 一起落地，否则 SDK 编译不过） |
| 2. 工具层 | `d88e708` | #1 #1b #4 #6 #7 #9a-c #10 #11 #13 全部落地。过程中发现 `child_process.exec()` 会**忽略 `detached`**（Node 26 实测），故 `exec` 改用 `spawn(shell, detached)` 自收流，超时才能 `kill(-pid)` 回收整组 |
| 3. 权限 | `56a5c08` | skill / MCP server 均按 Scope 白名单校验，负向用例覆盖 deny 场景 |
| 4. 运行时 | `55567c7` | #19 #20a #22a-c。**#19 的台账前提有误**：`conversationId` 并非无人传（SDK 测试与 CLI 都在传），维护者裁定仍按原方案删除（"后缀没有任何意义，而且会话的名称尤其可能乱七八糟"） |
| 5. CLI 跟进 | `1840f0d`（`ai-zen/cli` 仓） | 删除 `agent.lastUsage = undefined`；接线 `isSuspended: () => handoffService.busy`；删除 `conversationId` 传参。验证时需把本地 `agents-{core,sdk}` 临时链接进 CLI（CLI 依赖的是已发布的 alpha.25），**SDK 发布下一个 alpha 后需同步升依赖** |
| 6. 工程门禁 | `6cf8f30` | `tsconfig.test.json` + `pretest`；默认套件收窄；e2e 通配。实测清理 **234** 个测试类型错误（比台账记的 211 多，因为 review 期间又新增了用例） |
| 7. 文档 | 本次提交 | 8 处漂移全部对齐，另补 `shared/content-blocks.ts` 的设计说明与本节行为变更 |
