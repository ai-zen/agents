# PRD（索引）

产品需求的唯一来源。本文件只是目录：正文按主题分在 `prd/` 下，一册一件事。

**读法**：先读 `prd/00-frame.md`（需求来源、七条硬规矩、命名）。它是全书的地基，别跳过。
其余各册按需要读：改哪一块，读哪一册。

## 分册

| 册 | 装什么 |
|---|---|
| [`prd/00-frame.md`](prd/00-frame.md) | 需求来源、四部分的划分、七条硬规矩（乱序受理、只有投递禁止等、投递不看关系、状态靠观测……）、命名 |
| [`prd/01-decisions.md`](prd/01-decisions.md) | 一、用户决策（1.1–1.9）：产品形状、生死、交接与平级会话、会话上的字段、项目与命名、配置与语言与通知与问题、入口与客户端、附件、明确不做 |
| [`prd/02-ai-decisions.md`](prd/02-ai-decisions.md) | 二、AI 决策（2.1–2.4）：引擎定型、宿主与客户端接线、产品层的拆法、工程策略。每条写着理由与推翻方式 |
| [`prd/03-legacy.md`](prd/03-legacy.md) | 三、旧版需求（3.1–3.11）：工具面、权限、门外的世界、配置面、附件、交接、两条阈值与中断、两个入口、界面要素、关掉再打开、旧版是反的那几条 |
| [`prd/04-product.md`](prd/04-product.md) | 四之一（4.1–4.4）：三个东西、谁能说话怎么说、结果从哪来、生死（状态四件事、暂停与中断、换模型不是死） |
| [`prd/05-handoff.md`](prd/05-handoff.md) | 四之二（4.5）：交接 —— 原地换人、谁算记忆、谁落库、交接期间输入往哪走、客户端长什么样 |
| [`prd/06-session.md`](prd/06-session.md) | 四之三（4.6–4.8）：平级会话、一段会话能被改的、存量照旧 |
| [`prd/07-changes.md`](prd/07-changes.md) | 四之四（4.11 / 4.13 / 4.14）：与旧版不同的地方（改口清单）、明确不做、待定 |
| [`prd/08-client.md`](prd/08-client.md) | 四之五（4.9 / 4.10 / 4.12）：通知、问题、关掉再打开与入口 |
| [`prd/09-observability.md`](prd/09-observability.md) | 四之六（4.15–4.16）：观测与错误两路、语言与文案 |
| [`prd/10-faq.md`](prd/10-faq.md) | 反复被问的问题与旧编号的去向。不是需求，是刹车片 |

## 不在本文件里的

- **技术怎么实现**：宿主基础设施在 [`trd/host-infrastructure.md`](trd/host-infrastructure.md)，引擎在
  [`trd/engine.md`](trd/engine.md)，运行时活物的创造与观测在 [`trd/live-objects.md`](trd/live-objects.md)。
  目录见 [`TRD.md`](TRD.md)。
- **还差什么、先做哪块**：[`PLAN.md`](PLAN.md)。
- **术语**：[`GLOSSARY.md`](GLOSSARY.md)。一个概念只有一个名字。
