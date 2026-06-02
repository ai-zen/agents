import chalk from "chalk";
import { Agent, AgentNS } from "@ai-zen/agents-core";
import { saveConversation } from "./conversations.js";
import { createRequire } from "module";

interface TKModule {
  terminal: any;
  TextBox: any;
  InlineInput: any;
  Document: any;
}

let tkLoaded = false;
let tkModule: TKModule = { terminal: null, TextBox: null, InlineInput: null, Document: null };

async function loadTK(): Promise<TKModule | null> {
  if (tkLoaded) return tkModule;
  let tk: any = null;

  try {
    tk = await import('terminal-kit');
    if (tk?.terminal) {
      tkModule.terminal = tk.terminal;
      tkModule.TextBox = tk.TextBox;
      tkModule.InlineInput = tk.InlineInput;
      tkModule.Document = tk.Document;
      tkLoaded = true; return tkModule;
    }
  } catch (_) {}

  try {
    const require = createRequire(import.meta.url);
    tk = require('terminal-kit');
    if (tk?.terminal) {
      tkModule.terminal = tk.terminal;
      tkModule.TextBox = tk.TextBox;
      tkModule.InlineInput = tk.InlineInput;
      tkModule.Document = tk.Document;
      tkLoaded = true; return tkModule;
    }
  } catch (_) {}

  try {
    tk = await import('terminal-kit');
    const t = tk.default || tk;
    if (t?.terminal) {
      tkModule.terminal = t.terminal;
      tkModule.TextBox = t.TextBox;
      tkModule.InlineInput = t.InlineInput;
      tkModule.Document = t.Document;
      tkLoaded = true; return tkModule;
    }
  } catch (_) {}

  return null;
}

interface ConversationContext {
  input: string;
  currentName: string;
  modelId: string;
  currentId: string | undefined;
  agentId: string | undefined;
  running: boolean;
  aborted: boolean;
}

interface ToolCallPrint {
  name: string;
  arguments: string;
  namePrinted: boolean;
  argsPrinted: boolean;
  completed: boolean;
}

interface RenderContext {
  reasoningPrinted: boolean;
  contentPrinted: boolean;
  toolPrints: Record<number, ToolCallPrint>;
}

function getMessageText(msg: AgentNS.Message): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter((s) => s.type === "text").map((s) => s.text).join("");
  }
  return "";
}

function formatToolCall(msg: AgentNS.Message): string {
  if (!msg.tool_calls?.length && !msg.function_call) return "";
  const lines: string[] = [];
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      if (tc.function) {
        lines.push(`  🔧 ${tc.function.name}: ${tc.function.arguments || ""}`);
      }
    }
  }
  if (msg.function_call) {
    lines.push(`  🔧 ${msg.function_call.name}: ${msg.function_call.arguments || ""}`);
  }
  return lines.join("\n");
}

async function runConversationTUIInternal(
  agent: Agent,
  modelId: string,
  conversationId?: string,
  conversationName?: string,
  agentId?: string,
): Promise<void> {
  const tk = await loadTK();
  if (!tk?.terminal) {
    console.error(chalk.red("❌ terminal-kit 加载失败"));
    console.error(chalk.yellow("💡 回退到普通对话模式..."));
    const { runConversation } = await import('./conversation-runner.js');
    return runConversation(agent, modelId, conversationId, conversationName, agentId);
  }

  const term = tk.terminal;
  const TextBox = tk.TextBox;
  const InlineInput = tk.InlineInput;

  if (!process.stdout.isTTY) {
    console.error(chalk.red("❌ 当前环境不是终端 (TTY)，TUI 模式无法使用"));
    console.error(chalk.yellow("💡 回退到普通对话模式..."));
    const { runConversation } = await import('./conversation-runner.js');
    return runConversation(agent, modelId, conversationId, conversationName, agentId);
  }

  const ctx: ConversationContext = {
    input: "",
    currentName: conversationName || `对话_${new Date().toISOString()}`,
    currentId: conversationId,
    modelId,
    agentId,
    running: true,
    aborted: false,
  };

  const renderCtx: RenderContext = {
    reasoningPrinted: false,
    contentPrinted: false,
    toolPrints: {},
  };

  let isStreaming = false;
  let submitHandler: ((value: string) => Promise<void>) | null = null;

  // 创建 TUI 组件
  try { await term.grabInput({ mouse: 'button' }); }
  catch (e) {
    console.error(chalk.red("❌ 无法获取终端输入"));
    console.error(chalk.yellow("💡 回退到普通对话模式..."));
    const { runConversation } = await import('./conversation-runner.js');
    return runConversation(agent, modelId, conversationId, conversationName, agentId);
  }

  term.hideCursor(true);
  const doc = term.createDocument();

  new TextBox({
    parent: doc, x: 0, y: 0,
    width: term.width, height: 1,
    content: `对话进行中: ${ctx.currentName}  |  模型: ${modelId}  |  输入 /help 查看命令`,
    textAttr: { color: 'blue', bold: true },
  });

  const outputBox = new TextBox({
    parent: doc, x: 0, y: 1,
    width: term.width,
    height: Math.max(1, term.height - 5),
    scrollable: true, hasVScrollBar: true, lineWrap: true, wordWrap: true,
    contentHasMarkup: true,
    textAttr: { color: 'white' },
    voidAttr: { color: 'white' },
    content: '',
  });

  new TextBox({
    parent: doc, x: 0, y: Math.max(0, term.height - 3),
    width: term.width, height: 1,
    content: '/stop:终止  /save:保存  /clear:清屏  /back:撤回  /exit:退出  方向键:滚动',
    textAttr: { color: 'gray' },
  });

  const inputBox = new InlineInput({
    parent: doc, x: 0, y: Math.max(0, term.height - 2),
    width: term.width, content: '',
    textAttr: { color: 'white' },
    noEmpty: false,
  });

  // ===== 输出函数 =====
  // write: 追加文本，不换行（对应原始版 process.stdout.write）
  function write(text: string) {
    if (!text) return;
    outputBox.appendContent(text);
    outputBox.scrollToBottom();
    doc.draw();
  }
  // writeln: 追加文本后换行
  function writeln(text: string = '') {
    outputBox.appendContent(text + '\n');
    outputBox.scrollToBottom();
    doc.draw();
  }

  function appendUserMsg(content: string) { writeln(`^c你^:: ${content}`); }
  function appendSystemMsg(content: string) { writeln(`^y[系统]^:: ${content}`); }
  function appendErrorMsg(content: string) { writeln(`^r[错误]^:: ${content}`); }

  function resizeLayout() {
    const h = term.height, w = term.width;
    outputBox.setSizeAndPosition({ width: w, height: Math.max(1, h - 5) });
    inputBox.setSizeAndPosition({ width: w, y: Math.max(0, h - 2) });
    doc.giveFocusTo(inputBox);
    doc.draw();
  }

  // ===== 输入处理 =====

  async function defaultSubmitHandler(value: string) {
    const trimmed = (value || '').trim();
    inputBox.setValue(''); doc.draw();
    if (!trimmed) return;

    const lower = trimmed.toLowerCase();

    if (lower === '/stop') {
      if (isStreaming) { ctx.aborted = true; agent.abort(); appendSystemMsg('⏹️ 已发送中断信号，等待 AI 停止...'); }
      else { appendSystemMsg('/stop 只能在 AI 回复时使用'); }
      return;
    }
    if (lower === '/exit' || lower === '/quit') { await handleExit(); return; }
    if (lower === '/save') { await handleSave(); return; }
    if (lower === '/clear' || lower === 'cls') { handleClear(); return; }
    if (lower === '/help') { showHelp(); return; }
    if (lower === '/back') { await handleBack(); return; }

    appendUserMsg(trimmed);
    ctx.aborted = false;
    await sendAndStream(trimmed);
  }

  function setTempSubmitHandler(h: ((value: string) => Promise<void>) | null) { submitHandler = h; }
  function resetSubmitHandler() { submitHandler = null; }

  inputBox.on('submit', async (value: string) => {
    if (submitHandler) { await submitHandler(value); }
    else { await defaultSubmitHandler(value); }
  });

  // ===== 键盘事件 =====

  term.on('key', (name: string) => {
    if (name === 'UP') { outputBox.scroll(0, 1); doc.draw(); return; }
    if (name === 'DOWN') { outputBox.scroll(0, -1); doc.draw(); return; }
    if (name === 'PAGE_UP') { outputBox.scroll(0, Math.ceil(outputBox.textAreaHeight / 2)); doc.draw(); return; }
    if (name === 'PAGE_DOWN') { outputBox.scroll(0, -Math.ceil(outputBox.textAreaHeight / 2)); doc.draw(); return; }
    if (name === 'HOME') { outputBox.scrollToTop(); doc.draw(); return; }
    if (name === 'END') { outputBox.scrollToBottom(); doc.draw(); return; }
    if (name === 'CTRL_C') {
      cleanup(); term.grabInput(false); term.hideCursor(false); term.styleReset();
      term.moveTo(1, term.height || 24); term('\n👋 再见！\n'); process.exit(0);
    }
  });

  term.on('resize', () => resizeLayout());

  // ===== Agent 事件：完全遵循原始版的换行和颜色逻辑 =====

  // 原始版 printToolCallChunk:
  //   首次:   chalk.blue.bold("\n\n💭 工具调用中...")    ← 前2换行，无后换行
  //   工具名: chalk.magenta.bold(`\n🔧 ${index} ${p.name}\n`)  ← 前后都有换行
  //   参数:   chalk.gray(func.arguments)                    ← 直接追加
  //   完成:   "\n" + chalk.gray(json/raw) + "\n"          ← 换行+内容+换行

  const onRun = () => {
    renderCtx.reasoningPrinted = false;
    renderCtx.contentPrinted = false;
    for (const k in renderCtx.toolPrints) delete renderCtx.toolPrints[k];
    isStreaming = true;
    ctx.aborted = false;
  };

  const onChunk = (chunk: AgentNS.StreamResponseData) => {
    if (ctx.aborted) return;
    if (!chunk?.choices?.[0]?.delta) return;
    const delta = chunk.choices[0].delta;
    const fr = chunk.choices[0].finish_reason ?? null;

    // ---- 工具调用 ----
    if (delta.tool_calls) {
      const isFirstToolCall =
        Object.keys(renderCtx.toolPrints).length === 0 &&
        delta.tool_calls.some((tc) => tc.function?.name || tc.function?.arguments);

      if (isFirstToolCall) {
        // 原始: chalk.blue.bold("\n\n💭 工具调用中...")  末尾无 \n
        write('\n\n^b💭 工具调用中...^:');
      }

      for (const tc of delta.tool_calls) {
        const index = tc.index ?? 0;
        const func = tc.function;
        if (!renderCtx.toolPrints[index]) {
          renderCtx.toolPrints[index] = { name: "", arguments: "", namePrinted: false, argsPrinted: false, completed: false };
        }
        const p = renderCtx.toolPrints[index];
        if (func?.name) p.name += func.name;
        if (func?.arguments) p.arguments += func.arguments;

        // 原始: chalk.magenta.bold(`\n🔧 ${index} ${p.name}\n`)
        if (p.name && !p.namePrinted) {
          write(`\n^m🔧 ${index} ${p.name}^:\n`);
          p.namePrinted = true;
        }

        if (p.arguments && !p.argsPrinted && p.namePrinted) p.argsPrinted = true;
        // 原始: chalk.gray(func.arguments)
        if (func?.arguments && p.argsPrinted) {
          write(func.arguments);
        }

        if (fr === AgentNS.FinishReason.ToolCalls) p.completed = true;
      }

      // 工具调用完成：打印完整参数
      if (fr === AgentNS.FinishReason.ToolCalls) {
        for (const idx of Object.keys(renderCtx.toolPrints).map(Number)) {
          const p = renderCtx.toolPrints[idx];
          if (p.completed && p.arguments) {
            // 原始: "\n" + chalk.gray(json/raw) + "\n"
            write('\n');
            try {
              const parsed = JSON.parse(p.arguments);
              writeln(`^K    ${JSON.stringify(parsed, null, 4)}^:`);
            } catch {
              writeln(`^K    ${p.arguments}^:`);
            }
          }
        }
      }
    }

    // ---- 思考内容 ----
    if (delta.reasoning_content) {
      if (!renderCtx.reasoningPrinted) {
        // 原始: chalk.blue.bold("\n\n💭 思考中...\n")
        write('\n\n^b💭 思考中...^:\n');
        renderCtx.reasoningPrinted = true;
      }
      // 原始: chalk.blue(delta.reasoning_content)
      write(`^b${delta.reasoning_content}^:`);
    }

    // ---- 文本内容 ----
    if (delta.content) {
      if (!renderCtx.contentPrinted) {
        // 原始: chalk.blue.bold("\n\n💭 回答中...\n")
        write('\n\n^b💭 回答中...^:\n');
        renderCtx.contentPrinted = true;
      }
      if (typeof delta.content === "string") {
        // 原始: process.stdout.write(delta.content)
        write(delta.content);
      } else if (Array.isArray(delta.content)) {
        for (const s of delta.content) {
          if (s.type === "text" && s.text) write(s.text);
        }
      }
    }
  };

  const onParsed = () => { isStreaming = false; };
  const onFinally = () => {
    isStreaming = false;
    if (ctx.aborted) appendSystemMsg('✅ 请求已中断');
  };
  const onError = (error: any) => {
    isStreaming = false;
    if (!ctx.aborted) appendErrorMsg(`错误: ${error?.message || error}`);
  };

  agent.events.on('run', onRun);
  agent.events.on('chunk', onChunk);
  agent.events.on('parsed', onParsed);
  agent.events.on('finally', onFinally);
  agent.events.on('error', onError);

  // ===== 发送消息 =====

  async function sendAndStream(input: string): Promise<void> {
    try {
      const messages = await agent.send(input);
      if (ctx.aborted) { appendSystemMsg('⏹️ 回复已被中断'); return; }
      const lastMessage = messages.at(-1);
      if (lastMessage?.status === 'error') {
        appendErrorMsg(`发生错误: ${JSON.stringify(lastMessage)}`);
        try {
          saveConversation(ctx.currentName, agent.messages, ctx.modelId, ctx.currentId, ctx.agentId);
          appendSystemMsg(`💾 错误时对话已自动保存: ${ctx.currentName}`);
        } catch (e) { appendErrorMsg(`自动保存失败: ${e}`); }
        return;
      }
      if (lastMessage?.role === AgentNS.Role.Assistant && Array.isArray(lastMessage.content)) {
        for (const section of lastMessage.content) {
          if (section.type === 'image_url') writeln(`  ^y[图片: ${section.image_url.url}]^:`);
        }
      }
      // 原始版末尾: process.stdout.write("\n\n");
      write('\n\n');
    } catch (error: any) {
      if (ctx.aborted) { appendSystemMsg('⏹️ 回复已被中断'); return; }
      appendErrorMsg(`请求错误: ${error?.message || error}`);
      if (error.message?.includes('API Key') || error.message?.includes('401') || error.message?.includes('403')) {
        appendSystemMsg('💡 请使用 aiz config set-key 设置正确的 API Key');
      }
    }
  }

  // ===== 命令处理 =====

  async function handleExit(): Promise<void> {
    ctx.running = false; cleanup();
    term.grabInput(false); term.hideCursor(false); term.styleReset();
    term.moveTo(1, term.height || 24); term('\n👋 再见！\n');
  }

  async function handleSave(): Promise<void> {
    try {
      const id = saveConversation(ctx.currentName, agent.messages, ctx.modelId, ctx.currentId, ctx.agentId);
      appendSystemMsg(`✅ 对话已保存: ${ctx.currentName} (ID: ${id})`);
      ctx.currentId = id;
    } catch (error) { appendErrorMsg(`保存失败: ${error}`); }
  }

  function handleClear(): void { outputBox.setContent(''); doc.draw(); appendSystemMsg('📋 屏幕已清空'); }

  function showHelp(): void {
    appendSystemMsg('📖 可用命令:');
    writeln('  /stop   - 终止当前 AI 回复');
    writeln('  /save   - 保存当前对话');
    writeln('  /clear  - 清空屏幕');
    writeln('  /back   - 撤回上一条消息（可编辑）');
    writeln('  /exit   - 退出对话');
    writeln('  /help   - 显示此帮助');
    writeln('  Ctrl+C  - 强制退出');
    writeln('  方向键  - 滚动查看历史消息');
  }

  async function handleBack(): Promise<void> {
    const userMessages: { index: number; content: string }[] = [];
    for (let i = 0; i < agent.messages.length; i++) {
      if (agent.messages[i].role === AgentNS.Role.User) {
        userMessages.push({ index: i, content: getMessageText(agent.messages[i]) });
      }
    }
    if (userMessages.length === 0) { appendErrorMsg('还没有用户消息可以撤回'); return; }

    const lastUserMsg = userMessages[userMessages.length - 1];
    const preview = lastUserMsg.content.length > 60 ? lastUserMsg.content.substring(0, 60) + '...' : lastUserMsg.content;

    appendSystemMsg(`📋 找到最后一条消息: "${preview}"`);
    writeln('  输入 s: 保留原内容重新发送');
    writeln('  输入 e: 修改后发送');
    writeln('  输入其他: 取消操作');

    setTempSubmitHandler(async (value: string) => {
      const trimmed = (value || '').trim().toLowerCase();
      inputBox.setValue(''); doc.draw();
      if (trimmed === 's') {
        agent.messages = agent.messages.slice(0, lastUserMsg.index);
        resetSubmitHandler(); appendSystemMsg('🔄 重新发送原消息');
        await sendAndStream(lastUserMsg.content);
      } else if (trimmed === 'e') {
        appendSystemMsg(`✏️ 请在输入框修改内容（原内容: ${preview}）`);
        agent.messages = agent.messages.slice(0, lastUserMsg.index);
        setTempSubmitHandler(async (editValue: string) => {
          const editTrimmed = (editValue || '').trim();
          inputBox.setValue(''); doc.draw(); resetSubmitHandler();
          if (!editTrimmed) { appendErrorMsg('消息内容不能为空'); }
          else { await sendAndStream(editTrimmed); }
        });
        inputBox.setValue(lastUserMsg.content); doc.draw();
      } else { resetSubmitHandler(); appendSystemMsg('已取消操作'); }
    });
  }

  function cleanup() {
    agent.events.off('run', onRun);
    agent.events.off('chunk', onChunk);
    agent.events.off('parsed', onParsed);
    agent.events.off('finally', onFinally);
    agent.events.off('error', onError);
  }

  // ===== 初始化显示 =====

  if (agent.messages.length > 0) {
    appendSystemMsg(`加载了 ${agent.messages.length} 条历史消息`);
    const lastMessages = agent.messages.slice(-5);
    for (const msg of lastMessages) {
      if (msg.role === AgentNS.Role.System && msg.hidden) continue;
      const text = getMessageText(msg);
      if (text) {
        if (msg.role === AgentNS.Role.User) writeln(`^c你^:: ${text}`);
        else if (msg.role === AgentNS.Role.Assistant) writeln(`^gAI^:: ${text}`);
      }
      const toolText = formatToolCall(msg);
      if (toolText) writeln(toolText);
    }
    if (agent.messages.length > 5) appendSystemMsg(`... 还有 ${agent.messages.length - 5} 条历史消息（可滚动查看）`);
  } else {
    appendSystemMsg('💡 新对话已开始，输入 /help 查看可用命令');
  }

  writeln('');
  doc.giveFocusTo(inputBox);
  doc.draw();

  // ===== 等待退出 =====

  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => { if (!ctx.running) { clearInterval(checkInterval); resolve(); } }, 300);
  });

  cleanup();
  try { term.grabInput(false); term.hideCursor(false); term.styleReset(); term.moveTo(1, term.height || 24); term('\n'); } catch (_) {}
}

export async function runConversationTUI(
  agent: Agent, modelId: string, conversationId?: string, conversationName?: string, agentId?: string,
): Promise<void> {
  try {
    await runConversationTUIInternal(agent, modelId, conversationId, conversationName, agentId);
  } catch (error: any) {
    try {
      const tk = await loadTK();
      if (tk?.terminal) { tk.terminal.grabInput(false); tk.terminal.hideCursor(false); tk.terminal.styleReset(); tk.terminal.moveTo(1, tk.terminal.height || 24); tk.terminal('\n'); }
    } catch (_) {}
    console.error(chalk.red(`\n❌ TUI 模式发生错误: ${error?.message || error}\n`));
    console.error(chalk.yellow("💡 回退到普通对话模式...\n"));
    const { runConversation } = await import('./conversation-runner.js');
    return runConversation(agent, modelId, conversationId, conversationName, agentId);
  }
}
