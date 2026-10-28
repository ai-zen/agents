/**
 * 出厂 Skill 资产 —— 随 SDK 版本释放到 `<basePath>/skills/<id>/SKILL.md`。
 *
 * 为什么以 TS 字符串常量内联、而不是独立 .md 文件：
 * SDK 用 `tsc` 直接编译，不拷贝非 TS 资源；内容内联后 `dist/` 天然携带，
 * 无需额外打包步骤，也不依赖包内相对资源路径。
 *
 * 覆盖策略（与 `syncManagedModels` 同构）：
 *   - 磁盘上的 SKILL.md frontmatter 里写了 `custom: "true"` → 视为用户自有，永不被覆盖；
 *   - 否则每次 `ConfigManager.bootstrap()` 同步为当前版本内容（模板属于产品行为，
 *     改进了就要让老用户吃到）。
 */

/** 交接 Skill 的 id（目录名 = frontmatter name） */
export const HANDOFF_SKILL_ID = "handoff";

/**
 * 交接文档兜底模板。
 *
 * 仅在磁盘上读不到 `handoff` Skill 时使用（用户删除 / 目录不可读）。
 * 它是**保险丝**，不是第二真相源：正常路径下模板一律来自 SKILL.md。
 */
export const FALLBACK_HANDOFF_TEMPLATE = [
  "# Handoff Document",
  "",
  "Stop work immediately: implement no further features, do not continue unfinished tasks, and do not ask the user questions.",
  "Your only task is: verify the actual current state → write the handoff document to the path given by the handoff parameters.",
  "",
  "## 💬 Conversation Breakpoint",
  "## 🎯 Task Goal",
  "## 📊 Current State",
  "## ✅ Completed",
  "## 📋 Not Completed",
  "## 🧠 Key Decisions",
  "## ⚠️ Constraints and Preferences",
  "## 📁 File Index",
  "## 🔔 First Step for the Next Agent",
  "",
  'For anything you cannot verify, write "⚠️ Unverified"; speculation is forbidden.',
].join("\n");

/** 出厂 Skill：交接（handoff） */
const HANDOFF_SKILL = `---
name: handoff
description: Write a task handoff document — when you stop work and leave the conversation, put the task goal, the actual current state, key decisions and next steps into a document that someone else can pick up directly.
metadata:
  custom: "false"
---

# Handoff Document Writing Standard

## When It Applies

When the context is about to overflow and trigger a task migration, when the user explicitly asks you to "write a handoff document", or when you are asked to "hand over".

## Iron Rules (violating any of them counts as failure)

1. **Stop work immediately**: implement no further features, do not continue unfinished tasks, do not fix bugs in passing, do not refactor.
2. **Do not ask the user questions**, do not discuss approaches, do not ask for confirmation.
3. Do only two things: **verify the actual current state** → **write the document**.
4. Read-only operations are allowed (read / ls / glob / find_text / inspect_file / cwd, plus read-only commands such as git status, git diff, git log).
   Modifying the workspace is forbidden: do not change source code, do not npm install, do not commit, do not push. The only file you are allowed to write is the handoff document itself.
5. **Write it in one pass**, do not rewrite it over and over; do not read large files; do not paste long code into the document.

## Writing the File

The path is given by the handoff parameters — **use it verbatim**; do not rename it, do not move it to another directory, do not omit it.
After writing with the write tool, read it back once with the read tool to confirm the content is complete (skip this step if you have no read capability).

## Document Structure (write in this order, keep the headings exactly as they are)

## 💬 Conversation Breakpoint
What the user last asked for, and what you last replied with or delivered. One paragraph each; do not restate the whole conversation.

## 🎯 Task Goal
What the user actually wants (intent and acceptance criteria), not a checklist of the steps you performed.

## 📊 Current State
Branch and commit, uncommitted changes, whether tests pass, whether any process/port is running, whether dependencies are installed.

## ✅ Completed
For each item write: what was done + the output path (file/directory) + how to verify that it really took effect.

## 📋 Not Completed
Order by priority; for each item write "the smallest next action", down to a specific file or runnable command.

## 🧠 Key Decisions
Why it was done this way (the trade-off reasoning); and the dead ends you walked into — so the next person does not repeat them.

## ⚠️ Constraints and Preferences
Rules the user stressed, project conventions, parts that must not be changed, styles that must be followed.

## 📁 File Index
Path + purpose + whether it changed this time (added / modified / read only).

## 🔔 First Step for the Next Agent
At most 3 commands or actions that can be run directly, so the next person can start working immediately.

## State Verification Checklist

- \`git status\` / \`git diff --stat\`: current branch, whether there are uncommitted changes
- The latest test result: if you ran tests, write a summary of the result; if you did not, write "not run" — **do not write "it should pass"**
- Key files involved in the handoff: use ls / read to confirm they really exist on disk
- Running services and ports: \`ps\` / \`lsof -i\`, or the project's own start script

> ⚠️ If the handoff parameters state that tools are unavailable: write "⚠️ Unverified" for every item above; **speculation is forbidden** about specific paths, progress and test status.

## Writing Requirements

- Every sentence must let the next person "start working immediately"; empty phrases such as "continue development", "polish the features", "do some optimization" are forbidden.
- For information you can no longer determine in the current context, write "needs user confirmation on XXX"; do not fabricate it.
- Keep the whole document within 300 lines.
`;

/** 全部出厂 Skill（顺序无意义，按 id 去重） */
export const FACTORY_SKILLS: readonly { id: string; content: string }[] = [
  { id: HANDOFF_SKILL_ID, content: HANDOFF_SKILL },
];

/**
 * 判断一份 SKILL.md 是否被用户声明为自有。
 *
 * 只检查 frontmatter 区块内的 `custom: true`（允许带引号），
 * 正文里出现同样的字样不生效——避免误判导致模板停止更新。
 */
export function isCustomSkill(content: string): boolean {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;
  return /^\s*custom:\s*["']?true["']?\s*$/m.test(match[1]);
}
