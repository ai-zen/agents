/**
 * 端到端集成验收：真 `node` 子进程起 `cli.js serve` + 真 `ws` 客户端，走完这一步交付的全部集成点。
 *
 * 与其它两条的分工：
 *   - `e2e.test.ts` 把服务端当库用（同进程内真监听），验的是「零件接起来能跑一轮」；
 *   - `cli.process.test.ts` 验的是命令行与进程生命周期；
 *   - 这一条验的是**交付清单上的每一项在真进程里都接上了**：握手与语言、项目 / 对话、
 *     配置（密钥掩码）/ 模型 / 助手、通知（列出 + 清掉）、问题（多端同一份 + 答完推进状态）、
 *     `@` 补全、以及重启之后数据还在。
 *
 * 两条口径与用例的做法有关：
 *   1. **不连模型**：这个环境里没有真密钥，所以不跑 `conversation.send`（那一轮的端到端由
 *      `e2e.test.ts` 用假 agent 覆盖）。
 *   2. **问题的产生方在服务端内部**：契约里没有「提一个问题」的方法（问题来自交接线、
 *      登记项目、不可撤销动作的二次确认），所以这一条用例在进程之间用同一个库把一行问题
 *      写进去 —— 库文件是真的，读它的是真进程。
 */

import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isError, isSuccess, TestClient, wait } from "./net/TestSupport.js";
import { QuestionService } from "./services/QuestionService.js";
import type { QuestionRepository } from "./storage/QuestionRepository.js";
import { Database, QuestionRepository as QuestionRepositoryClass, migrate } from "./storage/index.js";
import type {
  AgentListResult,
  CompletionFilesResult,
  ConfigGetResult,
  ConfigPatchResult,
  ConversationCreateResult,
  ConversationGetResult,
  ConversationListResult,
  ConversationSendResult,
  ModelListResult,
  NoticeListResult,
  QuestionAnswerResult,
  QuestionListResult,
  ServerHelloResult,
  WorkspaceCreateResult,
  WorkspaceListResult,
} from "./wire/index.js";

/** 包根（`src/` 的上一级）：不读进程工作目录，从本文件的 URL 推 */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 产物放一个独立目录：命令行那条用例自己也跑 tsc，两边不抢同一份 `dist/` */
const BUILD_DIR = join(PACKAGE_ROOT, ".dist-it");
const CLI_ENTRY = join(BUILD_DIR, "cli.js");

/** 假端点：不连模型，密钥只要够长就能看出掩码（`sk-fake-integration-key`） */
const ENDPOINT_KEY = "sk-fake-integration-key";
const CONFIG = JSON.stringify(
  {
    endpoints: [
      {
        id: "fake",
        name: "Fake Endpoint",
        baseUrl: "https://example.invalid/v1",
        apiKey: ENDPOINT_KEY,
      },
    ],
    models: [
      {
        id: "test-model",
        name: "Test Model",
        endpointId: "fake",
        tokenThresholds: { handoff: 1000, guard: 2000 },
        custom: true,
      },
    ],
  },
  null,
  2,
);

const AGENT = JSON.stringify(
  {
    id: "default",
    name: "Test Assistant",
    description: "集成验收用的助手",
    modelId: "test-model",
    messages: [{ id: "sys-1", role: "system", status: "completed", content: "你是测试助手。" }],
    custom: true,
  },
  null,
  2,
);

interface RunningServer {
  child: ReturnType<typeof spawn>;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

const children: RunningServer[] = [];
let dataRoot = "";
let workspaceDir = "";

beforeAll(async () => {
  // 真编译一次（产物放在独立目录；并行跑的 cli.process.test.ts 用 dist/，两边不打架）
  const built = spawnSync(
    "npx",
    ["tsc", "-p", "tsconfig.json", "--outDir", BUILD_DIR],
    { cwd: PACKAGE_ROOT, encoding: "utf8", timeout: 300_000 },
  );
  await fs.access(CLI_ENTRY).catch(() => {
    throw new Error(`编译没有产出 ${CLI_ENTRY}：${built.stderr ?? ""}`);
  });

  dataRoot = await fs.mkdtemp(join(tmpdir(), "ai-zen-integration-"));
  workspaceDir = await fs.mkdtemp(join(tmpdir(), "ai-zen-integration-cwd-"));
  await fs.mkdir(join(dataRoot, "agents"), { recursive: true });
  await fs.writeFile(join(dataRoot, "config.json"), CONFIG, "utf8");
  await fs.writeFile(join(dataRoot, "agents", "default.json"), AGENT, "utf8");

  // `@` 补全读的是 git 里的文件清单（PRD D7）：这里造一个真的仓库
  await fs.writeFile(join(workspaceDir, "README.md"), "# demo\n", "utf8");
  await fs.mkdir(join(workspaceDir, "src"), { recursive: true });
  await fs.writeFile(join(workspaceDir, "src", "index.ts"), "export const a = 1;\n", "utf8");
  git(["init", "-q"]);
  git(["add", "."]);
}, 360_000);

afterAll(async () => {
  for (const running of children.splice(0)) {
    if (running.child.exitCode === null) running.child.kill("SIGKILL");
  }
  if (dataRoot !== "") await fs.rm(dataRoot, { recursive: true, force: true });
  if (workspaceDir !== "") await fs.rm(workspaceDir, { recursive: true, force: true });
  await fs.rm(BUILD_DIR, { recursive: true, force: true });
});

/** 跑一次 git（仓库是夹具，失败就直接让用例红） */
function git(args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: workspaceDir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${result.stderr}`);
}

/** 起一个真的服务端进程（`--port 0`：端口只能从发现文件读） */
function startProcess(): RunningServer {
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, "serve", "--port", "0", "--local", "--ai-zen-dir", dataRoot],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  const running: RunningServer = { child, stdout: () => out, stderr: () => err, exited };
  children.push(running);
  return running;
}

/** 等发现文件出现并读出端口与本地凭证（服务端只在监听成功之后才写它） */
async function waitForServerFile(): Promise<{ port: number; token: string }> {
  const serverFile = join(dataRoot, "run", "server.json");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const info: unknown = JSON.parse(await fs.readFile(serverFile, "utf8"));
      const port = (info as { port?: unknown }).port;
      if (typeof port === "number" && port > 0) {
        const token = (await fs.readFile(join(dataRoot, "run", "token"), "utf8")).trim();
        return { port, token };
      }
    } catch {
      // 还没写出来：继续等
    }
    await wait(50);
  }
  throw new Error(`等不到发现文件：${serverFile}`);
}

/** 打印一行阶段小结（交付报告里的实际输出就是这些行） */
function log(stage: string, detail: string): void {
  console.log(`[集成] ${stage}: ${detail}`);
}

async function connect(port: number): Promise<TestClient> {
  return await TestClient.connect(`ws://127.0.0.1:${port}/`);
}

/**
 * 发一个请求并等它的回包。
 *
 * 服务端的推送是独立帧（`notice` 这类事件可能先于回包到达 —— 配置改动就会顺手推一条），
 * 所以这里跳过通知帧，只认回包。
 */
async function callThrough(
  client: TestClient,
  method: string,
  params: unknown = {},
): Promise<unknown> {
  client.request(method, params);
  for (;;) {
    const frame = await client.queue.next(10_000);
    // 推送帧（`notice` 这类）先到也正常：跳过，等那条带 id 的回包
    if (!isSuccess(frame)) {
      if (isError(frame)) {
        throw new Error(`${method} 失败：${JSON.stringify(frame.error.data)}`);
      }
      continue;
    }
    return frame.result;
  }
}

async function stop(running: RunningServer): Promise<number | null> {
  running.child.kill("SIGTERM");
  return await running.exited;
}

/** 在进程之间往库里写一行问题（问题的产生方在服务端内部，契约里没有「提问」方法） */
async function seedQuestion(conversationId: string): Promise<string> {
  const db = new Database(join(dataRoot, "ai-zen.db"));
  try {
    await migrate(db);
    const service = new QuestionService({
      questions: new QuestionRepositoryClass(db) as QuestionRepository,
    });
    const question = await service.ask({
      conversationId,
      kind: "confirmation",
      prompt: { messageKey: "question.confirm.prompt", params: { action: "删除这个项目" } },
      options: [
        { value: "yes", label: { messageKey: "question.confirm.accept" } },
        { value: "no", label: { messageKey: "question.confirm.decline" } },
      ],
      blocking: true,
    });
    return question.id;
  } finally {
    await db.close();
  }
}

describe("端到端集成：真进程 + 真连接", () => {
  it("握手 → 项目/对话 → 配置/模型/助手 → 通知 → 问题 → 补全 → 重启后仍在", async () => {
    // =====================================================================
    // 1. 无凭证被拒 / 有凭证握手成功（含语言）
    // =====================================================================
    const first = startProcess();
    const server = await waitForServerFile();
    expect(server.port).toBeGreaterThan(0);
    expect(server.token.length).toBeGreaterThan(0);
    expect(first.stdout()).toContain("服务端已启动：ws://127.0.0.1:");

    const anon = await connect(server.port);
    anon.request("workspace.list", {});
    const beforeHello = await anon.queue.next();
    expect(isError(beforeHello)).toBe(true);
    if (isError(beforeHello)) expect(beforeHello.error.data.code).toBe("unauthorized");

    anon.request("server.hello", { clientInfo: { name: "integration", version: "0.0.0" } });
    const noToken = await anon.queue.next();
    expect(isError(noToken)).toBe(true);

    anon.request("server.hello", {
      token: "definitely-not-the-token",
      clientInfo: { name: "integration", version: "0.0.0" },
    });
    const badToken = await anon.queue.next();
    expect(isError(badToken)).toBe(true);
    if (isError(badToken)) expect(badToken.error.data.code).toBe("unauthorized");
    await anon.close();

    const client = await connect(server.port);
    const helloResult = (await callThrough(client, "server.hello", {
      token: server.token,
      language: "zh",
      clientInfo: { name: "integration", version: "0.0.0" },
    })) as ServerHelloResult;
    expect(helloResult.language).toBe("zh");
    expect(helloResult.protocolVersion).toBe("1");
    // 握手只给能力 id 列表（R57）：详细信息走 server.capabilities
    expect(helloResult.capabilities.length).toBeGreaterThan(50);
    expect(helloResult.capabilities.every((id) => typeof id === "string")).toBe(true);
    expect(helloResult.capabilities).toContain("F-C2");
    log("握手", `language=${helloResult.language} 协议=${helloResult.protocolVersion} 能力=${helloResult.capabilities.length} 条`);

    // =====================================================================
    // 2. workspace.create → conversation.create → conversation.list
    // =====================================================================
    const createdWorkspace = (await callThrough(client, "workspace.create", {
      cwd: workspaceDir,
      name: "集成验收项目",
    })) as WorkspaceCreateResult;
    const workspace = createdWorkspace.workspace;
    expect(workspace.id.length).toBeGreaterThan(0);
    expect(workspace.folder.exists).toBe(true);

    const createdConversation = (await callThrough(client, "conversation.create", {
      workspaceId: workspace.id,
      agentId: "default",
      modelId: "test-model",
    })) as ConversationCreateResult;
    if (!createdConversation.conversation) throw new Error("conversation.create 没有建出对话");
    const conversationId = createdConversation.conversation.id;
    expect(conversationId.length).toBeGreaterThan(0);

    // R56 / F-C2：空会话不落库 —— 建了不发就断线，它应该像没建过一样
    const draftGotten = (await callThrough(client, "conversation.get", {
      conversationId,
    })) as ConversationGetResult;
    expect(draftGotten.conversation.id).toBe(conversationId);
    const listBeforeSend = (await callThrough(client, "conversation.list", {
      workspaceId: workspace.id,
    })) as ConversationListResult;
    expect(listBeforeSend.total).toBe(0);
    log(
      "空会话（R56）",
      `conversation=${conversationId} get 能拿到=${String(draftGotten.conversation.id === conversationId)} 列表 total=${listBeforeSend.total}`,
    );

    // 发一条：首次 send 用同一个 id 落库（这里连不上假端点，那一轮会以失败结算，
    // 但「受理已落库」这件事与模型有没有答无关）
    const sent = (await callThrough(client, "conversation.send", {
      conversationId,
      input: { content: "你好" },
    })) as ConversationSendResult;
    expect(sent.userMessageId.length).toBeGreaterThan(0);

    const conversations = (await callThrough(client, "conversation.list", {
      workspaceId: workspace.id,
    })) as ConversationListResult;
    expect(conversations.total).toBe(1);
    expect(conversations.conversations[0]?.id).toBe(conversationId);
    expect(conversations.conversations[0]?.workspaceId).toBe(workspace.id);
    log(
      "建库对象",
      `workspace=${workspace.id} conversation=${conversationId} 发出后列表 total=${conversations.total}`,
    );

    // =====================================================================
    // 3. config.get（端点密钥是掩码）→ model.list → agent.list
    // =====================================================================
    const configResult = (await callThrough(client, "config.get", {})) as ConfigGetResult;
    const endpoint = configResult.config.endpoints[0];
    expect(endpoint?.id).toBe("fake");
    expect(endpoint?.apiKeySet).toBe(true);
    // 明文不出网（F-F2）：只有掩码，且掩码不是密钥本身
    expect(endpoint?.apiKeyMasked).not.toBe(ENDPOINT_KEY);
    expect(endpoint?.apiKeyMasked).toContain("…");
    expect(JSON.stringify(configResult)).not.toContain(ENDPOINT_KEY);
    expect(configResult.config.configDir).toBe(dataRoot);
    log("config.get", `endpoint=${endpoint?.id} apiKeyMasked=${endpoint?.apiKeyMasked} apiKeySet=${String(endpoint?.apiKeySet)}`);

    const models = (await callThrough(client, "model.list", {})) as ModelListResult;
    // 出厂托管的模型也会列出来（F-F3：不可用的也要看得见），所以按 id 找自己配的那一条
    const testModel = models.models.find((model) => model.id === "test-model");
    expect(testModel?.endpointId).toBe("fake");

    const agents = (await callThrough(client, "agent.list", {})) as AgentListResult;
    expect(agents.agents.map((agent) => agent.id)).toContain("default");
    expect(agents.defaultAgentId).toBe("default");
    log("model/agent", `models 含 test-model=${String(testModel !== undefined)} agents=${agents.agents
      .map((agent) => agent.id)
      .join(",")} default=${String(agents.defaultAgentId)}`);

    // =====================================================================
    // 4. notice.list（空）→ 触发一条通知 → 列出 → dismiss
    // =====================================================================
    const emptyNotices = (await callThrough(client, "notice.list", {})) as NoticeListResult;
    expect(emptyNotices.notices).toEqual([]);

    // 改一次配置就是「触发一条通知」：改完即生效，并且合成一条通知（F-E2 / F-F9）
    const patched = (await callThrough(client, "config.patch", {
      patch: { limits: { maxToolOutput: 4096 } },
    })) as ConfigPatchResult;
    // 上面那一轮 send 借过这个项目的 Scope（发过消息的对话按项目装配能力），
    // 于是「改配置回收受影响 Scope」这一跳回报的就是它
    expect(patched.applied.recycledWorkspaceIds).toEqual([workspace.id]);
    expect(patched.applied.noticeId).not.toBeNull();
    expect(patched.config.limits.maxToolOutput).toBe(4096);

    const withNotice = (await callThrough(client, "notice.list", {})) as NoticeListResult;
    const noticeId = patched.applied.noticeId ?? "";
    const notice = withNotice.notices.find((item) => item.id === noticeId);
    expect(notice).toBeDefined();
    expect(notice?.level).toBe("info");
    expect(notice?.text.message.length).toBeGreaterThan(0);

    const dismissed = await callThrough(client, "notice.dismiss", { noticeId });
    expect(dismissed).toEqual({ dismissed: true });
    const afterDismiss = (await callThrough(client, "notice.list", {})) as NoticeListResult;
    expect(afterDismiss.notices.map((item) => item.id)).not.toContain(noticeId);
    log("notice", `触发=${noticeId} 列出=${String(notice !== undefined)} dismiss=${
      (dismissed as { dismissed: boolean }).dismissed
    } 清后剩=${afterDismiss.notices.length}`);

    // =====================================================================
    // 6. completion.files：临时 git 仓库里能给出文件清单
    // =====================================================================
    const files = (await callThrough(client, "completion.files", {
      workspaceId: workspace.id,
      prefix: "",
    })) as CompletionFilesResult;
    // 第一次问可能还在扫（W4-G 的口径）：那就重试到 ready
    let completion = files;
    for (let attempt = 0; attempt < 40 && completion.state === "scanning"; attempt += 1) {
      await wait(100);
      completion = (await callThrough(client, "completion.files", {
        workspaceId: workspace.id,
        prefix: "",
      })) as CompletionFilesResult;
    }
    expect(completion.state).toBe("ready");
    // 空前缀：顶层一条文件一条目录（目录也算条目，`@` 菜单里能继续往下钻）
    expect(completion.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["README.md", "src"]),
    );
    expect(completion.truncated).toBe(false);

    // 带路径前缀：能筛到目录里的那个文件
    const narrowed = (await callThrough(client, "completion.files", {
      workspaceId: workspace.id,
      prefix: "src/",
    })) as CompletionFilesResult;
    expect(narrowed.state).toBe("ready");
    expect(narrowed.entries.map((entry) => entry.path)).toContain("src/index.ts");
    log("completion.files", `state=${completion.state} 顶层=${completion.entries
      .map((entry) => entry.path)
      .join(",")} prefix(src/)=${narrowed.entries.map((entry) => entry.path).join(",")}`);

    // =====================================================================
    // 5a. 问题：造一个（进程之间的那一行）→ 两次 question.list 看到同一个
    // =====================================================================
    await client.close();
    expect(await stop(first)).toBe(0);
    // 退出后发现文件被摘掉（客户端不会再指向一个不存在的进程）
    await expect(fs.access(join(dataRoot, "run", "server.json"))).rejects.toBeTruthy();

    const questionId = await seedQuestion(conversationId);

    const second = startProcess();
    const restarted = await waitForServerFile();
    // 凭证交付文件里那串不变（重启不会每次都换凭证）——端口可能被系统复用，所以不断言它变了
    expect(restarted.token).toBe(server.token);

    const windowA = await connect(restarted.port);
    await callThrough(windowA, "server.hello", {
      token: restarted.token,
      language: "zh",
      clientInfo: { name: "integration-a", version: "0.0.0" },
    });
    const windowB = await connect(restarted.port);
    await callThrough(windowB, "server.hello", {
      token: restarted.token,
      language: "en",
      clientInfo: { name: "integration-b", version: "0.0.0" },
    });

    // 多端看同一个问题（D22）：两个窗口各自拉一次，拿到的是同一行
    const listA = (await callThrough(windowA, "question.list", { conversationId })) as QuestionListResult;
    const listB = (await callThrough(windowB, "question.list", { conversationId })) as QuestionListResult;
    expect(listA.questions.map((item) => item.id)).toEqual([questionId]);
    expect(listB.questions.map((item) => item.id)).toEqual([questionId]);
    expect(listA.questions[0]?.state).toBe("pending");
    expect(listA.questions[0]?.blocking).toBe(true);
    // 同一行问题按各自连接的语言渲染（D8）
    expect(listA.questions[0]?.prompt.message).not.toBe(listB.questions[0]?.prompt.message);

    // 挡着的问题会拒掉这一轮发送（D23）
    windowA.request("conversation.send", { conversationId, input: { content: "你好" } });
    const blocked = await windowA.queue.next();
    expect(isError(blocked)).toBe(true);
    if (isError(blocked)) expect(blocked.error.data.code).toBe("question_pending");

    // 答完之后状态推进（D22 / F-I9）：另一端再拉就看不到 pending 了
    const answered = (await callThrough(windowA, "question.answer", {
      questionId,
      value: "yes",
    })) as QuestionAnswerResult;
    expect(answered.question.state).toBe("answered");
    expect(answered.question.answer?.value).toBe("yes");
    expect(answered.effects.handoffStarted).toBe(false);

    const afterAnswer = (await callThrough(windowB, "question.list", { conversationId, state: "answered" })) as QuestionListResult;
    expect(afterAnswer.questions.map((item) => item.id)).toEqual([questionId]);
    const stillPending = (await callThrough(windowB, "question.list", { conversationId, state: "pending" })) as QuestionListResult;
    expect(stillPending.questions).toEqual([]);
    log("question", `id=${questionId} pending→answered 两窗口同一行=${String(
      listA.questions[0]?.id === listB.questions[0]?.id,
    )}`);

    // =====================================================================
    // 7. 重启之后：项目 / 对话 / 已答问题 / 通知都在（数据在库里，端口换了不丢）
    // =====================================================================
    // 再触发一条通知，让它跨重启留着（永久通知只能手动清，L3）
    await callThrough(windowA, "config.patch", {
      patch: { behavior: { abortedMessageStrategy: "keep" } },
    });
    await windowA.close();
    await windowB.close();
    expect(await stop(second)).toBe(0);
    await expect(fs.access(join(dataRoot, "run", "server.json"))).rejects.toBeTruthy();

    const third = startProcess();
    const afterRestart = await waitForServerFile();
    expect(afterRestart.token).toBe(server.token);
    const back = await connect(afterRestart.port);
    await callThrough(back, "server.hello", {
      token: afterRestart.token,
      clientInfo: { name: "integration-c", version: "0.0.0" },
    });

    const workspacesAfter = (await callThrough(back, "workspace.list", {})) as WorkspaceListResult;
    expect(workspacesAfter.workspaces.map((item) => item.id)).toEqual([workspace.id]);

    const conversationsAfter = (await callThrough(back, "conversation.list", { workspaceId: workspace.id })) as ConversationListResult;
    expect(conversationsAfter.conversations.map((item) => item.id)).toEqual([conversationId]);

    const questionsAfter = (await callThrough(back, "question.list", { conversationId })) as QuestionListResult;
    expect(questionsAfter.questions.map((item) => item.id)).toEqual([questionId]);
    expect(questionsAfter.questions[0]?.state).toBe("answered");

    const noticesAfter = (await callThrough(back, "notice.list", {})) as NoticeListResult;
    // 上一条被 dismiss 掉了，这一条是重启前刚改配置产生的那一条
    expect(noticesAfter.notices.length).toBeGreaterThan(0);
    expect(noticesAfter.notices.every((item) => item.text.message.length > 0)).toBe(true);
    log(
      "重启后",
      `端口 ${server.port} → ${restarted.port} → ${afterRestart.port}；workspace=${workspacesAfter.workspaces
        .map((item) => item.id)
        .join(",")} conversation=${conversationsAfter.conversations
        .map((item) => item.id)
        .join(",")} question=${questionsAfter.questions
        .map((item) => `${item.id}:${item.state}`)
        .join(",")} notice=${noticesAfter.notices.length} 条`,
    );

    // 收尾：断连接 + 让进程自己走（最后一轮请求已经回包了）
    await back.close();
    expect(await stop(third)).toBe(0);
    await expect(fs.access(join(dataRoot, "run", "server.json"))).rejects.toBeTruthy();
  }, 180_000);
});
