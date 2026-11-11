/**
 * 把 HTTP 风格的「方法表」接到守护进程上 —— 会话层的服务端入口。
 *
 * 这一层很薄：**只做参数校验 + 把事件接到调用方的连接上**。业务在 `SessionManager`，
 * 帧在 `Daemon`。分开的理由是可测性：管理器用假 Agent 就能测完整个事件流程，
 * 这里靠真 socket 测一次接线即可。
 *
 * `workspace.*` 也挂在这里：工作区是会话的父容器，两者的服务端入口本来就是同一个
 * （一个守护进程、一份 `workspacesRoot`）—— 为了几个方法名去另开一个 handler 文件，
 * 只会让组装要多接一次线、多传一份同样的路径参数。
 *
 * ## 谁要求「工作区路径还在」，谁不要求
 *
 * 路径是**记录里的一条事实**，目录随时会被 `mv` / `rm`。本层只在一处要求它还在：
 * **开会话**（`session.create`）。理由见 `requireWorkspacePath` —— 悄悄 `mkdir` 出一个
 * 空目录让人以为在续接，是最坏的失败形态。
 *
 * 只读 / 认身份的那些方法**不要求**路径存在：`workspace.resolve` / `list` / `rename` /
 * `remove` 认的是记录（恰恰要在目录不在了的时候还能用，才能修好它）；
 * `session.attach` / `last` / `list` / `snapshot` 等读的是历史，历史在
 * `workspaces/<id>/sessions/` 里，与那个工作目录在不在无关 —— 让它们因为路径缺失而
 * 失败，等于把「目录被挪了」升级成「历史打不开了」。
 *
 * ## 本层不做业务编排
 *
 * 一条判定落在本层的依据是「它只跟参数有关」：字段齐不齐、形状对不对、该不该要求路径
 * 存在。只要它需要**读别的对象再决定做什么**，那就是业务，归 `domain/`。
 *
 * `workspace.remove` 就是这条判据的样板：handler 只调 `removeWorkspace`（盘）与
 * `manager.closeWorkspace`（内存）两个业务动作，自己不列会话、不自己一个个 `close()`。
 */

import type { Connection, MethodHandlers } from "./Daemon.js";
import {
  badParams,
  field,
  optionalBoolean,
  optionalString,
  requireNumber,
  requireString,
} from "./params.js";
import {
  ensureWorkspace,
  listWorkspaces,
  readWorkspace,
  relocateWorkspace,
  removeWorkspace,
  renameWorkspace,
  requireWorkspacePath,
} from "../domain/workspace/workspace.js";
import { FileIndex } from "../domain/workspace/FileIndex.js";
import type { SessionManager } from "../domain/session/SessionManager.js";
import type {
  HandoffMode,
  MessageContent,
  MigrationStrategy,
  SessionAnswerResult,
  SessionAttachResult,
  SessionCancelResult,
  SessionCreateResult,
  SessionHandoffResult,
  SessionLastResult,
  SessionListEntry,
  SessionListResult,
  SessionRenameResult,
  SessionRemoveResult,
  SessionMigrateResult,
  SessionRollbackResult,
  SessionReloadParams,
  SessionCloseResult,
  SessionSaveAsResult,
  SessionSaveResult,
  SessionSendResult,
  SessionSnapshotResult,
  SubAgentSnapshotResult,
  WorkspaceFilesResult,
  WorkspaceListResult,
  WorkspaceRelocateResult,
  WorkspaceRemoveResult,
  WorkspaceRenameResult,
  WorkspaceResolveResult,
} from "../protocol/index.js";

import { codedError } from "../wire/errors.js";

export interface SessionHandlerOptions {
  manager: SessionManager;
  /** `<aiZenDir>/workspaces`（组装根算好传进来，本层不读全局路径） */
  workspacesRoot: string;
  /** 客户端没指定工作目录时用它（组装根注入，通常是服务端进程的 cwd） */
  defaultWorkspacePath: string;
  /**
   * 工作区文件索引（`workspace.files` 用）。不注入则自建一个真实实现的。
   *
   * 之所以留成可注入：清单来自**服务端磁盘**，接线测试不该为了验证一条路径去造真实文件树。
   */
  fileIndex?: FileIndex;
}

export function createSessionHandlers(options: SessionHandlerOptions): MethodHandlers {
  const { manager, workspacesRoot, defaultWorkspacePath } = options;
  const fileIndex = options.fileIndex ?? new FileIndex();

  /**
   * 工作区 id → 服务端路径。
   *
   * 只给 id 的调用（`workspace.files`、不带 `path` 的 `session.create`）都走这里：
   * 路径是**服务端**的磁盘事实，客户端只持有 id。反查不到就带码报错，绝不给个默认值
   * 往下走 —— 那种“看起来成功”的失败最难查。
   */
  const workspacePathOf = async (workspaceId: string): Promise<string> => {
    const workspace = await readWorkspace({ workspacesRoot, id: workspaceId });
    if (!workspace) throw codedError("unknown-workspace", `unknown workspace: ${workspaceId}`);
    return workspace.path;
  };

  /**
   * 「这条连接要看着这段会话」—— 登记它，断线时自动摘掉。
   *
   * 为什么要在**这里**接：会话层的「活着」判据就是「有没有持有者」（见 `SessionManager`
   * 文件头的规则一节），而「连接还在不在」只有传输层知道。声明式的上报（客户端主动发
   * 一帧）被删过一次：崩溃的进程发不出那一帧，而 socket 消失是内核保证的。
   *
   * 登记与摘除都不抛错：会话已经被别的路径收掉是常态，那时目的已经达成。
   */
  const holdSession = (manager: SessionManager, connection: Connection, sessionId: string) => {
    manager.registerHolder(sessionId, connection.id);
    connection.onClose(() => manager.dropHolder(sessionId, connection.id));
  };

  return {
    /**
     * 路径 → 工作区身份。
     *
     * `path` 缺省时用服务端自己的工作目录：**cwd 归属服务端**。客户端把自己进程的
     * 当前工作目录送上来，等于让客户端替服务端决定会话跑在哪个目录（TUI 连远端
     * 服务端时，那个目录在服务端很可能根本不存在）。本层也不去读进程级全局，
     * 缺省值由组装根注入。
     *
     * 路径此刻不存在也照常认（不报错）：这条问的是「这个目录是哪个工作区」，而不是
     * 「能不能在这里开会话」（后者是 `session.create` 的事）。用户 `mv` 完目录后客户端
     * 还是会拿旧路径或新路径来问，答案必须是那个**已经存在的** id，否则历史就找不回来了。
     */
    ["workspace.resolve"]: async (params): Promise<WorkspaceResolveResult> => {
      const path = optionalString(params, "path") ?? defaultWorkspacePath;
      const workspace = await ensureWorkspace({ workspacesRoot, path });
      return { workspaceId: workspace.id, path: workspace.path };
    },

    /**
     * 某个工作区的文件清单（客户端 `@` 补全用）。
     *
     * 只收 `workspaceId`：根目录是**服务端的磁盘事实**，靠 `workspace.json` 反查，
     * 不接受调用方递来的路径 —— 否则补全扫的就是别人机器上的目录。
     */
    ["workspace.files"]: async (params): Promise<WorkspaceFilesResult> => {
      const workspaceId = requireString(params, "workspaceId");
      return { entries: await fileIndex.list(await workspacePathOf(workspaceId)) };
    },

    /**
     * 盘上全部工作区（客户端启动时的侧栏）。
     *
     * 不带参数：工作区表是服务端盘上的全部事实，没有「按调用方过滤」这回事 ——
     * 一个连接服务于谁的工作区，与它能不能看见这些工作区无关（同一台机器上的
     * 终端与桌面端看到的是同一份）。顺序由 `listWorkspaces` 定死，客户端不重排。
     */
    ["workspace.list"]: async (): Promise<WorkspaceListResult> => {
      return { workspaces: await listWorkspaces({ workspacesRoot }) };
    },

    /**
     * 改工作区的显示名：**不动 id、不动 path**。
     *
     * 目标可以是一条「路径已经不在了」的记录 —— 这正是它有用的场景之一（目录被挪了，
     * 先给这个工作区起个名字，等下再 `relocate`）。
     */
    ["workspace.rename"]: async (params): Promise<WorkspaceRenameResult> => {
      return await renameWorkspace({
        workspacesRoot,
        id: requireString(params, "workspaceId"),
        title: requireString(params, "title"),
      });
    },

    /**
     * 删一个工作区：**连它的全部会话一起**（整个 `workspaces/<id>/` 目录，含
     * `sessions/` 与「上一轮会话」指针）。
     *
     * 两件事分在两处：「删盘上的目录（含存档）」是工作区的业务（`removeWorkspace`），
     * 「关掉内存里的活会话」是会话的业务（`manager.closeWorkspace`）。两边都必须做 ——
     * 被删目录里的活会话下一轮收尾会把存档写回来（`FileSessionStore.write` 自己
     * 会 `mkdir`），刚删掉的工作区就**部分复活**了。
     *
     * 幂等：目录本来就不在 → `removed:false`，不当错误。
     */
    ["workspace.remove"]: async (params): Promise<WorkspaceRemoveResult> => {
      const workspaceId = requireString(params, "workspaceId");
      const result = await removeWorkspace({ workspacesRoot, id: workspaceId });
      manager.closeWorkspace(workspaceId);
      return result;
    },

    /**
     * 把工作区搬到新目录（**id 不变**）—— 目录改名 / 移动之后把历史接回来的唯一入口。
     *
     * 参数校验之外的三条判定（新路径必须存在、不能与别的工作区撞、id 不动）都在
     * `relocateWorkspace` 里：它们要碰磁盘，且与 `session.create` 的前置判断是同一条。
     */
    ["workspace.relocate"]: async (params): Promise<WorkspaceRelocateResult> => {
      return await relocateWorkspace({
        workspacesRoot,
        id: requireString(params, "workspaceId"),
        path: requireString(params, "path"),
      });
    },

    /**
     * 订阅事件：这条连接开始收事件。
     *
     * 归在 `events.*` 而不是 `session.*`：订阅是**连接级**的，跟某个具体会话无关
     * （一个连接可以同时看多个会话的事件）。一个会话可能被多个客户端看（终端 + 桌面端），
     * 而每个客户端的连断互不相干 —— 连接断开时自动退订（`onClose`）。
     */
    ["events.watch"]: (_params, connection: Connection) => {
      const unsubscribe = manager.subscribe((event) => connection.send(event));
      connection.onClose(unsubscribe);
      return { watching: true };
    },

    /**
     * 开会话。
     *
     * `path` 可以不给：工作区 id 本来就能反查出路径（`workspace.json`），客户端再抄一遍
     * 路径只是多一个会漂的副本，而且它抄的是**自己**那边的路径 —— 两机时那个路径在服务端
     * 根本不存在。这与 `workspace.resolve` 的 `path` 可选是同一个口径：cwd 归服务端。
     */
    ["session.create"]: async (params, connection): Promise<SessionCreateResult> => {
      const workspaceId = requireString(params, "workspaceId");
      const path = optionalString(params, "path") ?? (await workspacePathOf(workspaceId));
      /**
       * 路径不在了就**明确报错**（`workspace-path-missing`，message 里带 path），
       * 绝不替用户 `mkdir`：否则用户以为在接着上次聊，其实进了另一个空目录 ——
       * 历史还在 `<workspaceId>/sessions/` 里，但它此刻属于一条已经不存在的路径。
       *
       * 两条入口都过这一关：客户端递 path 的（旧调用），以及只给 `workspaceId` 由服务端
       * 反查路径的。判断只有 `requireWorkspacePath` 一处，`workspace.relocate` 用它同一个。
       *
       * `session.attach` 故意**不**要求路径存在：它读的是历史，历史与目录在不在无关
       * （见文件头「谁要求工作区路径还在」）。
       */
      await requireWorkspacePath(path);
      const agentId = optionalString(params, "agentId");
      const sessionId = optionalString(params, "sessionId");
      // `persist:false` = 一次性调用（`ai "…"`）：不自动落盘、不挪「上一轮会话」指针
      const persist = optionalBoolean(params, "persist");
      const result = await manager.create({ workspaceId, path, agentId, sessionId, persist });
      holdSession(manager, connection, result.sessionId);
      return result;
    },

    /**
     * 接上一段已有会话（`create` 的新建语义不动：id 撞了仍然拒绝）。
     *
     * 客户端只会递 id —— 那段会话此刻在不在内存里、还是只在盘上，它无从判断。
     */
    ["session.attach"]: async (params, connection): Promise<SessionAttachResult> => {
      const workspaceId = requireString(params, "workspaceId");
      const path = optionalString(params, "path") ?? (await workspacePathOf(workspaceId));
      const result = await manager.attach({
        workspaceId,
        path,
        sessionId: requireString(params, "sessionId"),
        agentId: optionalString(params, "agentId"),
      });
      holdSession(manager, connection, result.sessionId);
      return result;
    },

    ["session.send"]: (params): SessionSendResult => {
      const sessionId = requireString(params, "sessionId");
      const content = requireContent(params);
      return manager.send(sessionId, content);
    },

    ["session.cancel"]: (params): SessionCancelResult => {
      return manager.cancel(requireString(params, "sessionId"));
    },

    /**
     * 回答服务端提出的问题（目前只有自动迁移的「用哪种方式交接」）。
     *
     * 三个字段都是必填的：`mode` 不给不等于「不交接」—— 「不交接」是一个明确的选择，
     * 用 `null` 表达；字段缺失是调用方漏了东西（或客户端版本对不上），当场拒比默默按
     * `null` 处理安全得多（后者会让用户的会话在无提示的情况下不迁移）。
     */
    ["session.answer"]: (params): SessionAnswerResult => {
      return manager.answer(
        requireString(params, "sessionId"),
        requireString(params, "questionId"),
        requireChoice(params),
      );
    },

    /**
     * 某个工作区的会话清单：盘上的存档 ∪ 内存里的活会话（一条不重）。
     *
     * 存档与活会话在**同一个条目形状**里给出，所以一段会话在列表里只有一个条目。
     */
    ["session.list"]: async (params): Promise<SessionListResult> => {
      const workspaceId = requireString(params, "workspaceId");
      const includeSaved = optionalBoolean(params, "includeSaved");
      return { sessions: await manager.list(workspaceId, { includeSaved }) };
    },

    /** 改显示名（不动 id；目标可以只是盘上的存档） */
    ["session.rename"]: async (params): Promise<SessionRenameResult> => {
      return await manager.rename({
        workspaceId: requireString(params, "workspaceId"),
        sessionId: requireString(params, "sessionId"),
        title: requireString(params, "title"),
      });
    },

    /** 删一段会话（物理删存档；幂等） */
    ["session.remove"]: async (params): Promise<SessionRemoveResult> => {
      return await manager.remove({
        workspaceId: requireString(params, "workspaceId"),
        sessionId: requireString(params, "sessionId"),
      });
    },

    /**
     * 某个工作区「上一轮会话」的指针（只有 id；客户端拿它走续接）。
     *
     * 指针指向的存档已不在（改名 / 手删）时回 `null` —— 取舍见 `SessionManager.last`。
     */
    ["session.last"]: async (params): Promise<SessionLastResult> => {
      return await manager.last(requireString(params, "workspaceId"));
    },

    ["session.rollback"]: async (params): Promise<SessionRollbackResult> => {
      return await manager.rollback(
        requireString(params, "sessionId"),
        requireNumber(params, "index"),
      );
    },

    ["session.snapshot"]: async (params): Promise<SessionSnapshotResult> => {
      return await manager.snapshot(requireString(params, "sessionId"));
    },

    ["session.reload"]: async (params): Promise<SessionSnapshotResult> => {
      return await manager.reload(requireString(params, "sessionId"));
    },

    /**
     * 换 Agent：同一段对话、换一个 Agent 继续（保留消息）。
     *
     * `agentId` 是否真存在由装配方判定（它读定义）；这一层只保证参数齐。
     */
    ["session.setAgent"]: async (params): Promise<SessionSnapshotResult> => {
      return await manager.setAgent(
        requireString(params, "sessionId"),
        requireString(params, "agentId"),
      );
    },

    /**
     * 换**这一段会话**的模型（`/model <id>`）：写会话存档的 `modelId` 并重建 Agent。
     *
     * 模型是否在配置里、端点有没有 Key：由装配方（SDK 的 `createModel`）在重建时判定
     * —— 这一层只保证参数齐。失败时会话原样不动（见 `SessionManager.setModel`）。
     */
    ["session.model.set"]: async (params): Promise<SessionSnapshotResult> => {
      return await manager.setModel(
        requireString(params, "sessionId"),
        requireString(params, "modelId"),
      );
    },

    /**
     * 写**这一段会话**的模型参数覆盖（`/think` 在会话级模型下写的那一层）。
     *
     * 只验 `sessionId`：`modelParams` 是**不透明载荷**（协议不解释键名，也不该在这里
     * 替客户端判断它长得对不对）。`null` 是合法值（= 清掉覆盖，回到模型出厂参数），
     * 所以不能拿 `requireString` 那类必填判定去卡它。
     */
    ["session.modelParams.set"]: async (params): Promise<SessionSnapshotResult> => {
      return await manager.setModelParams(
        requireString(params, "sessionId"),
        field(params, "modelParams"),
      );
    },

    /** 明确关闭一段会话（幂等：本来就没在跑时回 `closed:false`，不当错误） */
    ["session.close"]: (params): SessionCloseResult => {
      return manager.close(requireString(params, "sessionId"));
    },

    /**
     * 某个子 Agent 到目前为止的完整对话。
     *
     * 子 Agent 只活在当前一轮（见 `EventBridge.clearSubAgents`）：轮次过去后这个 id 就
     * 不存在了，所以带 `sub-agent-missing` 码报错，而不是回一份空对话。
     */
    ["session.subAgent.snapshot"]: async (params): Promise<SubAgentSnapshotResult> => {
      return await manager.subAgentSnapshot(
        requireString(params, "sessionId"),
        requireString(params, "subAgentId"),
      );
    },

    ["session.save"]: async (params): Promise<SessionSaveResult> => {
      // `setAsLast:false` = 一次性调用的归档（`ai --save`）：写档但不篡改续接指针
      return await manager.save(requireString(params, "sessionId"), {
        setAsLast: optionalBoolean(params, "setAsLast"),
      });
    },

    ["session.saveAs"]: async (params): Promise<SessionSaveAsResult> => {
      return await manager.saveAs(requireString(params, "sessionId"), requireString(params, "id"));
    },

    /**
     * 交接两个方法的耗时是分钟级的（`self` 模式要跑一到两个完整回合）。
     *
     * 守护进程对方法调用不设超时（帧层只管字节），所以这里不需要“先回执、结果走事件”
     * 那一套（那是 `session.send` 的做法）；进度会作为 `session-notice` 与
     * `session-phase` / `chunk-parsed` 事件先到，客户端不必等回执才知道在动。
     */
    ["session.handoff"]: async (params): Promise<SessionHandoffResult> => {
      return await manager.handoff(requireString(params, "sessionId"), optionalMode(params));
    },

    ["session.migrate"]: async (params): Promise<SessionMigrateResult> => {
      return await manager.migrate(
        requireString(params, "sessionId"),
        optionalMode(params),
        optionalStrategy(params),
      );
    },
  };
}

/**
 * 消息内容：非空文本，或非空的「文本 / 图片」内容块数组。
 *
 * 只校验形状，**不看内容**（服务端不解释它）。不认识的块类型当场拒：放过去只会
 * 在模型端点那边变成一条更难懂的 400。
 */
function requireContent(params: unknown): MessageContent {
  const value = (params as Record<string, unknown> | null | undefined)?.["content"];
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && value.length > 0 && value.every(isContentBlock)) return value;
  throw badParams(`missing or invalid "content"`);
}

function isContentBlock(block: unknown): boolean {
  const item = block as {
    type?: unknown;
    text?: unknown;
    image_url?: { url?: unknown };
    file_id?: unknown;
    file_data?: unknown;
  } | null;
  if (item?.type === "text") return typeof item.text === "string";
  if (item?.type === "image_url") return typeof item.image_url?.url === "string";
  // `file`：`file_id`（已上传）与 `file_data`（base64 内联）至少要有一个
  if (item?.type === "file")
    return typeof item.file_id === "string" || typeof item.file_data === "string";
  return false;
}

/** 交接执行者：只有两个取值，别的值不猜（猜错了要么多烧一轮全量输入，要么写不出文档） */
function optionalMode(params: unknown): HandoffMode | undefined {
  const value = (params as Record<string, unknown> | null | undefined)?.["mode"];
  if (value === undefined || value === null) return undefined;
  if (value !== "self" && value !== "summary") {
    throw badParams(`invalid "mode" (expected self | summary)`);
  }
  return value;
}

/**
 * 迁移的历史处置策略：只有两个取值，别的值不猜。
 *
 * 为什么缺省是 `undefined` 而不是在这里写成 `"prune"`：缺省值只有一个定义处（
 * `SessionManager.migrate` 的参数默认值），handler 再写一份就等于把「缺省是什么」
 * 说了两遍 —— 改一处忘一处时，症状是「客户端不传时行为不一样」，最难查的一类。
 *
 * 猜错的代价很实在：`prune` 与 `omit` 绑着「换不换 sessionId」，猜错等于把用户的会话
 * 变成另一段（或者凭空多一条存档）。
 */
function optionalStrategy(params: unknown): MigrationStrategy | undefined {
  const value = (params as Record<string, unknown> | null | undefined)?.["strategy"];
  if (value === undefined || value === null) return undefined;
  if (value !== "prune" && value !== "omit") {
    throw badParams(`invalid "strategy" (expected prune | omit)`);
  }
  return value;
}

/**
 * 回答的载荷：`choice`（选项 id）或 `null`（跳过）。
 *
 * 这一层**不判**哪个 id 对某个 `kind` 合法 —— 那是提问方的事（`kind` 与选项都是它给的）。
 * 只保证形状：非空字符串或 `null`，别的一律 `bad-params`。
 *
 * 与 `optionalMode` 分开而不是复用，是因为两者对「没给」的态度相反：那里缺省是合法的
 * （用 `self`），这里缺省不合法 —— `null` 已经代表「跳过」这个明确选择，`undefined`
 * 只能是调用方漏了字段。
 */
function requireChoice(params: unknown): string | null {
  const value = field(params, "choice");
  if (value === null) return null;
  if (typeof value === "string" && value.length > 0) return value;
  throw badParams(`invalid "choice" (expected option id | null)`);
}
