import type { Agent, AgentNS } from "@ai-zen/agents-core";

/**
 * 「跑一次」的测试件 —— 新 core 没有 `send()` 之后，用例里那句 `await agent.sendAndWait(text)`
 * 的等价物只有一条路：**起 → 投 → 等闲**（`CORE.md` §1「投递的两个口子」）。
 *
 * 为什么不直接 `runOnce()`：`runOnce` 只给 `lifetime: "one-shot"` 的 agent 用，而且跑完
 * 就死透（复活 = 新建）。用例里的大多数 agent 是常驻的、要连跑多次（多次会话、插件在
 * 第二次请求的行为），所以这里走常驻那条路：`start()` + `push()` + 订阅 `state` 等闲。
 *
 * `start()` 幂等（已起来就返回同一句 promise），所以同一次可以反复调；收尾别忘了
 * {@link stopAgent} —— 「到死才 resolve」的那句 promise 得有人等它。
 */

/** 轮询等到条件成立（不固定 sleep；超时就抛，不让用例挂死） */
export async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("until: 等待条件成立超时");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * 往常驻 agent 投一条用户消息并等这一批跑完（外循环回到「等」）。
 *
 * 返回 `agent.messages` 本身（活对象，不拷贝）。
 *
 * 等的做法与 `HandoffService` 里那处一致：先订阅 `state`，再 `push` —— `push` 之后状态
 * 已经变了，晚一步订阅就错过「这一批开始了」那一拍，随后第一次报闲会被当成「我这一次跑完了」。
 */
export async function runRound(
  agent: Agent,
  content: AgentNS.MessageContent,
): Promise<AgentNS.Message[]> {
  void agent.start();

  const idle = new Promise<void>((resolve) => {
    let sawWorking = false;
    const offs: Array<() => void> = [];
    offs.push(agent.on("state:working", () => void (sawWorking = true)));
    offs.push(
      agent.on("state:idle", () => {
        if (!sawWorking) return;
        for (const off of offs.splice(0)) off();
        resolve();
      }),
    );
  });

  agent.send({ content, priority: "low", source: { kind: "user" } });
  await idle;
  return agent.messages;
}

/** 关门并等死透（`start()` 的那句 promise 到死才 resolve） */
export async function stopAgent(agent: Agent): Promise<void> {
  const death = agent.start();
  agent.stop();
  await death;
}

/**
 * 「跑一次就收工」：{@link runRound} + {@link stopAgent}。
 *
 * 这是 `await agent.sendAndWait(text)` 最接近的替换（老 `send` 也是「发出去、等这一段跑完、返回
 * messages」）。**只适用于不需要接着跑的用例** —— 多次会话要用 {@link runRound}。
 */
export async function sendRound(
  agent: Agent,
  content: AgentNS.MessageContent,
): Promise<AgentNS.Message[]> {
  const messages = await runRound(agent, content);
  await stopAgent(agent);
  return messages;
}
