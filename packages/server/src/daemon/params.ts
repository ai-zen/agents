/**
 * 线上参数的形状校验 —— 三个 handler 文件共用的一份。
 *
 * ## 为什么单独抽出来
 *
 * `sessionHandlers` / `agentHandlers` / `configHandlers` 各自都在验「哪个字段是必填字符串」
 * 这种同一件事，三份逐字相同的 `requireString` 与 `badParams` 只差参数名。
 * 重复的**校验规则**不是「顺手多写几行」，是同一个根因的三个副本：改判定口径（比如哪天
 * 要求字符串非空白）时，改一处忘两处，症状会表现成「这条路径的参数校验没生效」。
 *
 * ## 这里只管「形状」，不管「语义」
 *
 * 本文件全部是**协议层能判定的东西**：字段在不在、类型对不对。要碰磁盘的判断（工作区存不
 * 存在、存档在不在）留在服务层 —— 它才有路径，将来也可能换实现。在本层再查一次，就是
 * 同一个规则写在两处。
 *
 * ## 错误一律带 `bad-params` 码
 *
 * 守护进程把错误帧原样回给客户端，客户端靠 `code` 决定是「我传错了」还是「服务端出事了」。
 * 不带码的错误在界面上只能显示成一句笼统的失败。
 */

import type { CodedError } from "../protocol/index.js";
import { codedError } from "../wire/errors.js";

/** 取原始字段（不做任何判定，供本文件与外部的可选枚举校验复用） */
export function field(params: unknown, name: string): unknown {
  return (params as Record<string, unknown> | null | undefined)?.[name];
}

/**
 * 参数不合法（`bad-params` 是客户端唯一需要区分的那一类：它得改请求，不是重试）。
 *
 * `codedError` 只有**协议包的一份**（`src/protocol/` 的 `errors.ts`）：错误码是
 * 线上事实，多一份拷贝就是多一处可能写错码的地方。
 */
export function badParams(message: string): CodedError {
  return codedError("bad-params", message);
}

/** 取必填字符串参数 */
export function requireString(params: unknown, name: string): string {
  const value = field(params, name);
  if (typeof value !== "string" || value.length === 0) {
    throw badParams(`missing or invalid "${name}"`);
  }
  return value;
}

/** 取必填整数参数（`session.rollback` 的消息下标是唯一一个数字参数） */
export function requireNumber(params: unknown, name: string): number {
  const value = field(params, name);
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw badParams(`missing or invalid "${name}"`);
  }
  return value;
}

/**
 * 取可选布尔参数（`session.create` 的 `persist` / `session.save` 的 `setAsLast`）。
 *
 * 缺省 `undefined` = 「没给」，由服务层按各自的旧行为取值 —— 不是 `false`。
 * 不用 `Boolean(x)`：那样字符串 `"false"` 会变成 `true`，而这两个参数的错法都会静默写错存档。
 */
export function optionalBoolean(params: unknown, name: string): boolean | undefined {
  const value = field(params, name);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw badParams(`invalid "${name}"`);
  }
  return value;
}

/**
 * 取可选字符串参数。
 *
 * `undefined` 与 `null` 都当「没给」（JSON 里两者都是「这个字段没内容」）；给了就必须是
 * 非空字符串 —— 空串不是「没给」，是这个字段被写坏了。
 */
export function optionalString(params: unknown, name: string): string | undefined {
  const value = field(params, name);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw badParams(`invalid "${name}"`);
  }
  return value;
}

/**
 * 取一个必填的对象参数。
 *
 * 只验「是个对象」，**不看字段**：`config` / `definition` 的形状归 SDK 定义，handler 不解释
 * （见 `src/protocol/` 的 `config.ts` 头注释）。数组与 `null` 都不算对象 —— 它们在后面的服务层
 * 会表现成更难懂的失败。
 */
export function requireObject(params: unknown, name: string): Record<string, unknown> {
  const value = field(params, name);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badParams(`missing or invalid "${name}"`);
  }
  return value as Record<string, unknown>;
}
