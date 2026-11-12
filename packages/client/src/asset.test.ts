/**
 * `getAsset` 的验收：按素材 id 取回内容。
 *
 * 用假服务端（真 WebSocket、按方法名答题）钉两件事：
 *   1. `asset.get` 的入参照传（`assetId` 必给、`variant` 只在给了时才出现）；
 *   2. 回包里的 base64 被解成字节，且引用事实原样带出来（客户端不必自己 `Buffer.from`）。
 *
 * 真服务端的往返（两档都能取到字节）在 `integration.test.ts` 里。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AssetGetResult, ClientInfo } from "@ai-zen/agents-server";

import { getAsset } from "./asset.js";
import { Client } from "./client.js";
import { helloResult, startFakeServer, type FakeServer } from "./testSupport/fakeServer.js";

const CLIENT_INFO: ClientInfo = { name: "asset-test", version: "0.0.0-test" };

/** 一份固定的“内容”：`hello` 的字节 */
const PAYLOAD = new TextEncoder().encode("hello");

let server: FakeServer;
let client: Client;
let asked: unknown[];

beforeAll(async () => {
  asked = [];
  server = await startFakeServer({
    methods: {
      "server.hello": () => helloResult(),
      "asset.get": (params: unknown) => {
        asked.push(params);
        const variant = (params as { variant?: "original" | "thumb" }).variant ?? "original";
        const result: AssetGetResult = {
          asset: {
            assetId: "asset-1",
            mime: "image/png",
            bytes: PAYLOAD.byteLength,
            name: "a.png",
            width: null,
            height: null,
          },
          variant,
          data: Buffer.from(PAYLOAD).toString("base64"),
        };
        return result;
      },
    },
  });
  client = await Client.connect({
    target: server.address,
    token: "test-token",
    clientInfo: CLIENT_INFO,
    language: "zh",
  });
});

afterAll(async () => {
  await client.close();
  await server.close();
});

describe("getAsset", () => {
  it("把 base64 解成字节，引用与档位原样带出来", async () => {
    const fetched = await getAsset(client, { assetId: "asset-1" });

    expect(new Uint8Array(fetched.bytes)).toEqual(PAYLOAD);
    expect(fetched.variant).toBe("original");
    expect(fetched.asset).toMatchObject({ assetId: "asset-1", mime: "image/png", name: "a.png" });
    // 没给 variant 就不发这个字段（服务端的缺省是原图）
    expect(asked.at(-1)).toEqual({ assetId: "asset-1" });
  });

  it("要缩略图时把 variant 传下去，并如实回报实际给的档", async () => {
    const fetched = await getAsset(client, { assetId: "asset-1", variant: "thumb" });

    expect(asked.at(-1)).toEqual({ assetId: "asset-1", variant: "thumb" });
    // 服务端这一波 thumb 等同原图：回包说的就是它实际给的那一档
    expect(fetched.variant).toBe("thumb");
    expect(new Uint8Array(fetched.bytes)).toEqual(PAYLOAD);
  });
});
