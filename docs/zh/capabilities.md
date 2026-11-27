# 能力

一个 agent 能用什么，由两件事决定：目录里有哪些文件（能力），以及 `permissions` 允许哪些（权限）。前者是数据，后者是配置，都不需要改代码。

四类能力的单位与存放位置：

| 能力 | 一个单位是什么 | 文件名 |
|---|---|---|
| 工具 | 一个 ES 模块，导出一个工具对象 | `tools/<name>.js` 或 `.mjs` |
| 技能 | 一个目录，`SKILL.md` 加附属文件 | `skills/<id>/SKILL.md` |
| 子代理 | 一份带 `function` 字段的 agent 定义 | `sub-agents/<id>.json` |
| MCP | 一条服务器定义 | `mcp.json` |

## 目录层次

同名以近的为准。四种能力共用的层次（由近及远）：

1. `<项目>/.ai-zen/skills`
2. `<项目>/.agents/{skills,tools,sub-agents}`
3. `<数据根>/{skills,tools,sub-agents}`
4. `~/.agents/skills`

`.ai-zen` 是这套运行时自己的目录，因此只放技能；另外两类约定目录在 `.agents` 下，与别的工具共用。MCP 的层次另算，见 [MCP](mcp.md)。

近层停用一条、或近层那一份读不出来，处理方式各不相同：工具先占名字再加载，技能与子代理读成功才占。这是各发现函数自己的口径，装配层不抹平。

## 工具

一个工具就是一个文件，导出一个对象。最小的写法只有 `function` 与 `exec`：

```js
// tools/echo.mjs
export default {
  function: {
    name: "echo",
    description: "把输入原样返回",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  async exec(args, ctx) {
    return args.text;
  },
};
```

`exec` 的返回值是给模型的内容：字符串原样，内容块数组（文本、图片、文件）按段返回，其他值序列化成 JSON。

三种导出形状都接受：`Tool` 实例、默认导出的上述对象，或具名的 `{ function, exec }` / `{ function, callback }`。

文件是被 `import()` 求值的，求值即执行代码。因此加载时有三条约束：

- `process.exit()` 与 `process.abort()` 换成异常，不会杀掉宿主
- `console.log` / `info` / `debug` 改指 stderr，不污染交互界面
- 单个文件超过 5 秒未加载完成就放弃

挡不住的是顶层同步死循环与 `process.kill(process.pid)` 这类直接结束进程的调用。要那种隔离，用 MCP。

## 技能

一个技能是一份写给模型的指导文档，加可选的附属文件：

```markdown
---
name: handoff
description: Write a task handoff document — when you stop work and leave the session…
---

# Handoff Document Writing Standard
…
```

- `name` 与 `description` 从 frontmatter 读取；`id` 是目录名
- 正文不常驻上下文：只在 `load_skill` 那一刻展开，同时返回技能目录的绝对路径与文件清单，模型据此读取附属文件
- frontmatter 里标了 `sub-agent: true` 的技能，可以在子代理模式下运行（`call_skill_sub_agent`）：该技能自带一份上下文去执行，父只收到结果

出厂会释放一份 `handoff` 技能到 `<数据根>/skills/handoff/`，交接文档的九节格式与写作规则就在里面，可以直接改。

完整的字段规则、校验、子代理模式与例子见[技能](skills.md)。

## 子代理

带 `function` 字段的 agent 定义会成为父手上的一把工具。字段、模板注入、事件转发与用量记账见 [Agent 的子代理一节](agent.md#子代理)。

## 权限

`permissions` 分四维，每维写 `allow` 或 `deny` 其中一种：

```json
"permissions": {
  "tools": { "deny": ["rm", "exec"] },
  "skills": { "allow": ["*"] },
  "mcps": { "allow": ["fs-server"] },
  "subagents": { "allow": [] }
}
```

- 支持 `*`；同一维写 `allow` 与 `deny` 两格会直接报错
- 某一维整维不写，等于这一维全部禁用
- 名单之外的名称不会出现在模型的工具清单里。模型看不到它，也就不会调用它——不是等调用发生之后再拒绝
- 技能、MCP、子代理的加载入口自己也再查一次名单：`load_skill` 点名一个被禁的技能会返回「不可用」，而不是靠枚举没列出来挡住

两个维度之外还有一层「这一段手上不该有什么」，由装配方决定，不看定义文件：一次性 agent 没有 `post_message` 一类会话工具与两个后台工具；被别的会话开出来的那一段没有 `create_session`。

## 渐进式披露

技能本来就是渐进式披露：工具清单里只放一个 `load_skill`，正文在模型用到的那一刻才读进上下文。这里把同一套做法延伸到另外两类能力——MCP 服务器与子代理——入口同样只有一把。

工具清单每次请求都要发送一遍，装多少能力，清单就有多长。所以这三类能力都不把内容放进清单，只放一个入口：

| 入口 | 何时才读进上下文 |
|---|---|
| `load_skill` | 需要按某个流程执行时，读取那一个技能的正文、目录路径与文件清单 |
| `call_skill_sub_agent` | 需要那个技能以自己的上下文执行时 |
| `load_mcp` | 需要连接某台服务器时，建立连接并取回它的工具、资源、提示与技能清单 |
| `call_mcp_tool` | 调用该服务器上的具体工具 |
| `read_mcp_resource` · `get_mcp_task_result` | 读资源、取长任务的结果 |
| 每个子代理自己的入口 | 委派任务时由子代理自己那份上下文执行 |

无论配了多少台 MCP 服务器、多少个技能，工具清单的长度不变。候选名是枚举，模型从清单中选取，不需要猜名字；一个候选都没有时，参数退化为自由文本，描述里会说明。

## 生效时机

改动目录里的文件之后：

- 直接用 SDK 时，调用 `scope.refresh()` 重新取配置并重新发现
- 宿主里由 `config.json` 的 `autoRefreshTools` 决定：

| 取值 | 时机 |
|---|---|
| `inner-loop-start`（缺省） | 每次请求之前。每个工具回合都能看见新装的能力 |
| `outer-loop-start` | 每批事件开头。要等下一次被叫起来才生效，开销最小 |
| `off` | 不自动刷新，只靠 `/reload` |

`refresh()` 会重新取一份配置再让各插件重新发现，不重建 `Scope`，因此在跑的那一次请求不会被抽掉能力。

## 内置工具

22 个，随 `Scope` 实例化，不需要配置：

| 分组 | 工具 |
|---|---|
| 目录与文件 | `cwd`、`ls`、`exist`、`read`、`inspect_file`、`write`、`edit`、`batch_edit`、`find_text`、`glob`、`mkdir`、`rm`、`rename`、`copy`、`download_file` |
| 命令 | `exec`、`spawn`、`sleep`、`async_exec`、`async_timeout` |
| 图片 | `generate_image`、`view_image` |

工具输出超过 `maxToolOutput`（缺省 32768 字符）时，超长的那一段不整段进上下文：`exec` 这类工具把全文落盘，返回头尾预览与文件路径。

要替换某个内置工具，注册自己的工具插件并在候选集里用同一个名字：装配时同名以后注册的插件为准，`allInOne` 里用户工具排在 `builtin` 之后，因此用户工具可以覆盖内置工具。
