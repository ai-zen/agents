# TRD（索引）

技术需求与实现规范。与 [`PRD.md`](PRD.md) 的分工只有一条：**PRD 说用户要看见什么，TRD 说这套东西按什么形状搭起来。**

本文件只是目录，正文在 `trd/` 下；包内随代码走的规范在各自的 `packages/*` 里，这里指路。

## 分册

| 册 | 装什么 |
|---|---|
| [`trd/00-layers.md`](trd/00-layers.md) | 包与模块的职责：每个包负责什么、不许做什么、对外四个面、一条判据 |
| [`trd/engine.md`](trd/engine.md) | 引擎（core）：六个动作、外循环与取件、状态两处、事件与钩子、格式化历史、修尾。想知道「agent 到底怎么跑」读它 |
| [`trd/live-objects.md`](trd/live-objects.md) | 运行时活物的四问（创造、观测、持久化、销毁）与五条判据：执行体与能力容器怎么被第三方观察、落库、恢复 |
| [`trd/host-infrastructure.md`](trd/host-infrastructure.md) | 宿主基础设施：数据根、单实例与发现文件、监听地址、端口优先级、凭证与连接校验、升级三段 |

## 随包走的规范

这两份管的是「这个包里的代码长什么样」，所以留在包里，跟着代码一起改：

| 文件 | 管什么 |
|---|---|
| [`packages/host/ARCHITECTURE.md`](../packages/host/ARCHITECTURE.md) | 宿主的结构与八条判据：一个事实一份形状、契约声明一次、按域不按层、活物有唯一所有者、标准问题用标准库 |
| [`packages/host/STYLE.md`](../packages/host/STYLE.md) | 宿主的代码风格：名词、散文、注释、代码构成、函数拆分、文本产出、失败 |

## 不在本文件里的

- **用户要什么**：[`PRD.md`](PRD.md)。
- **还差什么、先做哪块**：[`PLAN.md`](PLAN.md)。
- **术语**：[`GLOSSARY.md`](GLOSSARY.md)。
