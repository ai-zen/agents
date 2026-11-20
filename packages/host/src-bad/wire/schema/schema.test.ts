/**
 * 入参 schema 的**棘轮**（ratchet）：只许往前走。
 *
 * 「入参形状」的唯一真相在 `wire/schema/`（表见 {@link PARAM_SCHEMAS}，执行点在 `WsHub.invoke`）。
 * 现在是**全部 68 个方法**都有 schema —— 包括没有入参的那几个（它们拿 `z.object({})`，于是
 * `params: 42` 在边界上就被拒，而不是被静默当成「没给」）。
 *
 * 棘轮守的是「以后别掉队」：
 *   - 表里的每一个键都必须是真方法名（写错一个字不会被悄悄忽略）；
 *   - `METHOD_NAMES` 里的每一个都必须在这张表里（新加方法而忘了写 schema，这里当场红）；
 *   - 反过来，表里多出一个已下线的方法也红。
 *
 * 迁移期那套 `PENDING` 已经清空并删掉了：那个机制完成了它的用处 —— 让「迁了一半」是个稳定
 * 状态。现在只剩一条要求：全都要有。
 */

import { describe, expect, it } from "vitest";

import { METHOD_NAMES } from "../methods.js";
import {
  agentDeleteParams,
  agentListParams,
  configSetDefaultsParams,
  PARAM_SCHEMAS,
  sessionPinParams,
  sessionRenameParams,
  sessionSetThresholdsParams,
  sessionStartParams,
  workspaceRenameParams,
} from "./index.js";

/** 已经挂上 schema 的方法名（`PARAM_SCHEMAS` 的键） */
const MIGRATED: readonly string[] = Object.keys(PARAM_SCHEMAS);

describe("入参 schema 的棘轮（每个方法都得有，少一个就红）", () => {
  it("表里的每个键都是真方法名", () => {
    const unknown = MIGRATED.filter(
      (method) => !(METHOD_NAMES as readonly string[]).includes(method),
    );
    expect(unknown).toEqual([]);
  });

  it("方法表里的每一个方法都有 schema（新加方法忘了写，这里红）", () => {
    const missing = METHOD_NAMES.filter(
      (method) => !(MIGRATED as readonly string[]).includes(method),
    );
    expect(missing).toEqual([]);
    expect(MIGRATED).toHaveLength(METHOD_NAMES.length);
  });
});

describe("形状与文案（reason 是既有的词，不是 Zod 的英文句子）", () => {
  it("`session.start`：会话 id 非空；根上不是对象时报 not_an_object", () => {
    expect(sessionStartParams.safeParse({ sessionId: "s-1" }).success).toBe(true);
    // 两侧空白不算内容，且顺手归一化掉
    expect(sessionStartParams.parse({ sessionId: "  s-1  " })).toEqual({ sessionId: "s-1" });

    const empty = sessionStartParams.safeParse({ sessionId: "" });
    expect(empty.success).toBe(false);
    expect(empty.error?.issues[0]?.message).toBe("empty");
    expect(empty.error?.issues[0]?.path).toEqual(["sessionId"]);

    // 少了整个字段与「不是对象」都落在同一个理由上（服务层原来也是这么归的）
    expect(sessionStartParams.safeParse({}).error?.issues[0]?.message).toBe("empty");
    const notObject = sessionStartParams.safeParse(null);
    expect(notObject.error?.issues[0]?.message).toBe("not_an_object");
    expect(notObject.error?.issues[0]?.path).toEqual([]);
  });

  it("`agent.delete`：id 要是能做文件名的那种；`dryRun` 只认布尔", () => {
    expect(agentDeleteParams.safeParse({ agentId: "writer" }).success).toBe(true);
    expect(agentDeleteParams.safeParse({ agentId: "sub.one", dryRun: true }).success).toBe(true);

    const badName = agentDeleteParams.safeParse({ agentId: "a b" });
    expect(badName.error?.issues[0]?.message).toBe("not_a_file_name");
    expect(agentDeleteParams.safeParse({ agentId: ".." }).error?.issues[0]?.message).toBe(
      "not_a_file_name",
    );

    const badDryRun = agentDeleteParams.safeParse({ agentId: "writer", dryRun: "yes" });
    expect(badDryRun.error?.issues[0]?.message).toBe("not_boolean");
  });

  it("没有入参的方法也是形状：空对象可以，别的都拒", () => {
    expect(agentListParams.safeParse({}).success).toBe(true);
    expect(agentListParams.safeParse(undefined).error?.issues[0]?.message).toBe("not_an_object");
    expect(agentListParams.safeParse(42).error?.issues[0]?.message).toBe("not_an_object");
  });

  /**
   * 下面这几条：原来都是服务层自己判的，第三波删了它们之后，同一个事实必须在这里有断言
   * —— 否则就变成「只有 schema 定义、没有用例」。
   */
  it("`config.setDefaults` 的 language 只认支持的那两门", () => {
    expect(configSetDefaultsParams.safeParse({ defaults: { language: "zh" } }).success).toBe(true);
    // 写 null = 清掉这一项
    expect(configSetDefaultsParams.safeParse({ defaults: { language: null } }).success).toBe(true);

    const bad = configSetDefaultsParams.safeParse({ defaults: { language: "fr" } });
    expect(bad.error?.issues[0]?.message).toBe("not_a_language");
    expect(bad.error?.issues[0]?.path).toEqual(["defaults", "language"]);
  });

  it("`session.setThresholds` 的阈值是正整数，省略与 null 是两件事", () => {
    expect(
      sessionSetThresholdsParams.safeParse({ sessionId: "s-1", handoffThreshold: 1000 }).success,
    ).toBe(true);
    expect(
      sessionSetThresholdsParams.safeParse({ sessionId: "s-1", handoffThreshold: null }).success,
    ).toBe(true);
    expect(sessionSetThresholdsParams.safeParse({ sessionId: "s-1" }).success).toBe(true);

    for (const bad of [0, -1, 1.5]) {
      expect(
        sessionSetThresholdsParams.safeParse({ sessionId: "s-1", handoffThreshold: bad }).error
          ?.issues[0]?.message,
      ).toBe("not_positive_integer");
    }
  });

  it("`session.pin` 的 pinned 必填且只认布尔；`session.rename` 的名字剥空白后不许空", () => {
    expect(sessionPinParams.safeParse({ sessionId: "s-1", pinned: true }).success).toBe(true);
    expect(
      sessionPinParams.safeParse({ sessionId: "s-1", pinned: "yes" }).error?.issues[0]?.message,
    ).toBe("not_boolean");
    expect(sessionPinParams.safeParse({ sessionId: "s-1" }).error?.issues[0]?.message).toBe(
      "not_boolean",
    );

    expect(sessionRenameParams.parse({ sessionId: "s-1", name: "  我的会话  " })).toEqual({
      sessionId: "s-1",
      name: "我的会话",
    });
    expect(
      sessionRenameParams.safeParse({ sessionId: "s-1", name: "   " }).error?.issues[0]?.message,
    ).toBe("empty");
  });

  it("`workspace.rename` 的名字不许空（剥完空白之后）", () => {
    expect(workspaceRenameParams.safeParse({ workspaceId: "w-1", name: "  项目  " }).success).toBe(
      true,
    );
    expect(
      workspaceRenameParams.safeParse({ workspaceId: "w-1", name: "   " }).error?.issues[0]
        ?.message,
    ).toBe("empty");
  });
});
