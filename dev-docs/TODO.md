# 还没做的事

`PLAN.md` 只收两种东西：PRD 里的需求、说得出交付物的专项。这份文件装不下那两样的东西 —— 还没归到需求上的改动、要动手前先讨论一嘴的事。

每条要写清三样：现在是什么行为、要变成什么行为、怎么算做完了。写不全就说明还没想清，别写进来。被做掉、或者变成 `PLAN.md` 的一行之后，从这里删掉，不许长期躺着。

---

## 1.（已收口，别重开）MCP 服务器随工具一起发布技能 — Skills over MCP

**已经做掉的（2026-11-25）**：发现与清单。`McpConnectionManager` 建连时用 SDK 自带的
`SkillsClient`（`@modelcontextprotocol/client/ext/skills`，SEP-2640）问一次 `skills/list` ——
只在服务端声明了那个扩展时才问；条目原样带进 manifest（`uri` / `frontmatter` / 附属文件清单），
`load_mcp` 的清单里就能看到这台服务器有哪些技能、正文在哪个 uri。

**怎么读**：不另加工具 —— 技能正文与附属文件都是 `resources/read`，用现有的
`read_mcp_resource`。

**明确不做的（2026-11-25 用户拍板）**：

1. **不把 MCP 技能并进 `load_skill` 的 id 空间** —— 不考虑。
2. **不做 `load_mcp_skill`** —— 它只省两跳（清单里已经给了每个文件的 uri），而相对路径拼错
   这件事在真机上还没出现过；真出现了再说。
3. **不做 `call_mcp_skill_subagent`** —— 价值是真的（正文很长时隔离上下文），但硬骨头是「只给
   那台服务器的工具」：我们的 MCP 是**一把** `call_mcp_tool` + `server` 参数，不是每台服务器
   一组工具，所以得手工重新实例化一份单 server 的 `call_mcp_tool`（白名单在
   `createCallMcpTool(env, filteredMcps)` 里已经存在），不能拿父的工具实例 filter 一下了事。
   先维持现状：主 agent 读完正文直接用 `call_mcp_tool` 干活。
4. **不做宿主侧的批准与校验**（用户口径：人家有什么就用什么）。SDK 的 `SkillsClient.read()`
   内建校验且失败不给字节，所以我们不走它 —— 直接用 `read_mcp_resource` 读。
   代价记在这里，免得将来当事故查：技能正文是第三方服务器给的，会直接进上下文，没有摘要比对
   也没有人工过目。
5. **不做 `search_tools` 式的工具定义按需加载。** 现在的渐进披露是按组给的（一个 MCP 服务器
   一组、整组一起出现或一起不给），内聚性比「按关键词搜出一把散装工具」好。

## 2.（调研）MCP Elicitation：调用中途问用户

**现在是什么行为**：出题、等答复只有宿主内部一套（`host/src/modules/question/registry.ts` 的
`Question` / `AskInput` / `cancelValue`，交接三选一在用，面板关掉等于选退路）。MCP 的工具调用是
纯 request/response（`call_mcp_tool` 一直等到结果回来），服务器中途要一句用户输入没有通道。

### 调研结果（2026-11-25，spec 2026-07-28 + 已装的 `@modelcontextprotocol/client@2.4.0`）

**它是协议本身的一部分（不是扩展）**，两种模式：

- **form**：`message` + `requestedSchema`（**扁平对象**；属性只能是 string / number(integer) /
  boolean / 单选 enum，数组只能是多选 enum；字符串可带 `format: email|uri|date|date-time`，
  每格可带 title / description / default）。
- **url**：给一个外部链接，敏感信息不进客户端（spec 明确：表单不许问密码/API key/令牌/支付凭证）。
- 答复三态：`{ action: "accept" | "decline" | "cancel", content? }`（accept 带数据；decline 是
  显式拒绝；cancel 是关掉面板 / 按 Esc / 页面打不开）。

**最关键的一条（好消息）**：2026-07-28 era 里服务器不是“推一条服务端请求”，而是让
`tools/call` 回一个 `InputRequiredResult`（`resultType: "input_required"`）；**SDK 默认会自动
履行** —— 它拿我们通过 `setRequestHandler(ElicitRequestSchema, …)` 注册的处理器收集答案，
再用 `inputResponses` + 原样的 `requestState` 重发那次调用（`inputRequired.autoFulfill`，
最多 `maxRounds` 轮），`client.callTool()` 依然只返回普通结果。

所以**不需要在 `call_mcp_tool` 里写重试胶水**；capability 那格也不用自己往每个请求塞
`_meta`（现代 era 下 SDK 自动附带）。真正要做的只有三件：

1. `Client` 构造时声明 `capabilities: { elicitation: { form: {} } }`（只声明 form；没声明的模式
   服务器不该发）；
2. 注册 `elicitation/create` 的处理器，把它翻译成宿主的一道题；
3. 面板能画表单。

**真正的硬骨头：我们的 MCP 客户端是按 Scope 共享的，而题必须挂在某一段会话下。**
`setRequestHandler` 的处理器拿不到 `ToolCallContext`（不知道是哪个 agent / 哪段会话调的）——
得由 `McpTaskBridge` 那一层在发起调用时记一份“当前这次调用属于谁”，处理器再去取。
这是这一条里唯一需要设计的地方。

**与现有 `Question` 的对齐**：三态几乎一一对应 —— `accept` → 带一个值作答；`decline` → 选“不同意”
那一项；`cancel` → 面板关掉（我们那边是「不作答，题继续挂着」，正好是 spec 的 cancel）。
`cancelValue` 那格可以指向“拒绝”，于是 Esc 与 decline 在体验上合一。

**对不上的地方**：`Question` 是「一句话 + 若干单选」，而 form 是「扁平 schema + 多字段」。
单选 enum 那一种可以 1:1 映射；string / number / boolean / 多选 enum 需要面板支持输入字段 ——
目前 TUI 的问题面板只画选项。

**其它已知边界**：

- **一次性 Agent**（子 agent、`runOnce`、`/ask` 那条）手上没有出题通道 —— 它们调 MCP 工具时
  遇到 elicitation 只能 decline。
- **url 模式空白**：TUI 没有浏览器，也没有“显示域名 + 征求同意 + 打开”的先例（`mcp-oauth` 只是
  凭据目录，没有授权流）。先不声明 url，服务器就不该发。
- **交接期间不许出题**、输出暂停这些既有判据得在处理器里再过一遍（那一侧已有现成的判据）。
- **超时**：spec 没给客户端定数；用户不答（cancel）之后服务器怎么回是它的事，我们只负责把
  cancel 交回去。

### 三档做法

| 档 | 内容 | 代价 |
|---|---|---|
| 甲（先做这个） | 只 form、**先只支持单选 enum 那一种**（直接当一道 `Question`）+ “谁在调”的上下文 | 一次能力声明 + 一个处理器 + `McpTaskBridge` 里记一份调用上下文 |
| 乙 | form 全量（字符/数字/布尔/多选） | 要新做 TUI 的多字段表单 |
| 丙 | url 模式 | 要新做“显示域名 + 同意 + 打开浏览器”的交互形状 |

**未决**：要不要做、做到哪一档；甲里的“调用上下文”放在 `McpTaskBridge` 还是另起一层。
