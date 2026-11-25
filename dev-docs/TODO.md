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

**现在是什么行为**：出题、等答复只有宿主内部一套（`host/src/modules/question/registry.ts` 的 `Question` / `AskInput` / `cancelValue`，交接三选一在用，面板关掉等于选退路）。MCP 的工具调用是纯 request/response（`call_mcp_tool` 一直等到结果回来），服务器中途要一句用户输入没有通道。

**要变成什么行为**：待定 —— 这一条是调研。要回答的问题：

1. spec 里 Elicitation 的形状：表单 schema？跳转链接？超时？用户取消怎么回给服务器？
2. 映射到现有的 `Question`，还是新开一种「MCP 提问」：我们的题默认阻塞（挂着这一段就一直等它）、可带一条显式退路（`cancelValue`），与 elicitation 的语义对不对得上。
3. 「谁在等」这件事要理清：`call_mcp_tool` 中途出题意味着这条调用挂起等用户；它与输出暂停、交接期间的不许出题（`host/src/modules/handoff/service.ts` 那一侧已有判据）怎么相处。
4. 客户端的承载面：TUI 的问题面板现在只画「一句问话 + 若干选项」，多字段表单没有地方放 —— 先只支持单字段，还是等界面？
5. 用户不答时服务器等到什么时候：超时归谁定、超时之后那条工具调用算什么。

**怎么算做完了**：同上的结论落地，然后本条删掉。
