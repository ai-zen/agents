/**
 * 「本地流式增量」与「服务端快照」的合并 —— 两份数据怎么拼成一份消息列表的唯一实现。
 *
 * ## 为什么它住在共享包，而不是某个前端里
 *
 * 两个前端（CLI 的 TUI、桌面端）都要在**同一个时序压力**下做同一件事：一收到「这段内容开始
 * 了」就去要一次服务端快照，而这个往返可能比第一批增量帧还慢（活儿越小越明显）。合并规则
 * 于是直接决定了「屏幕上的答案会不会凭空短一截」—— 边界情形里差一个字都是 bug。抄两份就会
 * 漂：一份修好了「宁可重复也不吞字」，另一份还是「整份覆盖」，而这类漂移只在竞态里显形，
 * 手点根本点不出来。所以规则只留一份，放在两个前端都装的那个包里。
 *
 * ## 与传输无关
 *
 * 纯函数：进的是「快照那一刻的消息列表 + 本地拼到一半的状态」，出的是「该显示的消息列表 +
 * 之后的增量该继续往哪条上拼」。不碰 socket、不读时钟、不留状态、不抛错 —— 因此不挑剔调用方
 * 是 TUI 还是 Electron 主进程，也能被单测直接钉住时序（这条竞态靠真 socket 复现不了，要凑）。
 *
 * 消息形状从协议包拿（`Message`）：协议是数据模型的**唯一出口**，客户端不再直接去 core 里
 * 捞类型。类型在产物里被抹掉，所以运行期依赖图仍然只有 `@ai-zen/agents-protocol` +
 * `node:*`（见 README「产物的运行期依赖图必须闭合」）。
 */

import type { Message } from "@ai-zen/agents-protocol";

/**
 * `Role.Assistant` 的同值镜像。
 *
 * 为什么不用枚举本身：协议只**转出类型**、不转出 `Role`（它是运行期有对象的值，转出就等于
 * 把 core 拖进本包的运行期依赖图）。值写错编译器会拦 —— `Message["role"]` 与该字面量不
 * 重叠时报 TS2367；用例那边又用真的 `AgentNS.Role.Assistant` 造数据，两处一起把这个值钉死。
 *
 * 导出是给同目录之外的纯状态机（`session/stream.ts`）用的：它也必须在运行期知道「哪条是
 * assistant」，而本包不能为了一个字符串去 import core。**这份镜像只许有一份** —— 所以它在
 * 这里导出，而不是在那边再抄一遍。
 */
export const ROLE = { Assistant: "assistant" } as const;

/**
 * 本地拼接状态（一段流式内容一条）。
 *
 * 与「主 Agent 那条正在流式的临时消息」同形状、同策略：增量先拼在一条临时消息上让屏幕能滚
 * 起来，权威内容以服务端快照为准。差别只在**一段流式内容只拼一条**：这期间它可能有多轮
 * assistant（工具调用），拆成多条会让输出断成几段；而主 Agent 那边也是这么拼的 —— 一轮收尾
 * 时整份清空，不存在「拼错了要修」的问题。
 */
export interface StreamedAssistant {
  /** 临时消息：同时也是调用方消息列表里的那一条（增量就地改它，屏幕才跟得上） */
  message: Message;
  /** 累计正文（= `message.content`，单独存一份，省得每次从联合类型里往外捞） */
  text: string;
  /** 累计推理内容（推理模型才有） */
  reasoning: string;
}

/**
 * 把服务端快照与本地已拼出的增量合并成一份消息列表 —— 「快照与增量怎么合并」的唯一实现。
 *
 * ## 为什么不能直接拿快照替换
 *
 * 调用方一收到「这段内容开始了」就去要快照，但这个往返可能比第一批增量帧还慢（活儿越小越
 * 明显）。`messages = snapshot.messages` 会把这几片已经上屏的正文换回快照那一刻的旧内容 ——
 * 屏幕上是「答案忽然短了一截」，而且本轮不会再补上。反过来，快照里的东西也不能丢：工具调用、
 * 已完成的 assistant 消息只有服务端有。
 *
 * ## 为什么「本地更全」是安全的假设
 *
 * 同一条连接上的帧是有序的：快照是服务端处理请求那一刻的**副本**，之后到达的增量只存在于
 * 本地。所以合并方向永远是「取信息多的那份」，不必担心本地这份更旧。
 *
 * ## 规则
 *
 * 1. 本地没有增量 → 直接用快照（大多数情况：刚开始时还没有字）。
 * 2. 快照末尾那条 assistant 的正文与本地累计正文**互为前缀** → 它们是同一段（core 在流式
 *    开始前就把占位消息追加进了 `messages`，之后就地改它）。取信息多的那份，并让后续
 *    增量继续拼在这一条上 —— 否则同一段会被拆成两条消息在屏幕上闪。两个方向都要认：
 *      · 本地是快照的后缀（`stream.text.startsWith(tailText)`）：本地更全，取本地的；
 *      · 本地是快照的前缀（`tailText.startsWith(stream.text)`）：**快照更全**，取快照那条。
 *    只认第一个方向时，第二个方向会一路落到第 3 条的对不上分支，屏幕上末尾多出一条
 *    内容为「答」的 assistant 消息（一轮里前半句上屏两遍）。
 * 3. 否则快照末尾不是「正在拼的那一段」：用「服务端已知 assistant 正文按序拼接」对齐，只接
 *    上多出来的尾巴 ——
 *      · 本地以它开头：那截尾巴是快照序列化之后才到的新一段，接在后面；
 *      · 本地是它的结尾：这一段服务端已经收下了（内容块形态的 assistant 落在这一支），丢掉
 *        本地；
 *      · 都对不上：宁可重复也不吞字 —— 重复看得见，吞了是静默丢内容。
 *
 * 导出给两个前端用；它同时是这条竞态**唯一能被单测钉住**的地方 —— 真 socket 复现不了
 * （要凑时序），而它恰恰是最容易写错的那十几行。
 */
export function mergeStreamedSnapshot(
  snapshot: readonly Message[],
  stream: StreamedAssistant | null,
): { messages: Message[]; stream: StreamedAssistant | null } {
  const base = [...snapshot];
  if (!stream || (!stream.text && !stream.reasoning)) return { messages: base, stream };

  const tail = base.at(-1);
  const tailText =
    tail && tail.role === ROLE.Assistant && typeof tail.content === "string" ? tail.content : null;

  // 规则 2 的第一个方向：同一段，本地更全
  if (tailText !== null && stream.text.startsWith(tailText)) {
    const merged = withAssistantText(tail!, stream.text, stream.reasoning);
    base[base.length - 1] = merged;
    return { messages: base, stream: { ...stream, message: merged } };
  }

  /**
   * 规则 2 的第二个方向：同一段，**服务端更全**（本地只是它的一段前缀）。
   *
   * 为什么必须有这一支：本地的「答」的每个字都在快照的「答完了」里，所以丢掉本地不会
   * 丢内容；但**识别不出**这层关系就会掉到第 3 条的对不上分支 —— 那一支为了「宁可重复
   * 也不吞字」会把本地那半句整段追加成第二条 assistant 消息，屏幕上一轮里出现「答完了」
   * 后面又跟一条「答」。缺这一支时它并不报错，只在重连 / 快照比增量慢这类时序里显形。
   *
   * 拼接态**接着指向快照那条**（不是丢掉）：快照只是这一刻的副本，这一段还在流，下一片
   * 增量得拼在同一条上 —— 指回 null 会让 `applyDelta` 另起一条消息，把一段答案在屏幕上
   * 裂成两段（那正是规则 2 想避免的事）。推理取两者更长的：它与正文同帧到达但可能**先到**，
   * 本地那份比快照长时吞掉它同样是丢内容。
   */
  if (tailText !== null && tailText.startsWith(stream.text)) {
    const snapshotReasoning =
      typeof tail!.reasoning_content === "string" ? tail!.reasoning_content : "";
    const reasoning =
      snapshotReasoning.length >= stream.reasoning.length ? snapshotReasoning : stream.reasoning;
    const merged = withAssistantText(tail!, tailText, reasoning);
    base[base.length - 1] = merged;
    return { messages: base, stream: { message: merged, text: tailText, reasoning } };
  }

  // 规则 3：对齐「服务端已知的 assistant 正文」，只接上多出来的那截
  const confirmed = base
    .filter((message) => message.role === ROLE.Assistant && typeof message.content === "string")
    .map((message) => message.content as string)
    .join("");
  if (confirmed.endsWith(stream.text)) return { messages: base, stream: null };

  const rest = stream.text.startsWith(confirmed)
    ? stream.text.slice(confirmed.length)
    : stream.text;
  const appended = withAssistantText(
    { role: ROLE.Assistant, content: "" } as Message,
    rest,
    stream.reasoning,
  );
  return { messages: [...base, appended], stream: { ...stream, message: appended, text: rest } };
}

/**
 * 写一条 assistant 消息的正文/推理，其余字段（`tool_calls` 等）原样保留。
 *
 * 导出是给 `session/stream.ts` 用的：它也必须在增量到达时把正文写回那条临时消息上，
 * 而这段逻辑只该有一份 —— 两份拷贝的漂移
 * 方向很难看：只要一边忘了带 `reasoning_content`，推理模型的「想」就会在其中一个前端上
 * 整段消失，而且只在推理模型上显形。所以只留一份，放在这份合并规则旁边。
 */
export function withAssistantText(message: Message, text: string, reasoning: string): Message {
  const next = { ...message, role: ROLE.Assistant, content: text } as Message;
  if (reasoning) next.reasoning_content = reasoning;
  return next;
}
