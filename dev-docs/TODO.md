# 还没做的事

`PLAN.md` 只收两种东西：PRD 里的需求、说得出交付物的专项。这份文件装不下那两样的东西 —— 还没归到需求上的改动、要动手前先讨论一嘴的事。

每条要写清三样：现在是什么行为、要变成什么行为、怎么算做完了。写不全就说明还没想清，别写进来。被做掉、或者变成 `PLAN.md` 的一行之后，从这里删掉，不许长期躺着。

---

## 1.（调研）MCP 服务器随工具一起发布技能 — Skills over MCP

**现在是什么行为**：技能只从磁盘发现。`scope/plugins/skills/discover.ts` 扫 `SKILL.md`（frontmatter + 正文），`SkillsScopePlugin` 把它们变成 `load_skill` 与 `call_skill_sub_agent` 两件工具，披露口径是「枚举值放参数里、正文按需读」（`scope/disclosure.ts` 的 `createDisclosureParam`）。MCP 那一侧只有 tools 与 resources（`scope/plugins/mcp/mcpTools.ts`：`load_mcp` / `call_mcp_tool` / `read_mcp_resource` / 两条任务工具），**没有任何一条路是「服务器把一段使用说明交给我」**。

**要变成什么行为**：待定 —— 这一条是调研。要回答的问题：

1. spec 里 Skills over MCP 的承载形态是什么（resource 的一种约定？新增 capability？还是工具名约定），先读 spec 再谈实现。
2. 形状能不能对上：本地技能是 `SkillInfo` + `readSkill`（id / description / subAgent 开关 / 正文），MCP 那份能不能填进同一个形状，还是只能另开一条平行通道。
3. 披露时机与口径：和本地技能共用「枚举按需 + 正文按需」这一套，还是 MCP 的清单另算一档。
4. 权限归谁：`Scope.filter` 里 `permissions.skills` 与 `permissions.mcps` 是两套白名单，MCP 来的技能算哪一套。
5. 要不要给 `subAgent: true` 那条能力（`skills/skillTools.ts` 会派一个一次性 Agent 出去干活）。

**怎么算做完了**：一份结论落进 `PRD.md` 或 `PLAN.md` —— 做的话写清分几步、每步交付什么；不做的话写清理由 —— 然后本条从这份文件删掉。

**相邻的一条已被否掉的路**：`search_tools` 式的**工具定义**按需加载不做。现在的渐进披露是按组给的（一个 MCP 服务器一组、整组一起出现或一起不给），内聚性比「按关键词搜出一把散装工具」好；2026-11-25 用户拍板，不要往回调。

## 2.（调研）MCP Elicitation：调用中途问用户

**现在是什么行为**：出题、等答复只有宿主内部一套（`host/src/modules/question/registry.ts` 的 `Question` / `AskInput` / `cancelValue`，交接三选一在用，面板关掉等于选退路）。MCP 的工具调用是纯 request/response（`call_mcp_tool` 一直等到结果回来），服务器中途要一句用户输入没有通道。

**要变成什么行为**：待定 —— 这一条是调研。要回答的问题：

1. spec 里 Elicitation 的形状：表单 schema？跳转链接？超时？用户取消怎么回给服务器？
2. 映射到现有的 `Question`，还是新开一种「MCP 提问」：我们的题默认阻塞（挂着这一段就一直等它）、可带一条显式退路（`cancelValue`），与 elicitation 的语义对不对得上。
3. 「谁在等」这件事要理清：`call_mcp_tool` 中途出题意味着这条调用挂起等用户；它与输出暂停、交接期间的不许出题（`host/src/modules/handoff/service.ts` 那一侧已有判据）怎么相处。
4. 客户端的承载面：TUI 的问题面板现在只画「一句问话 + 若干选项」，多字段表单没有地方放 —— 先只支持单字段，还是等界面？
5. 用户不答时服务器等到什么时候：超时归谁定、超时之后那条工具调用算什么。

**怎么算做完了**：同上的结论落地，然后本条删掉。
