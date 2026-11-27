/**
 * 目标消息 → delta 流里的那些增量。这个包存在的理由就在这一个文件里。
 *
 * 调用方给的是「模型最后说了什么」：正文、思考、工具调用。真实提供方发出来的是这条消息抵达的
 * 过程：先报 `role`，再把上面三样各切几片发出来，最后报结束原因与用量。只有把这个过程反过来才
 * 知道它该怎么做，所以这里按 OpenAI 的形状一片一片拼出来，而不是把整条消息塞进一片。
 */

import type {
  FakeLlmContentSection,
  FakeLlmDelta,
  FakeLlmMessage,
  FakeLlmStreamPart,
  FakeLlmToolCall,
} from "./types.js";

/** 正文缺省切几片；大于 1 才谈得上「流式」 */
export const DEFAULT_CHUNKS = 3;

/** 切分粒度：`chunkSize` 优先（每片几个字符），否则按 `chunks` 均分 */
export interface FakeLlmChunking {
  chunks?: number;
  chunkSize?: number;
}

/** 把一串文字按片数均分（片数 ≤ 1 或只有 1 个字符时就是一片） */
export function splitReply(reply: string, count: number): string[] {
  if (count <= 1 || reply.length <= 1) return [reply];
  const size = Math.ceil(reply.length / count);
  const pieces: string[] = [];
  for (let at = 0; at < reply.length; at += size) pieces.push(reply.slice(at, at + size));
  return pieces;
}

/** 按给定粒度切一串文字：`chunkSize` 优先，否则均分成 `chunks`（缺省 3）片 */
export function cutText(text: string, chunking: FakeLlmChunking = {}): string[] {
  const size = chunking.chunkSize;
  if (size !== undefined && size > 0) {
    if (text.length <= size) return [text];
    const pieces: string[] = [];
    for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
    return pieces;
  }
  return splitReply(text, chunking.chunks ?? DEFAULT_CHUNKS);
}

/**
 * 一条目标消息 → 首片之后的所有增量（首片由端点自己发，它只有 `role`）。
 *
 * 切分只动位置不动内容：工具参数原样切开，拼回去必须与目标消息里那一串一字不差。这里不 parse
 * 它是为了不把调用方的排版（空格、键序）改成另一份。
 */
export function buildDeltas(
  message: FakeLlmMessage,
  chunking: FakeLlmChunking = {},
): FakeLlmDelta[] {
  const deltas: Record<FakeLlmStreamPart, FakeLlmDelta[]> = {
    reasoning: reasoningDeltas(message.reasoning_content, chunking),
    tool_call: toolCallDeltas(message.tool_calls ?? [], chunking),
    content: contentDeltas(message.content, chunking),
  };

  return arrange(deltas, message.stream_order);
}

function reasoningDeltas(text: string | undefined, chunking: FakeLlmChunking): FakeLlmDelta[] {
  if (!text) return [];
  return cutText(text, chunking)
    .filter((piece) => piece !== "")
    .map((piece) => ({ reasoning_content: piece }));
}

function contentDeltas(
  content: FakeLlmMessage["content"],
  chunking: FakeLlmChunking,
): FakeLlmDelta[] {
  if (content === undefined) return [];
  if (typeof content === "string") {
    return cutText(content, chunking).map((piece) => ({ content: piece }));
  }

  const deltas: FakeLlmDelta[] = [];
  for (const [at, section] of content.entries()) {
    const index = section.index ?? at;
    if (section.type !== "text") {
      deltas.push({ content: [{ ...section, index }] });
      continue;
    }
    // 内容块数组本身就是「一块一片」的粒度：只有显式给了 `chunkSize` 才在块内再切
    const pieces = chunking.chunkSize ? cutText(section.text, chunking) : [section.text];
    for (const piece of pieces) {
      const textSection: FakeLlmContentSection = { index, type: "text", text: piece };
      deltas.push({ content: [textSection] });
    }
  }
  return deltas;
}

/**
 * 工具调用按 OpenAI 的流式规矩发：每个调用第一片带 `index` / `id` / `type` 与函数名，
 * 之后每片只带 `function.arguments` 的增量。客户端按 `index` 归位、把参数串接起来。
 */
function toolCallDeltas(toolCalls: FakeLlmToolCall[], chunking: FakeLlmChunking): FakeLlmDelta[] {
  const deltas: FakeLlmDelta[] = [];
  for (const [at, toolCall] of toolCalls.entries()) {
    const index = toolCall.index ?? at;
    deltas.push({
      tool_calls: [
        {
          index,
          id: toolCall.id ?? `call_${index}`,
          type: toolCall.type ?? "function",
          function: { name: toolCall.function?.name ?? "", arguments: "" },
        },
      ],
    });

    const args = toolCall.function?.arguments ?? "";
    for (const piece of cutText(args, chunking)) {
      if (piece === "") continue;
      deltas.push({ tool_calls: [{ index, function: { arguments: piece } }] });
    }
  }
  return deltas;
}

/**
 * 三块谁先谁后。
 *
 * 缺省三块依次吐完；给了 `stream_order` 就按它循环取下一片，某一块空了就跳过。
 * 顺序里没提到的块补在最后 —— 漏写一格不该让那部分内容凭空消失。
 */
function arrange(
  deltas: Record<FakeLlmStreamPart, FakeLlmDelta[]>,
  order: FakeLlmStreamPart[] | undefined,
): FakeLlmDelta[] {
  const parts: FakeLlmStreamPart[] = ["reasoning", "tool_call", "content"];
  const left: Record<FakeLlmStreamPart, FakeLlmDelta[]> = {
    reasoning: [...deltas.reasoning],
    tool_call: [...deltas.tool_call],
    content: [...deltas.content],
  };
  const total = (): number => left.reasoning.length + left.tool_call.length + left.content.length;

  if (order === undefined || order.length === 0) return parts.flatMap((part) => left[part]);

  const arranged: FakeLlmDelta[] = [];
  let at = 0;
  let skipped = 0;
  // 该取的那一块空了只是这次没有内容可发，接着往下取；三类块连着都取不到，说明剩下的块
  // 都不在顺序里，收尾补齐即可（否则这个循环永远等不到总数下降）
  while (total() > 0 && skipped < order.length) {
    const piece = left[order[at % order.length]!].shift();
    at += 1;
    if (piece === undefined) {
      skipped += 1;
      continue;
    }
    arranged.push(piece);
    skipped = 0;
  }
  for (const part of parts) arranged.push(...left[part]);
  return arranged;
}
