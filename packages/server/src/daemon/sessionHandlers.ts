/**
 * 把 HTTP 风格的「方法表」接到守护进程上 —— 会话层的服务端入口。
 *
 * 这一层很薄：**只做参数校验 + 把事件接到调用方的连接上**。业务在 `SessionManager`，
 * 帧在 `Daemon`。分开的理由是可测性：管理器用假 Agent 就能测完整个事件流程，
 * 这里靠真 socket 测一次接线即可。
 *
 * `workspace.*` 也挂在这里：工作区是会话的父容器，两者的服务端入口本来就是同一个
 * （一个守护进程、一份 `workspacesRoot`）—— 为了两个方法名去另开一个 handler 文件，
 * 只会让组装要多接一次线、多传一份同样的路径参数。
 */

import type { Connection, MethodHandler } from "./Daemon.js";
import { badParams, codedError, field, optionalString, requireNumber, requireString } from "./params.js";
import { ensureWorkspace, readWorkspace } from "../service/workspace/workspace.js";
import { FileIndex } from "../service/workspace/FileIndex.js";
import type { SessionManager } from "../service/session/SessionManager.js";
import {
  EVENT_METHODS,
  SESSION_METHODS,
  WORKSPACE_METHODS,
  type HandoffMode,
  type MessageContent,
  type SessionAnswerResult,
  type SessionAttachResult,
  type SessionCancelResult,
  type SessionCreateResult,
  type SessionHandoffResult,
  type SessionLastResult,
  type SessionListResult,
  type SessionListSavedResult,
  type SessionMigrateResult,
  type SessionRollbackResult,
  type SessionReloadParams,
  type SessionSaveAsResult,
  type SessionSaveResult,
  type SessionSendResult,
  type SessionSnapshotResult,
  type SubAgentSnapshotResult,
  type WorkspaceFilesResult,
  type WorkspaceResolveResult,
} from "../protocol/sessions.js";

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

export function createSessionHandlers(options: SessionHandlerOptions): Record<string, MethodHandler> {
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
    if (!workspace) throw codedError("workspace-not-found", `unknown workspace: ${workspaceId}`);
    return workspace.path;
  };

  return {
    /**
     * 路径 → 工作区身份。
     *
     * `path` 缺省时用服务端自己的工作目录：**cwd 归属服务端**。客户端把自己进程的
     * 当前工作目录送上来，等于让客户端替服务端决定会话跑在哪个目录（TUI 连远端
     * 服务端时，那个目录在服务端很可能根本不存在）。本层也不去读进程级全局，
     * 缺省值由组装根注入。
     */
    [WORKSPACE_METHODS.resolve]: async (params): Promise<WorkspaceResolveResult> => {
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
    [WORKSPACE_METHODS.files]: async (params): Promise<WorkspaceFilesResult> => {
      const workspaceId = requireString(params, "workspaceId");
      return { entries: await fileIndex.list(await workspacePathOf(workspaceId)) };
    },

    /**
     * 订阅事件：这条连接开始收事件。
     *
     * 归在 `events.*` 而不是 `session.*`：订阅是**连接级**的，跟某个具体会话无关
     * （一个连接可以同时看多个会话的事件）。一个会话可能被多个客户端看（终端 + 桌面端），
     * 而每个客户端的连断互不相干 —— 连接断开时自动退订（`onClose`）。
     */
    [EVENT_METHODS.watch]: (_params, connection: Connection) => {
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
    [SESSION_METHODS.create]: async (params): Promise<SessionCreateResult> => {
      const workspaceId = requireString(params, "workspaceId");
      const path = optionalString(params, "path") ?? (await workspacePathOf(workspaceId));
      const agentId = optionalString(params, "agentId");
      const sessionId = optionalString(params, "sessionId");
      return await manager.create({ workspaceId, path, agentId, sessionId });
    },

    /**
     * 接上一段已有会话（`create` 的新建语义不动：id 撞了仍然拒绝）。
     *
     * 客户端只会递 id —— 那段会话此刻在不在内存里、还是只在盘上，它无从判断。
     */
    [SESSION_METHODS.attach]: async (params): Promise<SessionAttachResult> => {
      const workspaceId = requireString(params, "workspaceId");
      const path = optionalString(params, "path") ?? (await workspacePathOf(workspaceId));
      return await manager.attach({
        workspaceId,
        path,
        sessionId: requireString(params, "sessionId"),
        agentId: optionalString(params, "agentId"),
      });
    },

    [SESSION_METHODS.send]: (params): SessionSendResult => {
      const sessionId = requireString(params, "sessionId");
      const content = requireContent(params);
      return manager.send(sessionId, content);
    },

    [SESSION_METHODS.cancel]: (params): SessionCancelResult => {
      return manager.cancel(requireString(params, "sessionId"));
    },

    /**
     * 回答服务端提出的问题（目前只有自动迁移的「用哪种方式交接」）。
     *
     * 三个字段都是必填的：`mode` 不给不等于「不交接」—— 「不交接」是一个明确的选择，
     * 用 `null` 表达；字段缺失是调用方漏了东西（或客户端版本对不上），当场拒比默默按
     * `null` 处理安全得多（后者会让用户的会话在无提示的情况下不迁移）。
     */
    [SESSION_METHODS.answer]: (params): SessionAnswerResult => {
      return manager.answer(
        requireString(params, "sessionId"),
        requireString(params, "questionId"),
        requireAnswerMode(params),
      );
    },

    [SESSION_METHODS.list]: (params): SessionListResult => {
      return { sessions: manager.list(requireString(params, "workspaceId")) };
    },

    [SESSION_METHODS.listSaved]: async (params): Promise<SessionListSavedResult> => {
      return { sessions: await manager.listSaved(requireString(params, "workspaceId")) };
    },

    /**
     * 某个工作区「上一轮会话」的指针（只有 id；客户端拿它走续接）。
     *
     * 指针指向的存档已不在（改名 / 手删）时回 `null` —— 取舍见 `SessionManager.last`。
     */
    [SESSION_METHODS.last]: async (params): Promise<SessionLastResult> => {
      return await manager.last(requireString(params, "workspaceId"));
    },

    [SESSION_METHODS.rollback]: async (params): Promise<SessionRollbackResult> => {
      return await manager.rollback(requireString(params, "sessionId"), requireNumber(params, "index"));
    },

    [SESSION_METHODS.snapshot]: async (params): Promise<SessionSnapshotResult> => {
      return await manager.snapshot(requireString(params, "sessionId"));
    },

    [SESSION_METHODS.reload]: async (params): Promise<SessionSnapshotResult> => {
      return await manager.reload(requireString(params, "sessionId"));
    },

    /**
     * 某个子 Agent 到目前为止的完整对话。
     *
     * 子 Agent 只活在当前一轮（见 `SessionManager.clearSubAgents`）：轮次过去后这个 id 就
     * 不存在了，所以带 `sub-agent-missing` 码报错，而不是回一份空对话。
     */
    [SESSION_METHODS.subAgentSnapshot]: async (params): Promise<SubAgentSnapshotResult> => {
      return await manager.subAgentSnapshot(
        requireString(params, "sessionId"),
        requireString(params, "subAgentId"),
      );
    },

    [SESSION_METHODS.save]: async (params): Promise<SessionSaveResult> => {
      return await manager.save(requireString(params, "sessionId"));
    },

    [SESSION_METHODS.saveAs]: async (params): Promise<SessionSaveAsResult> => {
      return await manager.saveAs(requireString(params, "sessionId"), requireString(params, "id"));
    },

    /**
     * 交接两个方法的耗时是分钟级的（`self` 模式要跑一到两个完整回合）。
     *
     * 守护进程对方法调用不设超时（帧层只管字节），所以这里不需要“先回执、结果走事件”
     * 那一套（那是 `session.send` 的做法）；进度会作为 `session.notice` 与
     * `session.phase` / `message.delta` 事件先到，客户端不必等回执才知道在动。
     */
    [SESSION_METHODS.handoff]: async (params): Promise<SessionHandoffResult> => {
      return await manager.handoff(requireString(params, "sessionId"), optionalMode(params));
    },

    [SESSION_METHODS.migrate]: async (params): Promise<SessionMigrateResult> => {
      return await manager.migrate(requireString(params, "sessionId"), optionalMode(params));
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
  if (item?.type === "file") return typeof item.file_id === "string" || typeof item.file_data === "string";
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
 * 回答自动迁移提问的执行者：`self` / `summary` / `null` 三选一。
 *
 * 与 `optionalMode` 分开而不是复用：那里「没给」是合法的（用默认执行者），这里
 * 「没给」不合法 —— `null` 已经是「不交接」那个选项，`undefined` 只能是调用方写错了。
 */
function requireAnswerMode(params: unknown): HandoffMode | null {
  const value = field(params, "mode");
  if (value === null) return null;
  if (value === "self" || value === "summary") return value;
  throw badParams(`invalid "mode" (expected self | summary | null)`);
}

