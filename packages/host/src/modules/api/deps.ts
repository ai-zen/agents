import type { GeneralConfig } from "../config/general.js";
import type { AgentDefinitionService } from "../config/agents.js";
import type { Bus } from "../../infra/bus.js";
import type { Translator } from "../i18n/index.js";
import type { ScopeRegistry } from "../scope/registry.js";
import type { AssetService } from "../asset/service.js";
import type { CredentialService } from "../credential/service.js";
import type { NoticeService } from "../notice/service.js";
import type { QuestionRegistry } from "../question/registry.js";
import type { SearchService } from "../search/service.js";
import type { Delivery } from "../agent/delivery.js";
import type { inboxTable } from "../agent/inbox.js";
import type { HostEvent } from "../events.js";
import type { messageTable } from "../session/messages.js";
import type { SessionService } from "../session/service.js";
import type { WorkspaceService } from "../workspace/service.js";
import type { AgentRegistry } from "./registry.js";

/**
 * procedure 拿到的那一层。全部必填：缺哪一个，调用点就得自己判「有没有」，那份判断迟早会
 * 变成一条没人走过的分支。
 *
 * `onError` 是落库、发事件这两条路上不跨 wire 的失败出口（`AgentSubscription` 与 `assemble`
 * 都要它）；它的去向是宿主日志，不是客户端。
 */
export interface HostApiDeps {
  readonly sessions: SessionService;
  readonly workspaces: WorkspaceService;
  readonly scopes: ScopeRegistry;
  readonly definitions: AgentDefinitionService;
  readonly config: GeneralConfig;
  readonly messages: ReturnType<typeof messageTable>;
  readonly inbox: ReturnType<typeof inboxTable>;
  readonly delivery: Delivery;
  readonly agents: AgentRegistry;
  readonly assets: AssetService;
  readonly notices: NoticeService;
  readonly credentials: CredentialService;
  readonly questions: QuestionRegistry;
  readonly search: SearchService;
  readonly events: Bus<HostEvent>;
  readonly t: Translator;
  readonly onError: (error: unknown, what: string) => void;
}
