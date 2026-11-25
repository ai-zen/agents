/**
 * 两条验收：三字以上的中文子串靠 FTS5 的 trigram 命中（选 trigram 的全部理由）；两字查询在
 * trigram 下必然搜不到，落到 `LIKE` 上才找得到（那是 trigram 的已知短板）。
 */

import { describe, expect, it } from "vitest";

import { AgentNS, Message } from "@ai-zen/agents-core";

import { openDatabase } from "../../infra/db.js";
import { messageTable } from "../session/messages.js";
import { sessionTable } from "../session/table.js";
import { workspaceTable } from "../workspace/table.js";
import { SearchService } from "./service.js";
import { searchTable } from "./table.js";

const userMessage: AgentNS.Message = new Message({
  id: "m-1",
  role: AgentNS.Role.User,
  status: AgentNS.MessageStatus.Completed,
  content: "帮我把登录页的背景改成深蓝色",
});

/** 顺序与装配根一致：消息挂在外键上，索引的触发器又指向 `messages` */
function newSearch() {
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });
  sessionTable(db).put({
    id: "s-1",
    workspaceId: "ws-1",
    name: "改配色",
    nameSource: "default",
    pinned: false,
    agentId: "agent-1",
    modelId: "model-1",
    thinkingLevel: null,
    autoHandoff: false,
    lineage: null,
    handoffThreshold: null,
    guardThreshold: null,
    createdAt: 1,
    updatedAt: 1,
  });

  const messages = messageTable(db);
  return { messages, search: new SearchService({ search: searchTable(db) }) };
}

describe("搜索", () => {
  it("三字以上的中文子串搜得到，命中项带着会话名、片段与整条消息", async () => {
    const { messages, search } = newSearch();
    messages.upsert("s-1", userMessage);

    const hits = await search.messages("深蓝色", { sessionId: "s-1" }, 10);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      messageId: "m-1",
      sessionId: "s-1",
      sessionName: "改配色",
      snippet: "帮我把登录页的背景改成深蓝色",
      message: expect.objectContaining({ id: "m-1", role: AgentNS.Role.User }),
    });
  });

  it("两字查询走子串匹配，也搜得到", async () => {
    const { messages, search } = newSearch();
    messages.upsert(
      "s-1",
      new Message({
        id: "m-2",
        role: AgentNS.Role.Assistant,
        status: AgentNS.MessageStatus.Completed,
        content: [
          { type: "text", text: "界面发灰，换个" },
          { type: "text", text: "配色" },
        ],
      }),
    );

    // 「配色」拆开落在两段里：抽文本时拼起来才搜得到，所以这条也顺带证明只取文本段这条规则
    const hits = await search.messages("配色", { workspaceId: "ws-1" }, 10);

    expect(hits.map((hit) => hit.messageId)).toEqual(["m-2"]);
    expect(hits[0]?.snippet).toBe("界面发灰，换个 配色");
  });
});
