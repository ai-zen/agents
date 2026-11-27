# 技能

技能是写给模型的一份指导文档。和工具不同，它不是可调用的函数，而是一段在需要时才读进上下文的流程说明。

## 一个技能是什么

```
skills/
└── handoff/
    ├── SKILL.md
    └── references/
        └── template.md
```

一个技能是一个目录，目录名就是它的 id，里面必须有 `SKILL.md`，可以有任意附属文件。模型拿到的是两份东西：`SKILL.md` 的正文，以及这个目录里有哪些文件。

## frontmatter

`SKILL.md` 开头是一段 YAML：

```markdown
---
name: handoff
description: Write a task handoff document — when you stop work and leave the session…
license: MIT
compatibility: 需要 read 与 write 工具
sub-agent: true
metadata:
  custom: "false"
---

# Handoff Document Writing Standard
…
```

| 字段 | 规则 |
|---|---|
| `name` | 必填。小写字母、数字与连字符，不能以连字符开头或结尾、不能有连续连字符，最长 64 字符，且必须与目录名一致 |
| `description` | 必填，最长 1024 字符。它会出现在 `load_skill` 的参数描述里，模型靠它决定读哪一个 |
| `license` | 可选 |
| `compatibility` | 可选，最长 500 字符 |
| `sub-agent` | 写 `true` 时这个技能可以在子代理模式下运行，见下文 |
| `metadata` | 可选，一组键值对。出厂技能用它标 `custom: "true"` 表示「用户自有，不要覆盖我」 |

没有 `name` 的文件不会被当成技能：发现时直接跳过。校验不合规（名字太长、与目录名不一致、`description` 为空等）只往日志口写一行，技能照样收录——校验是为了告诉人哪里写错了，不是准入。

## 放在哪

与工具、子代理共用同一套四层目录，同名以近的为准：

1. `<项目>/.ai-zen/skills`
2. `<项目>/.agents/skills`
3. `<数据根>/skills`
4. `~/.agents/skills`

`.ai-zen/skills` 排在最前：这个目录属于本运行时，同名时以它为准。

## 模型怎么用

技能不占工具清单的位置。清单里只有两个入口：

| 工具 | 什么时候用 |
|---|---|
| `load_skill` | 要按某个流程做事：读该技能的正文、目录绝对路径、目录内文件清单 |
| `call_skill_sub_agent` | 让技能以自己的上下文执行整件事（只对 `sub-agent: true` 的技能出现） |

`load_skill` 的参数是技能 id 的枚举，被权限过滤掉的技能不会出现在枚举里；点名一个不在名单里的 id 会返回「不可用」，而不是加载它。返回内容包含目录路径与文件清单，所以正文里写「读取 references/template.md」时，模型知道该去哪个目录读。

## 子代理模式

`sub-agent: true` 的技能可以整件事委派出去：

1. 造一个一次性 agent，system 消息是技能正文，user 消息是这次的任务描述
2. 工具沿用父手上的那些，但剔掉三样：`call_skill_sub_agent` 自身（防自递归）、PeerSession 的三个工具、`async_exec` 与 `async_timeout`——最后两个的结果要在将来某个时刻投回来，而这时那个一次性 agent 已经结束，没有人收
3. 父的中断信号直接传给它的 `runOnce`；事件转发、用量记账与其它委派一样

父模型只收到最后一条消息的内容。

## 出厂技能

`bootstrap()` 会把 `handoff` 技能释放到 `<数据根>/skills/handoff/SKILL.md`。交接文档的九节格式与写作规则都在那一份里。

它受出厂同步管理：`metadata.custom` 不是 `"true"` 时，每次 `bootstrap()` 都用当前版本覆盖它。自己改的版本想留住，就把那一格改成 `"true"`。

磁盘上读不到这份技能时，写交接文档会退回内置的兜底模板——保险丝，不是第二真相源。

## 权限

技能的可用范围由 agent 定义里的 `permissions.skills` 决定：

```json
"permissions": { "skills": { "deny": ["handoff"] } }
```

两个入口都再查一次名单：`load_skill` 与 `call_skill_sub_agent` 拿到的是过滤后的集合，点名被禁的技能会失败。

## 生效时机

新放进去的目录在发现之后才可见：

- 直接用 SDK 时调用 `scope.refresh()`
- 宿主里由 `config.json` 的 `autoRefreshTools` 决定（每次请求前 / 每批开头 / 只靠 `/reload`）

## 写一个自己的技能

```
<项目>/.agents/skills/release-notes/SKILL.md
```

```markdown
---
name: release-notes
description: 把这一批提交整理成给用户看的更新说明。当用户要求「写更新日志」时使用。
---

# 更新说明的写法

1. 用 `exec` 跑 `git log --oneline <上一个标签>..HEAD`，拿到这一批提交。
2. 按「新增 / 修复 / 内部」三类归并，同一件事的多条提交合成一条。
3. 只写用户能感知的变化；重构、测试、依赖升级归到「内部」一行带过。
4. 输出中文，每条一句话，不加小标题以外的层级。
```

放好之后刷新一次，模型就会在遇到「写更新日志」这类请求时自己 `load_skill` 读它。
