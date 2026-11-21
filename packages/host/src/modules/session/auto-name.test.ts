/**
 * 一条验收：名字不是自动起的时候，一次请求都不发。
 *
 * 判据写错不会报错：把「还没起过名」判成「名字里带着时间戳」或者「这是第一次变闲」，
 * 用户改过的名字会在下一次变闲时被悄悄换掉，而用户以为那是自己起的。同一个用例里带上正例，
 * 否则一个从不发请求的实现也能让断言全绿。
 */

import { join } from "node:path";

import { AgentNS, Message } from "@ai-zen/agents-core";
import type { AgentModel, AppConfig } from "@ai-zen/agents-sdk";
import { ConfigManager } from "@ai-zen/agents-sdk";
import { describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { openDatabase } from "../../infra/db.js";
import type { ConfigEvent } from "../config/events.js";
import { GeneralConfig } from "../config/general.js";
import type { HostEvent } from "../events.js";
import { createTranslator } from "../i18n/index.js";
import { workspaceTable } from "../workspace/table.js";
import { AutoNamer } from "./auto-name.js";
import { messageTable } from "./messages.js";
import { SessionService } from "./service.js";
import { sessionTable } from "./table.js";
import type { NewSession } from "./types.js";

const config: AppConfig = {
  endpoints: [{ id: "ep-1", name: "ep-1", baseUrl: "https://ep-1.example/v1", apiKey: "key" }],
  models: [
    { id: "naming-1", name: "naming-1", endpointId: "ep-1", tokenThresholds: { handoff: 100, guard: 150 } },
  ],
  namingModel: "naming-1",
};

const input: NewSession = {
  workspaceId: "ws-1",
  name: "1712345678000",
  agentId: "agent-1",
  modelId: "naming-1",
  nameIsAuto: true,
  autoHandoff: false,
  lineage: null,
};

function setup() {
  const db = openDatabase(":memory:");
  workspaceTable(db).put({ id: "ws-1", name: "项目一", cwd: "/tmp/ws-1", createdAt: 1 });

  const sessions = new SessionService({
    sessions: sessionTable(db),
    events: createBus<HostEvent>(),
    t: createTranslator(() => "zh"),
  });
  const messages = messageTable(db);

  // 假的模型客户端：只做一件真客户端也做的事 —— 把请求记下来
  const requests: unknown[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: unknown) => {
          requests.push(body);
          return { choices: [{ message: { content: "把宿主的交接写出来" } }] };
        },
      },
    },
  } as unknown as AgentModel["client"];

  const namer = new AutoNamer({
    sessions,
    messages,
    config: new GeneralConfig({
      config: new ConfigManager(join("/tmp", "ai-zen-auto-name", "config.json")),
      current: config,
      events: createBus<ConfigEvent>(),
    }),
    createModel: () => ({ client, model: "naming-1" }),
    onError: (error) => {
      throw error;
    },
  });

  return { namer, sessions, messages, requests };
}

function message(id: string, role: AgentNS.Role, text: string): AgentNS.Message {
  return new Message({ id, role, status: AgentNS.MessageStatus.Completed, content: text });
}

describe("起名", () => {
  it("nameIsAuto 为假时一次请求都不发，为真时发出一次并写回名字", async () => {
    const { namer, sessions, messages, requests } = setup();

    const renamed = sessions.create({ ...input, name: "我自己起的名字", nameIsAuto: false });
    messages.upsertMany(renamed.id, [
      message("m-1", AgentNS.Role.User, "帮我把宿主的交接写出来"),
      message("m-2", AgentNS.Role.Assistant, "先把状态机那一格定下来"),
    ]);

    await namer.name(renamed.id);

    expect(requests).toHaveLength(0);
    expect(sessions.get(renamed.id)?.name).toBe("我自己起的名字");

    const naming = sessions.create(input);
    messages.upsertMany(naming.id, [
      message("m-3", AgentNS.Role.User, "帮我把宿主的交接写出来"),
      message("m-4", AgentNS.Role.Assistant, "先把状态机那一格定下来"),
    ]);

    await namer.name(naming.id);

    expect(requests).toHaveLength(1);
    expect(sessions.get(naming.id)).toMatchObject({ name: "把宿主的交接写出来", nameIsAuto: true });
  });
});
