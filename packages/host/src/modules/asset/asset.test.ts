/**
 * 两条验收：同一份字节存两次只留一行、一份文件；引用它的消息删掉之后 `sweepUnreferenced`
 * 才删字节，还有别的引用时行与字节都不动。
 *
 * 另有两条量尺寸的（PNG 量得出、非图片没有那两格）与一条幂等的（同一对消息与 Asset 反复 link
 * 只留一行引用）。
 *
 * 两条都是「不报错也不工作」的那种错：去重没落在唯一索引上，多出来的文件没有任何人看得见；
 * 清理早一步，列表里那条 Asset 就变成一个打不开的名字。
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
  // `assets` 先建：`session_assets` 的两列外键指着它（反过来的话建表那一刻就没有 `assets`）
  const assetRows = assetTable(db);
  const sessionAssets = sessionAssetTable(db);
  const assets = new AssetService({
    assets: assetRows,
    sessionAssets,
    dataRoot,
    t: createTranslator(() => "zh"),
  });

  return { dataRoot, assets, messages, sessionAssets };
}

function message(id: string, content: string): AgentNS.Message {
  return new Message({
    id,
    role: AgentNS.Role.User,
    status: AgentNS.MessageStatus.Completed,
    content,
  });
}

/** PNG 的 24 字节头（签名 + 块头 + IHDR 里的宽高）：`probeImageSize` 认的就是这一段 */
function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8); // IHDR 的块长
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("Asset", () => {
  it("同一份字节存两次只有一行、只有一份文件", () => {
    const { assets, dataRoot } = newHost();
    const bytes = Buffer.from("同一份字节");

    const first = assets.store(bytes, "image/png", "屏幕截图.png");
    const second = assets.store(bytes, "image/png", "另一个名字.png");

    expect(second).toEqual(first);
    expect(readdirSync(join(dataRoot, "assets"))).toEqual([first.sha256]);
    expect(assets.getBytes(first.id).equals(bytes)).toBe(true);
  });

  it("存一份 PNG：行上量得到宽高（只给界面排版用）", () => {
    const { assets } = newHost();

    const stored = assets.store(pngHeader(1280, 720), "image/png", "截图.png");

    expect(stored.width).toBe(1280);
    expect(stored.height).toBe(720);
    // 落库那一行也是同一份：不是只在返回值上贴了两个数
    expect(assets.get(stored.id)).toEqual(stored);
  });

  it("存一份认不出格式的字节：宽高这两格就是没有（不是 0、不是 NaN）", () => {
    const { assets } = newHost();

    const stored = assets.store(Buffer.from("就是一段纯文本"), "text/plain", "笔记.txt");

    expect("width" in stored).toBe(false);
    expect("height" in stored).toBe(false);
  });

  it("同一对消息与Asset link 三次，引用仍然只有一条", () => {
    const { assets, messages, sessionAssets } = newHost();
    const stored = assets.store(Buffer.from("一份字节"), "image/png", null);
    messages.upsert("s-1", message("m-1", "看图"));

    assets.link("m-1", [stored.id]);
    assets.link("m-1", [stored.id]);
    assets.link("m-1", [stored.id]);

    // 观察者每收到一次消息事实就登记一次（流式期间一条消息会被写很多次）：不幂等的话
    // 引用行会成倍长出来，`countByAsset` 也再归不了零
    expect(sessionAssets.countByAsset(stored.id)).toBe(1);
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
