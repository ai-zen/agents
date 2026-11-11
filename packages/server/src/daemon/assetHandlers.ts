/**
 * 资产清单的服务端入口 —— `asset.list` 的接线。
 *
 * 与其它 handler 同一个分工：**这一层只做参数形状校验**（字段在不在、取值是不是那两个
 * 之一），碰磁盘的判断（工作区存不存在、目录里有什么）留给 `AssetService`。
 *
 * 唯一一条"语义"校验留在这一层，因为它是**不用碰磁盘就能判的漏参数**：`scope: "project"`
 * 却不给 `workspaceId`。项目层资产挂在工作区路径上，没有工作区就没有「项目」可言 ——
 * 这不是空清单，是调用方漏了东西（客户端得改请求），所以是 `bad-params`。
 */

import type { MethodHandler } from "./Daemon.js";
import { badParams, field, optionalString } from "./params.js";
import type { AssetListResult, AssetKind, AssetScope } from "../protocol/index.js";

import type { AssetService } from "../domain/asset/AssetService.js";

export interface AssetHandlerOptions {
  service: AssetService;
}

export function createAssetHandlers(options: AssetHandlerOptions): Record<string, MethodHandler> {
  return {
    ["asset.list"]: async (params): Promise<AssetListResult> => {
      const kind = requireKind(params);
      const scope = optionalScope(params);
      const workspaceId = optionalString(params, "workspaceId");

      // 项目层挂在工作区路径上：没有 workspaceId，「项目」无从谈起（不是空清单，是漏参数）
      if (scope === "project" && !workspaceId) {
        throw badParams(`"workspaceId" is required when scope is "project"`);
      }

      return await options.service.list({ kind, scope, workspaceId });
    },
  };
}

/**
 * 资产类别：只认两个取值。
 *
 * 不猜（比如把 `"skills"` 当 `"skill"`）：猜错了客户端会得到一份「看起来成功、其实是另一类」
 * 的清单，而它没有任何办法发现这一点。
 */
function requireKind(params: unknown): AssetKind {
  const value = field(params, "kind");
  if (value !== "skill" && value !== "tool") {
    throw badParams(`missing or invalid "kind" (expected skill | tool)`);
  }
  return value;
}

/** 作用域：缺省 `undefined` = 两层都列（缺省值只这一处，与协议注释一致） */
function optionalScope(params: unknown): AssetScope | undefined {
  const value = field(params, "scope");
  if (value === undefined || value === null) return undefined;
  if (value !== "global" && value !== "project") {
    throw badParams(`invalid "scope" (expected global | project)`);
  }
  return value;
}
