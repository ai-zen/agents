import { AgentNS, type InnerLoopContext } from "@ai-zen/agents-core";
import { ContextGuardPlugin, type ContextGuardOptions } from "@ai-zen/agents-sdk";

import type { Translator } from "../i18n/index.js";
import type { NoticeService } from "../notice/service.js";

/**
 * 撞硬线那条通知的码。客户端按它做条件判断（比如把这条挪到输入框上方），文案改几次这一格不动。
 */
export const GUARD_BLOCKED_NOTICE_CODE = "guard_blocked";

export interface GuardNoticeDeps {
  /** 这一段会话的 id：通知挂在它名下，删掉这一段时它跟着没 */
  readonly sessionId: string;
  readonly notices: NoticeService;
  readonly t: Translator;
  /** 会话行还在不在。行已经没了还往这个 id 上挂通知会撞外键 */
  readonly sessionExists: () => boolean;
  /** 推通知失败的去处（宿主日志）：这条路在插件的钩子里，没有人接得住异常 */
  readonly onError: (error: unknown, what: string) => void;
}

/**
 * 硬线那一颗护栏，外加一句说给用户听的话。
 *
 * 护栏自己只交出一句英文的拒绝理由 —— 那是写给模型与日志的，客户端拿到的是「它没动」：这一段
 * 会话一个字没多，界面上看不出是为什么。撞线是用户能改的事（换模型、调高阈值、新开一段会话），
 * 所以拒的那一刻在这里翻成一条会话内通知，把用量与阈值写成数字。
 *
 * 继承而不是包一层：这条路上装的仍然是同一颗护栏，判定一行都不重写；宿主要加的只是「拒了之后
 * 说一句」。
 *
 * 只在撞线那一刻说，不订阅任何事件流：拒本来就是一拍，一秒里不会来第二次。连着拒（用户不改阈值、
 * 接着说话）时同样的两个数只说一条 —— 提示栏位有限，逐次刷屏会把别的通知盖掉；护栏放行过一次
 * 之后就当「重新开始」，下次再撞说新的那一条。
 */
export class GuardNoticePlugin extends ContextGuardPlugin {
  /** 上一次推出去的那一对数：数与阈值都没变就是同一条线上的同一次撞线 */
  private reported: { readonly used: number; readonly guard: number } | undefined;

  constructor(
    private readonly deps: GuardNoticeDeps,
    /** 护栏判据那一份，按引用存下：`guardTokens` 是取值函数，每次判定现读 */
    private readonly guard: ContextGuardOptions,
  ) {
    super(guard);
  }

  /**
   * 先让护栏判，再决定要不要说：放行等于这一段的输入又回到线下，把上一次那一条忘掉。
   *
   * 拒的时候返回的仍是护栏那一句 —— 调用方（core）拿它当「这一次请求不发」的判决，这里一个字
   * 都不改；抛错则会让整个循环终止（agent 此后投递进去也不动），那是另一件事。
   */
  async onInnerLoopStart(ctx: InnerLoopContext): Promise<string | undefined> {
    const denied = await super.onInnerLoopStart(ctx);

    if (denied === undefined) {
      this.reported = undefined;
      return undefined;
    }

    this.report(ctx.agent);
    return denied;
  }

  private report(agent: { readonly messages: readonly AgentNS.Message[] }): void {
    // 没有用量时护栏不会拒（首条请求之前），走不到这里；真走到了也只是不说，不拿 0 编一句话
    const used = lastPromptTokens(agent);
    if (used === undefined) return;

    // 阈值每次现读：改阈值不重建 Agent，用户刚调到线下的那一次不该还说旧数字
    const guard = this.guard.guardTokens;

    if (this.reported?.used === used && this.reported.guard === guard) return;
    this.reported = { used, guard };

    try {
      // 会话在拒的这一刻被删掉了：那段会话已经不在了，也就没有要告知的人
      if (!this.deps.sessionExists()) return;

      this.deps.notices.push({
        level: "warning",
        code: GUARD_BLOCKED_NOTICE_CODE,
        sessionId: this.deps.sessionId,
        // 永久留到用户自己清：不改阈值、不换模型，下一句话还是拒，这条得有机会读到
        durationMs: null,
        message: this.deps.t(
          "这一次请求没有发出去：上一次请求的输入用了 {used} tokens，超过了防护阈值 {guard}。换模型、调高防护阈值或者新开一段会话之后可以接着试。",
          { used, guard },
        ),
      });
    } catch (error) {
      this.deps.onError(error, "guard-notice");
    }
  }
}

/**
 * 上一次请求带上去了多少输入 —— 只从消息上读。core 收流时把响应的 `usage` 钉在那条 AgentDefinition 消息上，
 * 于「这一次请求会带多大的输入」这个读数只有这一个来源。
 *
 * 与护栏读的是同一份事实、同一个读法（最近一条带用量的 AgentDefinition 消息，不是求和）：宿主不另存一份用量。
 */
function lastPromptTokens(agent: {
  readonly messages: readonly AgentNS.Message[];
}): number | undefined {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const message = agent.messages[i];
    if (message === undefined || message.role !== AgentNS.Role.Assistant) continue;
    const promptTokens = message.usage?.prompt_tokens;
    if (typeof promptTokens === "number") return promptTokens;
  }
  return undefined;
}
