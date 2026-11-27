# MCP

MCP 服务器按需连接：发现阶段只读配置文件，不建立任何连接；模型调用 `load_mcp` 那一刻才连。

## 配置

一份 `mcp.json`，键是 `mcpServers`，里面每一条是一台服务器（id 即键名）：

```json
{
  "mcpServers": {
    "fs-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "env": { "LOG_LEVEL": "warn" },
      "description": "只读地看 /data"
    },
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "X-Team": "infra" }
    },
    "legacy": {
      "type": "sse",
      "url": "https://old.example.com/sse",
      "disabled": true
    }
  }
}
```

| 字段 | 含义 |
|---|---|
| `type` | `stdio` / `http` / `sse`。不写时推断：有 `command` 是 `stdio`，有 `url` 是 `http`。也接受 `transport`、`transportType` 两个别名 |
| `command`、`args`、`env` | `stdio` 传输：子进程的启动命令与环境 |
| `url`、`headers` | `http` / `sse` 传输：地址与请求头 |
| `oauth` | 只在 `http` 传输下有效：`authorizationUrl`、`tokenUrl`、`clientId`、`clientSecret`、`scope` |
| `description` | 呈现给模型的说明，`load_mcp` 的参数描述里会列出来 |
| `disabled` | `true` 即停用。停用的那一条仍然占住这个名字，于是近层的 `disabled` 会取消远层同名定义 |

## 五个文件，五层合并

同名以近的为准，由近及远：

| 层 | 文件 | 宿主可写 |
|---|---|---|
| 项目根 | `<项目>/mcp.json` | 否：那是别的工具的约定文件 |
| 项目宿主目录 | `<项目>/.ai-zen/mcp.json` | 是 |
| 项目共用目录 | `<项目>/.agents/mcp.json` | 否 |
| 用户级 | `<数据根>/mcp.json` | 是 |
| 主目录共用 | `~/.agents/mcp.json` | 否 |

只写这两层，是因为另外三层要么在别人的仓库里、要么在别的工具的目录里。合并按「近层赢」算，每次都重新读文件，不留缓存——这些文件用户随时会手改。

停用、别名、解析失败记日志这些差异都在发现函数里统一处理，宿主那一层只负责回答「哪五个文件」与「哪两层可写」。

## 运行期

MCP 的远端工具不进工具清单。清单里只有五个入口：

| 工具 | 做什么 |
|---|---|
| `load_mcp` | 连接指定服务器，返回它的工具、资源、提示、技能清单。`include_manifest=false` 时只连不取清单 |
| `call_mcp_tool` | 调用那台服务器上的具体工具 |
| `read_mcp_resource` | 读一个资源 uri |
| `get_mcp_task_result` | 取一个长任务的结果 |
| `cancel_mcp_task` | 取消一个长任务 |

`load_mcp` 的服务器名是枚举，来源与权限过滤后的那一份相同：被 `permissions.mcps` 禁掉的服务器不会出现在枚举里，也无法被点名连接。

连接按目录存活：`Scope` 持有连接管理器，同一个工作目录下的所有会话共用一份连接；`dispose()` 时统一断开。建连失败只把原错误抛给调用方，重试策略不在这一层——哪些错误值得重试、隔多久重试，只有调用方知道。

## 长任务

服务器可以声明某个工具的执行方式：`execution.taskSupport` 取 `forbidden`（缺省）、`optional`、`required`。声明了任务支持的工具在调用后可能不立即返回结果，而是给出一个任务 id。

任务到达终态（`completed` / `failed` / `cancelled`）时，一条通知投回发起这次调用的那段会话的队列，正文指向 `get_mcp_task_result`。投递走的是与后台命令同一条路：优先级高，结果在这段会话下一次取件时到达。

投不进去就丢弃并记一行日志：不唤醒、不新建、不留半条——一条服务器推来的通知不该把一段死会话叫起来。

## 服务器反过来问人

`tools/call` 进行中，服务器可以发 `elicitation/create` 要求填一张表。这条请求要落到「发起这次调用的那段会话」上：

- 宿主在会话上装了 `McpElicitationPlugin`，出题之前记一笔账：谁能答题、答在哪一段会话下
- `call_mcp_tool` 在真正发请求之前把当前这一格压进账，回来时弹出
- 没有账时（一次性 agent、`runOnce`、没有题板的调用）一律回 `cancel`：没人做决定，说的就是这个。`decline` 留给用户明确的拒绝

同一批工具调用是并行跑的，两次 `call_mcp_tool` 同时在飞时，账上记的是最后压进去的那一次。同一段会话内的并行不受影响（答题的仍是同一段会话）；跨会话并行才可能记到另一段上。

## 技能扩展

服务器若声明了 MCP Skills 扩展，`load_mcp` 返回的清单里会多一份技能列表。一条技能的身份是服务器加 `uri`，正文仍走 `resources/read`，所以清单里连附属文件的 uri 一起给出——模型在正文里看到一个相对路径时，需要能把它换成可读的 uri。

## 排错

| 现象 | 先看什么 |
|---|---|
| 服务器一条都连不上 | `mcpPaths` 是否为空。路径空着时插件连连接管理器都不建，写了 `mcp.json` 也不会报错 |
| 某个配置文件里的服务器全不见了 | 那个文件解析失败。发现函数会在日志口报一句，不注入日志口就什么都不记 |
| 近层改了却不生效 | 名字被更近的一层占住；或 `autoRefreshTools` 为 `outer-loop-start` / `off`，要等下一次刷新 |
