/**
 * 把 HTTP 风格的「方法表」接到守护进程上 —— 会话层的服务端入口。
 *
 * 这一层很薄：**只做参数校验 + 把事件接到调用方的连接上**。业务在 `SessionManager`，
 * 帧在 `Daemon`。分开的理由是可测性：管理器用假 Agent 就能测完整个事件流程，
 * 这里靠真 socket 测一次接线即可。
 */

import type { Connection, MethodHandler } from "./Daemon.js";
import { ensureWorkspace } from "../service/workspace/workspace.js";
import type { SessionManager } from "../service/session/SessionManager.js";
import {
  EVENT_METHODS,
  SESSION_METHODS,
  type SessionCancelResult,
  type SessionCreateResult,
  type SessionListResult,
  type SessionListSavedResult,
  type SessionRollbackResult,
  type SessionSaveResult,
  type SessionSendResult,
  type SessionSnapshotResult,
  type WorkspaceResolveResult,
} from "../protocol/sessions.js";

export interface SessionHandlerOptions {
  manager: SessionManager;
  /** `<aiZenDir>/workspaces`（组装根算好传进来，本层不读全局路径） */
  workspacesRoot: string;
}

export function createSessionHandlers(options: SessionHandlerOptions): Record<string, MethodHandler> {
  const { manager, workspacesRoot } = options;

  return {
    [SESSION_METHODS.workspaceResolve]: async (params): Promise<WorkspaceResolveResult> => {
      const path = requireString(params, "path");
      const workspace = await ensureWorkspace({ workspacesRoot, path });
      return { workspaceId: workspace.id, path: workspace.path };
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

    [SESSION_METHODS.create]: async (params): Promise<SessionCreateResult> => {
      const workspaceId = requireString(params, "workspaceId");
      const path = requireString(params, "path");
      const agentId = optionalString(params, "agentId");
      return await manager.create({ workspaceId, path, agentId });
    },

    [SESSION_METHODS.send]: (params): SessionSendResult => {
      const sessionId = requireString(params, "sessionId");
      const content = requireString(params, "content");
      return manager.send(sessionId, content);
    },

    [SESSION_METHODS.cancel]: (params): SessionCancelResult => {
      return manager.cancel(requireString(params, "sessionId"));
    },

    [SESSION_METHODS.list]: (params): SessionListResult => {
      return { sessions: manager.list(requireString(params, "workspaceId")) };
    },

    [SESSION_METHODS.listSaved]: async (params): Promise<SessionListSavedResult> => {
      return { sessions: await manager.listSaved(requireString(params, "workspaceId")) };
    },

    [SESSION_METHODS.rollback]: async (params): Promise<SessionRollbackResult> => {
      return await manager.rollback(requireString(params, "sessionId"), requireNumber(params, "index"));
    },

    [SESSION_METHODS.snapshot]: async (params): Promise<SessionSnapshotResult> => {
      return await manager.snapshot(requireString(params, "sessionId"));
    },

    [SESSION_METHODS.save]: async (params): Promise<SessionSaveResult> => {
      return await manager.save(requireString(params, "sessionId"));
    },
  };
}

/** 取必填字符串参数；缺失/类型不对 → 带 `bad-params` 码的错（守护进程原样回给客户端） */
function requireString(params: unknown, field: string): string {
  const value = (params as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw badParams(`missing or invalid "${field}"`);
  }
  return value;
}

function requireNumber(params: unknown, field: string): number {
  const value = (params as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw badParams(`missing or invalid "${field}"`);
  }
  return value;
}

function optionalString(params: unknown, field: string): string | undefined {
  const value = (params as Record<string, unknown> | null | undefined)?.[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw badParams(`invalid "${field}"`);
  }
  return value;
}

function badParams(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = "bad-params";
  return error as Error & { code: string };
}
