/**
 * 配置与管理面的守护进程入口 —— 薄薄一层：只做参数校验 + 转调 `ConfigService`。
 *
 * 风格与 `sessionHandlers.ts` 一致（那边也是「校验 + 转调」，业务在 `SessionManager`）：
 * 分开的理由是可测性 —— 服务层用临时目录测完全部落盘逻辑，这里只需要证明
 * 「线上来的 `unknown` 被按形状验过、然后原样进了服务层」。
 *
 * ## 校验的边界划在哪
 *
 * 这里只校验**协议层能判定的东西**：字段在不在、类型对不对、枚举是不是那两个值。
 * 「工作区存不存在」这类要碰磁盘的判断留在服务层（它有路径，也可能以后换实现）——
 * 在本层再查一次就等于同一个规则写在两处，改一处必忘另一处。
 *
 * ## 为什么 `config` 在这里被断言成 SDK 类型
 *
 * 协议层刻意用 `unknown`（客户端不该为了一份形状去装 SDK）。把 `unknown` 变成
 * `AppConfig` 必须发生在**某个**边界上，而 handler 正是那个边界：
 * 它是唯一同时看得见线上帧与服务层类型的地方。放服务层做，等于让服务层的每个方法
 * 都重新断言一次自己收到的参数 —— 分散的 `as` 比集中的一处更难审。
 * （`agent.save` 的 `definition` 同理，见 `agentHandlers.ts` 的 `requireDefinition`。）
 */

import type { MethodHandler } from "./Daemon.js";
import { badParams, field, optionalString, requireObject, requireString } from "./params.js";
import type { ConfigService } from "../domain/config/ConfigService.js";
import type { AppConfig } from "@ai-zen/agents-sdk";
import {
  CONFIG_METHODS,
  type ConfigGetResult,
  type ConfigMcpGetResult,
  type ConfigMcpSaveResult,
  type ConfigReasoningPresetsResult,
  type ConfigSaveResult,
  type ConfigSetDefaultAgentResult,
  type ConfigSetDefaultModelResult,
  type McpScope,
} from "@ai-zen/agents-protocol";

export interface ConfigHandlerOptions {
  config: ConfigService;
}

export function createConfigHandlers(options: ConfigHandlerOptions): Record<string, MethodHandler> {
  const { config } = options;

  return {
    [CONFIG_METHODS.get]: async (): Promise<ConfigGetResult> => await config.get(),

    [CONFIG_METHODS.save]: async (params): Promise<ConfigSaveResult> => {
      // 唯一的「线上 unknown → SDK 类型」断言点（见文件头注释）
      return await config.save(requireObject(params, "config") as unknown as AppConfig);
    },

    [CONFIG_METHODS.reasoningPresets]: async (): Promise<ConfigReasoningPresetsResult> => {
      return await config.reasoningPresets();
    },

    /** 换默认 Agent：**只写一个字段**，不读整份也不写回整份（见 `ConfigService.setDefaultAgent`） */
    [CONFIG_METHODS.defaultAgentSet]: async (params): Promise<ConfigSetDefaultAgentResult> => {
      return await config.setDefaultAgent(requireString(params, "agentId"));
    },

    /** 换全局兜底模型：窄方法，理由与上面那条逐条相同（`/model --global` 用） */
    [CONFIG_METHODS.defaultModelSet]: async (params): Promise<ConfigSetDefaultModelResult> => {
      return await config.setDefaultModel(requireString(params, "modelId"));
    },

    [CONFIG_METHODS.mcpGet]: async (params): Promise<ConfigMcpGetResult> => {
      return await config.mcpGet(mcpTarget(params));
    },

    [CONFIG_METHODS.mcpSave]: async (params): Promise<ConfigMcpSaveResult> => {
      return await config.mcpSave({
        ...mcpTarget(params),
        // MCP 配置的顶层结构（`mcpServers`）由编辑屏负责；这里只保证它是个对象，
        // 别把字符串/数组写进 JSON 文件里造出一个更坏的坏文件
        config: requireObject(params, "config"),
      });
    },
  };
}

/** 作用域 + 工作区（项目作用域才带 `workspaceId`；缺不缺由服务层按作用域判） */
function mcpTarget(params: unknown): { scope: McpScope; workspaceId?: string } {
  return {
    scope: requireScope(params),
    workspaceId: optionalString(params, "workspaceId"),
  };
}

/**
 * 作用域只认两个值。
 *
 * 不在这里顺手「补默认 global」：默认值会让一个少传字段的客户端静默改错文件
 * （用户以为在编辑项目配置，实际写进了全局配置），而这种错事后极难发现。
 */
function requireScope(params: unknown): McpScope {
  const value = field(params, "scope");
  if (value !== "global" && value !== "project") {
    throw badParams(`invalid "scope" (expected global | project)`);
  }
  return value;
}
