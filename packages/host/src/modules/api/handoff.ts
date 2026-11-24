import { z } from "zod";

import type { HostApiDeps } from "./deps.js";
import type { Trpc } from "./trpc.js";

const sessionIdParams = z.object({ sessionId: z.string().min(1) });
const sessionIdResult = z.object({ sessionId: z.string() });

/**
 * 交接的执行者（两种写法，`PRD.md` 4.4 那张表）：`self` 是这段会话自己的 agent 接着写，`summary`
 * 是另起一个一次性 Agent 拿记忆的副本去写。
 */
const handoffMode = z.enum(["self", "summary"]);

/**
 * 这次交接是哪档（见 `HandoffKind`）：`document` 只写文档，`swap` 写完再把记忆换掉。
 *
 * 不给时是 `swap`：这一格加进来之前，这一条 procedure 做的就是「写文档 + 换手」，没开口的调用方
 * 拿到的必须还是同一件事。
 */
const handoffKind = z.enum(["document", "swap"]);

/**
 * 交接在线上只有两个动作：开跑与取消，各一条 procedure，不合成一条「切换交接态」——它们碰开关的
 * 方向相反（取消要关、开跑一点也不碰），合并之后调用方必须再告诉宿主「这一次是哪种」，那等于把两
 * 件事塞进一个参数。
 *
 * 收口（`HandoffService.finish`）不在线上：它是宿主在后台那一趟跑完之后自己走的一步。放出来给
 * 客户端调，后台还在跑时一次调用就把开关开了、交接态也摘了，而记忆要等那一趟跑完才换 —— 这段时间
 * 落进来的话会随旧记忆一起进存档。
 */
export function handoffRouter(deps: HostApiDeps, api: Trpc) {
  const { procedure } = api;

  return api.router({
    /**
     * 开跑。它回得快与交接跑得快不快无关：交接是一次完整的模型调用，所以这一手只表示「交接开始
     * 了」，收口看 `session.handoff` 那一对事件，做不成有一条失败通知。
     *
     * `mode` 是调用方显式挑的执行者，与「申请这个、拿回来那个」的降级不是一回事：独立摘要
     * （另起一个一次性 Agent 去写）本来就由用户说了算。
     *
     * **不给 `mode` 就先问一次**（{@link HandoffService.startAsked}）：手动两条命令都不再自带一
     * 套三选一，出题只有宿主这一处 —— 与阈值撞线时那一道是**同一份题、同一套文案**。题一出来这一
     * 条就回去：用户点完选项之后那一趟才真正开跑，回执等的是「开始了」，不是「人选完了」。
     *
     * `kind` 分两档：只写文档那一档做完之后会话里什么都没变（记忆、存档会话、Agent 身份都不动），
     * 只多一条带路径的通知；换手那一档把旧记忆变成另一段存档会话。
     */
    start: procedure
      .input(
        z.object({
          sessionId: z.string().min(1),
          mode: handoffMode.optional(),
          kind: handoffKind.optional(),
        }),
      )
      .output(sessionIdResult)
      .mutation(({ input }) => {
        if (input.mode === undefined) {
          // 判据先在**请求里**判一遍：这一段跑不了（还在回答 / 已经在交接 / 没有活 Agent）就当场
          // 拒，题还没出，客户端拿得到理由。之后那一趟不等结果 —— 等人答是界面上的事
          deps.handoff.assertStartable(input.sessionId);
          void deps.handoff.startAsked(input.sessionId, { kind: input.kind });
        } else {
          deps.handoff.start(input.sessionId, { mode: input.mode, kind: input.kind });
        }
        return { sessionId: input.sessionId };
      }),

    /**
     * 用户按了停。掐断后台那一趟，并把开关关着 —— 回滚之后就该停在那一段，开开关等于替用户按了
     * 「继续」。这一次调用之后这一段不会再自己动，除非用户另行开开关。
     */
    cancel: procedure
      .input(sessionIdParams)
      .output(sessionIdResult)
      .mutation(({ input }) => {
        deps.handoff.cancel(input.sessionId);
        return { sessionId: input.sessionId };
      }),
  });
}
