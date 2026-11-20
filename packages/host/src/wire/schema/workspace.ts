/**
 * `workspace.*` 的入参形状 —— **唯一真相**。
 *
 * 口径与 `session.ts` / `model.ts` 一致：形状在这一层判一次（`WsHub.parseParams` 是唯一执行点），
 * 文案只用既有的 reason 词（`empty` / `not_an_object` / `not_boolean`）。
 *
 * **留在服务层的东西**（这里刻意没搬，一条都没改语义）：
 *   - `cwd` 是不是绝对路径（`not_absolute`）与 `resolve()` 归一化 —— `WorkspaceService.normalizeCwd`
 *     要拿 `node:path` 判平台语义（`isAbsolute` 在 Windows 上认盘符），那是「路径对不对」而不是
 *     「这一格填的是什么」；
 *   - 同一个 cwd 只登记一次（`already_registered`）、项目在不在（`not_found`）—— 都要读库。
 */

import { z } from "zod";

import { sessionIdSchema } from "./session.js";

/** 对象入参的失败文案：`not_an_object`（与 `WsHub` 的 `asRecord` 同一个词） */
const OBJECT_ERROR = { error: "not_an_object" } as const;

// ---------------------------------------------------------------------------
// 可复用的形状
// ---------------------------------------------------------------------------

/**
 * 一个项目 id：非空字符串，两侧空白不算内容。
 *
 * 与 `sessionIdSchema` 同形 —— 项目 id 是宿主分配的 UUID（`WorkspaceService.create` 里
 * `randomUUID()`），不是文件名，所以不套 `agentIdSchema` 那套字符集。直接复用，不重写。
 */
const workspaceIdSchema = sessionIdSchema;

/**
 * 一个项目的显示名：必填、非空、两侧空白不算内容。
 *
 * 就是 `WorkspaceService.requireName` 原来那条判据（`workspace.rename` 的 `name` 走它）。
 * 第三波把 `requireName` 删掉时行为不变：`"  "` 是 `empty`，`"  我的项目  "` 归一成 `"我的项目"`。
 */
export const workspaceNameSchema = z.string("empty").trim().min(1, "empty");

/** `dryRun?: boolean`：只认布尔（PRD D11 / F-F9：`true` = 只算代价不动手） */
const dryRunSchema = z.boolean("not_boolean").optional();

// ---------------------------------------------------------------------------
// workspace.*（5 个，顺序与方法表一致）
// ---------------------------------------------------------------------------

/**
 * `workspace.list` 入参：只有「连目录已不存在的也列吗」一格。
 *
 * 默认列（PRD D12：目录没了会话照样能看），`includeMissingFolders: false` 时才过滤掉。
 */
export const workspaceListParams = z.object(
  { includeMissingFolders: z.boolean("not_boolean").optional() },
  OBJECT_ERROR,
);

/**
 * `workspace.create` 入参（PRD D9 / D10）：登记一个目录。
 *
 * `cwd` 只在这里判「非空字符串」；绝对路径与归一化归服务层（见文件头）。
 *
 * `name` 是**可以空、可以不给**的：省略或空白就由目录名起一个名字（`basename(cwd)`，之后可改）。
 * 所以它刻意**不**用 {@link workspaceNameSchema}（那个 min(1) 属于改名），只 `.trim()` 一下 ——
 * 归一化的目的与 `cwd` 一样，让服务层拿到的就是干净的那一串。
 */
export const workspaceCreateParams = z.object(
  { cwd: z.string("empty").trim().min(1, "empty"), name: z.string("empty").trim().optional() },
  OBJECT_ERROR,
);

/** `workspace.get` 入参：只有项目 id */
export const workspaceGetParams = z.object({ workspaceId: workspaceIdSchema }, OBJECT_ERROR);

/** `workspace.rename` 入参（PRD D9：名字可改，id 与 cwd 不变） */
export const workspaceRenameParams = z.object(
  { workspaceId: workspaceIdSchema, name: workspaceNameSchema },
  OBJECT_ERROR,
);

/** `workspace.remove` 入参（PRD D11 / F-F9：`dryRun` 只算代价，目录本身宿主不碰） */
export const workspaceRemoveParams = z.object(
  { workspaceId: workspaceIdSchema, dryRun: dryRunSchema },
  OBJECT_ERROR,
);
