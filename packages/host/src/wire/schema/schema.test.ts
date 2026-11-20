/**
 * 入参 schema 的**棘轮**（ratchet）：只许往前走。
 *
 * 这一波把「入参形状」的唯一真相搬到了 `wire/schema/`（表见 {@link PARAM_SCHEMAS}，执行点在
 * `WsHub.invoke`）。方法一共 64 个带参数的，现在只有 3 个有 schema，剩下 61 个还散在服务层里
 * 各自判 —— 这是**过渡状态**，不是终点。
 *
 * 棘轮就是用来守住这个过渡状态的：
 *   - 表里的每一个键都必须是真方法名（写错一个字不会被悄悄忽略）；
 *   - 「有参数的方法」= 已迁移 ∪ {@link PENDING}，且两边不重叠 —— 于是每迁一域，`PENDING` 就
 *     必须跟着缩一行，缩到空时这套迁移就完成了；
 *   - 反过来说：新加一个带参数的方法而忘了给它 schema，这个用例当场红 —— 没人能靠「下次再补」
 *     混过去。
 *
 * 迁完一域之后：把方法名从 `PENDING` 里删掉、在 `PARAM_SCHEMAS` 里加一行，两处同时变小。
 */

import { describe, expect, it } from "vitest";

import { METHOD_NAMES } from "../methods.js";
import { agentDeleteParams, PARAM_SCHEMAS, sessionStartParams } from "./index.js";

/**
 * 没有入参的方法：它们在方法表里写的就是 `params: NoParams`，边界上没什么可校的。
 *
 * `config.get` 不在这张表里：它的入参类型是 `ConfigGetParams`（= `NoParams` 的别名），在方法表
 * 里按「有入参的方法」写了一行。它在 `PENDING` 里待到 config 域铺开 —— 那时给它一个
 * `z.object({})`（空对象也是形状：`params: 42` 该被拒，这点今天没人管）。
 */
const NO_PARAMS_METHODS: readonly string[] = [
  "host.version",
  "host.reload",
  "agent.list",
  "model.listImages",
];

/**
 * 还没迁到 schema 上的方法名（迁一域缩一域，最后清空）。
 *
 * 顺序与方法表一致，方便对着 `METHOD_NAMES` 读。
 */
const PENDING: readonly string[] = [
  // ---- host.*：握手与进程（`hello` 自带一套 `asHelloParams`，与它一起迁）----
  "host.hello",
  "host.upgrade",
  "host.shutdown",
  "host.setLanguage",
  // ---- workspace.* ----
  "workspace.list",
  "workspace.create",
  "workspace.get",
  "workspace.rename",
  "workspace.remove",
  // ---- session.*（`start` / `pause` 已迁，见 `PARAM_SCHEMAS`）----
  "session.list",
  "session.create",
  "session.get",
  "session.state",
  "session.rename",
  "session.pin",
  "session.delete",
  "session.send",
  "session.abort",
  "session.resume",
  "session.kill",
  "session.clearInbox",
  "session.revert",
  "session.setModel",
  "session.setThinking",
  "session.setThresholds",
  "session.transient",
  // ---- message.* ----
  "message.list",
  // ---- question.* ----
  "question.list",
  "question.answer",
  // ---- notice.* ----
  "notice.list",
  "notice.dismiss",
  "notice.clear",
  // ---- config.* ----
  "config.get",
  "config.patch",
  "config.setDefaults",
  "config.getDiscovery",
  "config.saveMcp",
  "config.deleteMcp",
  "config.saveEndpoint",
  "config.deleteEndpoint",
  // ---- agent.*（`delete` 已迁）----
  "agent.get",
  "agent.create",
  "agent.update",
  "agent.setModel",
  "agent.setThinking",
  "agent.restoreFactory",
  // ---- model.* ----
  "model.list",
  "model.create",
  "model.update",
  "model.delete",
  "model.restoreFactory",
  "model.saveImage",
  "model.deleteImage",
  // ---- asset.*（上传三段，接线层自己代管 begin / end）----
  "asset.begin",
  "asset.end",
  "asset.get",
  // ---- completion.* ----
  "completion.files",
  // ---- handoff.* ----
  "handoff.start",
  "handoff.listDocuments",
  // ---- search.* ----
  "search.sessions",
  "search.messages",
];

/** 已经挂上 schema 的方法名（`PARAM_SCHEMAS` 的键） */
const MIGRATED: readonly string[] = Object.keys(PARAM_SCHEMAS);

/** 「带参数的方法」：方法表里除 `NoParams` 之外的那些 */
const PARAM_METHODS: readonly string[] = METHOD_NAMES.filter(
  (method) => !NO_PARAMS_METHODS.includes(method),
);

describe("入参 schema 的棘轮（迁一域缩一域，不许回退）", () => {
  it("表里的每个键都是真方法名", () => {
    const unknown = MIGRATED.filter(
      (method) => !(METHOD_NAMES as readonly string[]).includes(method),
    );
    expect(unknown).toEqual([]);
  });

  it("已迁移的方法不在「无入参」那张表里（有 schema 就说明它有入参要校）", () => {
    const wrong = MIGRATED.filter((method) => NO_PARAMS_METHODS.includes(method));
    expect(wrong).toEqual([]);
  });

  it("带参数的方法 = 已迁移 ∪ PENDING，且两边不重叠", () => {
    // 不重叠：同一个方法不能既迁完了又还挂在 PENDING 上（那会让棘轮失去意义）
    expect(MIGRATED.filter((method) => PENDING.includes(method))).toEqual([]);

    // 并集刚好是那 64 个带参数的方法：漏一个、多一个都红
    const union = [...MIGRATED, ...PENDING].sort();
    expect(union).toEqual([...PARAM_METHODS].sort());
    expect(union).toHaveLength(64);
  });
});

describe("第一波那三条的形状（文案是既有的 reason 词，不是 Zod 的英文句子）", () => {
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
});
