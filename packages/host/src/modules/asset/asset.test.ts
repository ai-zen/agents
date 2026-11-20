/**
 * 两条验收：同一份字节存两次只留一行、一份文件；引用它的消息删掉之后 `sweepUnreferenced`
 * 才删字节，还有别的引用时行与字节都不动。
 *
 * 两条都是「不报错也不工作」的那种错：去重没落在唯一索引上，多出来的文件没有任何人看得见；
 * 清理早一步，列表里那条素材就变成一个打不开的名字。
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentNS, Message } from "@ai-zen/agents-core";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../infra/db.js";
import { createTranslator } from "../i18n/index.js";
import { messageTable } from "../session/messages.js";
import { sessionTable } from "../session/table.js";
import { workspaceTable } from "../workspace/table.js";
import { AssetService } from "./service.js";
import { assetTable, sessionAssetTable } from "./table.js";

const dataRoots: string[] = [];

afterEach(() => {
  for (const dataRoot of dataRoots.splice(0)) rmSync(dataRoot, { recursive: true, force: true });
});

/** 消息挂在外键上，所以每一个库都得先有项目行与会话行，不然插入会被 `foreign_keys` 拦住 */
function newHost() {
  const dataRoot = mkdtempSync(join(tmpdir(), "asset-"));
  dataRoots.push(dataRoot);

  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });
  sessionTable(db).put({
    id: "s-1",
    workspaceId: "ws-1",
    name: "1712345678000",
    nameIsAuto: true,
    pinned: false,
    agentId: "agent-1",
    modelId: "model-1",
    thinkingLevel: null,
    autoHandoff: false,
    lineage: null,
    handoffThreshold: null,
    guardThreshold: null,
    pendingHandoff: null,
    createdAt: 1,
    updatedAt: 1,
  });

  const messages = messageTable(db);
  const assets = new AssetService({
    assets: assetTable(db),
    sessionAssets: sessionAssetTable(db),
    dataRoot,
    t: createTranslator(() => "zh"),
  });

  return { dataRoot, assets, messages };
}

function message(id: string, content: string): AgentNS.Message {
  return new Message({
    id,
    role: AgentNS.Role.User,
    status: AgentNS.MessageStatus.Completed,
    content,
  });
}

describe("素材", () => {
  it("同一份字节存两次只有一行、只有一份文件", () => {
    const { assets, dataRoot } = newHost();
    const bytes = Buffer.from("同一份字节");

    const first = assets.store(bytes, "image/png", "屏幕截图.png");
    const second = assets.store(bytes, "image/png", "另一个名字.png");

    expect(second).toEqual(first);
    expect(readdirSync(join(dataRoot, "assets"))).toEqual([first.sha256]);
    expect(assets.getBytes(first.id).equals(bytes)).toBe(true);
  });

  it("引用它的消息删掉之后才清字节，还有别的引用时不动", () => {
    const { assets, messages, dataRoot } = newHost();
    const stored = assets.store(Buffer.from("一份字节"), "image/png", null);
    const path = join(dataRoot, "assets", stored.sha256);
    messages.upsertMany("s-1", [message("m-1", "第一句"), message("m-2", "第二句")]);
    assets.link("m-1", [stored.id]);
    assets.link("m-2", [stored.id]);

    messages.delete("m-1");
    assets.sweepUnreferenced([stored.id]);
    expect(existsSync(path)).toBe(true);
    expect(assets.listBySession("s-1")).toEqual([stored]);

    messages.delete("m-2");
    assets.sweepUnreferenced([stored.id]);
    expect(existsSync(path)).toBe(false);
    expect(assets.listBySession("s-1")).toEqual([]);
  });
});
