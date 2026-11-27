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

## 2.（已收口）MCP Elicitation：调用中途问用户

**做掉了（2026-11-25）**：题整体换成表单（形状照抄 spec 的 `requestedSchema`，作答三态），MCP 那侧接上了：

- 建连声明 `capabilities.elicitation.form`；注册 `elicitation/create` 处理器（`McpConnectionManager`）。
- 「这次调属于哪段会话」那本账在 `scope/plugins/mcp/elicitation.ts`，`call_mcp_tool` 压栈、处理器读栈顶。
- 宿主按会话装 `McpElicitationPlugin`，`ask` 直接落到 `QuestionRegistry` —— 与交接那道题同一张题板。

**已知的两道口子（写在这里，免得当 bug 查）**：

1. **`url` 模式没做**（也没声明）：要「显示域名 + 征得同意 + 打开浏览器」，TUI 没那个交互面。服务器就不该发。
2. **跨会话不过并行**：MCP 客户端按工作目录共享，并行调用时栈顶是最近那一次，没有任何客户端可见的信息能把它们分开（同段会话内的并行不受影响）。

**补上的一轮（2026-11-27）：新版协议的两种问法都通了，并有真服务器可跑**。

- 建连默认做版本谈判（`versionNegotiation: { mode: "auto" }`，`sse` 除外：那一代传输不会谈成新版，
  而 HTTP 上探针不应答算连接超时）。2026-07-28 谈成之后，服务器改用「回 `input_required`、客户端带
  `inputResponses` 重发」的多轮问法。
- 两套问法落同一个函数（`McpConnectionManager` 的 `fulfilElicitation`）：2025 那一档它被当作请求处理器
  直接调；2026 那一档由任务会话的多轮循环接手，经 `McpTaskBridge` 的 `elicit` 参数调回来。
  不能让 SDK 自己履行那几轮 —— `@modelcontextprotocol/ext-tasks` 发 `tools/call` 时带 `allowInputRequired`，
  自动履行因此是关的。
- 测试服务器：`packages/test-project/mcp-servers/elicit-server.mjs`（`--era modern|legacy`），
  端到端用例 `packages/sdk/test/e2e-elicitation.test.ts`（`npm run test:e2e`）。
- 一个事实值得记：官方 `@modelcontextprotocol/server@2.4.0` 对 `server/discover` 回 Method not found，
  也就是说用它搭出来的服务器永远停在 2025 那一档；新版那一档的线上形状只能手写（测试服务器就是这么来的）。
