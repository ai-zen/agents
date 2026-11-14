/**
 * 能力清单（PRD F-E6 / F-F9，裁定 R6）。
 *
 * 清单是**契约事实**，不是界面文案。一项里只有编号、域、方法名与两条属性：
 *   - **`blocking`**：执行期间会不会占住这段对话（F-E6 让界面显示「正在执行什么」）；
 *   - **`destructive`**：有不可撤销的后果（F-F9 的二次确认）。
 *
 * 「这个能力叫什么、怎么跟用户说」一个字都不在这里 —— 那是界面的活，归客户端（见
 * `CapabilityView` 的注释与 PRD F-E5 的订正）。从前这里还有 `title` / `description`
 * 两条 `LocalizedText`（`capability.*` 126 条文案），唯一消费者是 CLI 的 `/help`；
 * `/help` 改用自己的命令表渲染之后，那些键一并删掉了。
 *
 * 清单必须与契约同步：每一项对应 `MethodMap` 里的一个方法名，编号取 PRD §4 那一行的能力号
 * （`wire/methods.ts` 里每个方法的注释就写着自己的编号）。没有编号的方法用契约注释里记的
 * 决定编号（`workspace.*` 是 `D9`/`D10`/`D11`：PRD §4 当初没给项目单列能力行），不另编一个。
 *
 * 编号撞车的场合（几个方法服务同一条能力，例如 `config.saveEndpoint` / `config.deleteEndpoint`
 * 都属于 F-F2）用 `<编号>#<动作>` 做 id：编号仍是 PRD 的那个，id 保持唯一，客户端可以按 id 存
 * 展开状态。顺序与 `METHOD_NAMES` 一致。
 */

import { methodDomain } from "../wire/index.js";
import type { CapabilityView, MethodName } from "../wire/index.js";

/** 一项能力的固定事实 */
interface CapabilityFact {
  method: MethodName;
  /** PRD §4 的能力编号；项目域那几条用契约注释里记的决定编号 */
  prd: string;
  /** 执行期间占住这段对话（F-E6） */
  blocking: boolean;
  /** 有不可撤销的后果（F-F9） */
  destructive: boolean;
}

/**
 * 清单本体：**每个方法一条**，且与 `METHOD_NAMES` 一一对应（用例会钉住这条）。
 *
 * `blocking` 只标「跑起来时这段对话不能发下一条」的那几个：一轮对话、交接回合、
 * 临时对话（它借的 Scope 与项目共用，跑的时候同样不能被打断）。
 * `destructive` 只标「做下去就回不来」的那几个：删项目 / 删对话 / 撤回 / 删端点 /
 * 删助手 / 删模型（含图片模型）/ 删 MCP 条目 / 恢复出厂。清通知不算：它清的是
 * 界面上的一条提示，为它弹二次确认反而是打扰。
 *
 * 两样东西刻意不在这份清单里（裁定 2026-11-13）：
 *   - `host.usage`：「按项目 / 整机」的用量聚合没有任何客户端消费，F-I5 的落点在
 *     `conversation.state` 的 `usage`；
 *   - `credential.*`：凭据由宿主自己管理（`agents-host token create|list|revoke`），
 *     客户端只有「连接管理 + 记住密码」，那里没有可渲染的能力。
 */
const FACTS: readonly CapabilityFact[] = [
  { method: "host.hello", prd: "F-A1", blocking: false, destructive: false },
  { method: "host.version", prd: "F-E3", blocking: false, destructive: false },
  { method: "host.upgrade", prd: "F-E3", blocking: false, destructive: false },
  { method: "host.shutdown", prd: "F-E1", blocking: false, destructive: false },
  { method: "host.capabilities", prd: "F-E5", blocking: false, destructive: false },
  { method: "host.reload", prd: "F-E1", blocking: false, destructive: false },
  { method: "host.setLanguage", prd: "F-E4", blocking: false, destructive: false },

  { method: "workspace.list", prd: "D9", blocking: false, destructive: false },
  { method: "workspace.create", prd: "D10", blocking: false, destructive: false },
  { method: "workspace.get", prd: "D9", blocking: false, destructive: false },
  { method: "workspace.rename", prd: "D9", blocking: false, destructive: false },
  { method: "workspace.remove", prd: "D11", blocking: false, destructive: true },

  { method: "conversation.list", prd: "F-C5", blocking: false, destructive: false },
  { method: "conversation.create", prd: "F-C7", blocking: false, destructive: false },
  { method: "conversation.get", prd: "F-A6", blocking: false, destructive: false },
  { method: "conversation.state", prd: "F-I3", blocking: false, destructive: false },
  { method: "conversation.rename", prd: "F-C3", blocking: false, destructive: false },
  { method: "conversation.pin", prd: "F-C5", blocking: false, destructive: false },
  { method: "conversation.delete", prd: "F-C10", blocking: false, destructive: true },
  { method: "conversation.send", prd: "F-C2", blocking: true, destructive: false },
  { method: "conversation.abort", prd: "F-E1", blocking: false, destructive: false },
  { method: "conversation.revert", prd: "F-C8", blocking: false, destructive: true },
  { method: "conversation.setModel", prd: "F-B4", blocking: false, destructive: false },
  { method: "conversation.setThinking", prd: "F-B6", blocking: false, destructive: false },
  { method: "conversation.transient", prd: "F-A2", blocking: true, destructive: false },

  { method: "message.list", prd: "F-I7", blocking: false, destructive: false },

  { method: "question.list", prd: "F-I9", blocking: false, destructive: false },
  { method: "question.answer", prd: "F-I9", blocking: false, destructive: false },

  { method: "notice.list", prd: "F-I8", blocking: false, destructive: false },
  { method: "notice.dismiss", prd: "F-I8", blocking: false, destructive: false },
  { method: "notice.clear", prd: "F-I8", blocking: false, destructive: false },

  { method: "config.get", prd: "F-F1", blocking: false, destructive: false },
  { method: "config.patch", prd: "F-F1", blocking: false, destructive: false },
  { method: "config.setDefaults", prd: "F-F7", blocking: false, destructive: false },
  { method: "config.getDiscovery", prd: "F-G1", blocking: false, destructive: false },
  { method: "config.saveMcp", prd: "F-F6", blocking: false, destructive: false },
  { method: "config.deleteMcp", prd: "F-G1", blocking: false, destructive: true },
  { method: "config.saveEndpoint", prd: "F-F2", blocking: false, destructive: false },
  { method: "config.deleteEndpoint", prd: "F-F2", blocking: false, destructive: true },

  { method: "agent.list", prd: "F-B2", blocking: false, destructive: false },
  { method: "agent.get", prd: "F-B2", blocking: false, destructive: false },
  { method: "agent.create", prd: "F-B2", blocking: false, destructive: false },
  { method: "agent.update", prd: "F-B2", blocking: false, destructive: false },
  { method: "agent.delete", prd: "F-F5", blocking: false, destructive: true },
  { method: "agent.setModel", prd: "F-B4", blocking: false, destructive: false },
  { method: "agent.setThinking", prd: "F-B6", blocking: false, destructive: false },
  { method: "agent.restoreFactory", prd: "F-F5", blocking: false, destructive: true },

  { method: "model.list", prd: "F-F3", blocking: false, destructive: false },
  { method: "model.listImages", prd: "F-F4", blocking: false, destructive: false },
  { method: "model.create", prd: "F-F3", blocking: false, destructive: false },
  { method: "model.update", prd: "F-F3", blocking: false, destructive: false },
  { method: "model.delete", prd: "F-F3", blocking: false, destructive: true },
  { method: "model.restoreFactory", prd: "F-F3", blocking: false, destructive: true },
  { method: "model.saveImage", prd: "F-F4", blocking: false, destructive: false },
  { method: "model.deleteImage", prd: "F-F4", blocking: false, destructive: true },

  { method: "asset.begin", prd: "F-H8", blocking: false, destructive: false },
  { method: "asset.end", prd: "F-H8", blocking: false, destructive: false },
  { method: "asset.get", prd: "F-H7", blocking: false, destructive: false },

  { method: "completion.files", prd: "F-H5", blocking: false, destructive: false },

  { method: "handoff.start", prd: "F-D5", blocking: true, destructive: false },
  { method: "handoff.listDocuments", prd: "F-D6", blocking: false, destructive: false },

  { method: "search.conversations", prd: "F-C6", blocking: false, destructive: false },
  { method: "search.messages", prd: "F-C6", blocking: false, destructive: false },
];

/** 动作名（`conversation.send` → `send`），编号撞车时用来给 id 去重 */
function actionOf(method: MethodName): string {
  return method.slice(method.indexOf(".") + 1);
}

/**
 * 造能力清单。
 *
 * 与语言无关：清单里没有一个句子，`host.hello`（只取 id）与 `host.capabilities` 出的是同一份。
 */
export function createCapabilities(): CapabilityView[] {
  const used = new Set<string>();
  return FACTS.map((fact) => {
    // 同一个编号下的第二个及以后的方法：`<编号>#<动作>`
    const id = used.has(fact.prd) ? `${fact.prd}#${actionOf(fact.method)}` : fact.prd;
    used.add(fact.prd);
    return {
      id,
      domain: methodDomain(fact.method),
      method: fact.method,
      blocking: fact.blocking,
      destructive: fact.destructive,
    };
  });
}
