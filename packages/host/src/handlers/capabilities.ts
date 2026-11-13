/**
 * 能力清单（PRD F-E5 / F-E6 / F-F9，裁定 R6）。
 *
 * 清单是「帮助页与指令菜单渲染用的那一份真相」，所以它必须与契约同步：每一项对应
 * `MethodMap` 里的一个方法名，编号取 PRD §4 那一行的能力号（`wire/methods.ts` 里每个方法
 * 的注释就写着自己的编号）。没有编号的方法用契约注释里记的那条决定编号（`workspace.*` 是
 * `D9`/`D10`/`D11`：PRD §4 当初没给项目单列能力行），不另编一个。
 *
 * 三件事刻意分开：
 *   - **标题与说明**：`LocalizedText`，按连接语言渲染（D8），文案键在 `i18n/`；
 *   - **`blocking`**：执行期间会不会占住这段对话（F-E6 让界面显示「正在执行什么」）；
 *   - **`destructive`**：有不可撤销的后果（F-F9 的二次确认）。
 *
 * 编号撞车的场合（几个方法服务同一条能力，例如 `config.saveEndpoint` / `config.deleteEndpoint`
 * 都属于 F-F2）用 `<编号>#<动作>` 做 id：编号仍是 PRD 的那个，id 保持唯一，客户端可以按 id 存
 * 展开状态。顺序与 `METHOD_NAMES` 一致，帮助页读起来就是「按域分组的办法清单」。
 */

import { DEFAULT_LANGUAGE, render } from "../i18n/index.js";
import type { Language, MessageKey } from "../i18n/index.js";
import { methodDomain } from "../wire/index.js";
import type { CapabilityView, LocalizedText, MethodName } from "../wire/index.js";

/** 一项能力的固定事实（标题与说明在 i18n 里，按方法名取） */
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
 * 删助手 / 删模型（含图片模型）/ 恢复出厂 / 吊销凭证。清通知不算：它清的是界面上的一条
 * 提示，为它弹二次确认反而是打扰。
 */
const FACTS: readonly CapabilityFact[] = [
  { method: "host.hello", prd: "F-A1", blocking: false, destructive: false },
  { method: "host.version", prd: "F-E3", blocking: false, destructive: false },
  { method: "host.upgrade", prd: "F-E3", blocking: false, destructive: false },
  { method: "host.shutdown", prd: "F-E1", blocking: false, destructive: false },
  { method: "host.usage", prd: "F-I5", blocking: false, destructive: false },
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
  { method: "config.patchMcps", prd: "F-G1", blocking: false, destructive: false },
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

  { method: "credential.list", prd: "F-E4", blocking: false, destructive: false },
  { method: "credential.create", prd: "F-E4", blocking: false, destructive: false },
  { method: "credential.revoke", prd: "F-E4", blocking: false, destructive: true },

  { method: "asset.begin", prd: "F-H8", blocking: false, destructive: false },
  { method: "asset.end", prd: "F-H8", blocking: false, destructive: false },
  { method: "asset.get", prd: "F-H7", blocking: false, destructive: false },

  { method: "completion.files", prd: "F-H5", blocking: false, destructive: false },

  { method: "handoff.start", prd: "F-D5", blocking: true, destructive: false },
  { method: "handoff.listDocuments", prd: "F-D6", blocking: false, destructive: false },

  { method: "search.conversations", prd: "F-C6", blocking: false, destructive: false },
  { method: "search.messages", prd: "F-C6", blocking: false, destructive: false },
];

/** 标题的文案键（`capability.<方法名>`） */
function titleKey(method: MethodName): MessageKey {
  return `capability.${method}` as MessageKey;
}

/** 说明的文案键（`capability.<方法名>.detail`） */
function detailKey(method: MethodName): MessageKey {
  return `capability.${method}.detail` as MessageKey;
}

/** 一句话：码 + 参数 + 按给定语言渲染的句子（存码不存句子，D8） */
function text(key: MessageKey, language: Language): LocalizedText {
  return { code: key, messageKey: key, params: {}, message: render(language, key) };
}

/** 动作名（`conversation.send` → `send`），编号撞车时用来给 id 去重 */
function actionOf(method: MethodName): string {
  return method.slice(method.indexOf(".") + 1);
}

/**
 * 造能力清单。
 *
 * 默认语言渲染一份：`host.hello` 与 `host.capabilities` 的出参都要能在不知道收件人语言时
 * 先给出形状，客户端按自己的语言用 `messageKey` + `params` 重渲染（D8 的同一套口径）。
 */
export function createCapabilities(language: Language = DEFAULT_LANGUAGE): CapabilityView[] {
  const used = new Set<string>();
  return FACTS.map((fact) => {
    // 同一个编号下的第二个及以后的方法：`<编号>#<动作>`
    const id = used.has(fact.prd) ? `${fact.prd}#${actionOf(fact.method)}` : fact.prd;
    used.add(fact.prd);
    return {
      id,
      domain: methodDomain(fact.method),
      title: text(titleKey(fact.method), language),
      description: text(detailKey(fact.method), language),
      method: fact.method,
      blocking: fact.blocking,
      destructive: fact.destructive,
    };
  });
}
