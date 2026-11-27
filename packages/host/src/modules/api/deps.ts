import type { AgentRuntime, ToolEnvDeps } from "@ai-zen/agents-sdk";

import type { Bus } from "../../infra/bus.js";
import type { inboxTable } from "../agent/inbox.js";
import type { ReloadWindow } from "../agent/reload-window.js";
import type { AssetService } from "../asset/service.js";
import type { AgentDefinitionService } from "../config/agents.js";
import type { EndpointService } from "../config/endpoints.js";
import type { GeneralConfig } from "../config/general.js";
import type { ImageModelService } from "../config/imageModels.js";
import type { McpConfig } from "../config/mcp.js";
import type { ModelService } from "../config/models.js";
import type { PresetService } from "../config/presets.js";
import type { HostEvent } from "../events.js";
import type { HandoffService } from "../handoff/service.js";
import type { Translator } from "../i18n/index.js";
import type { NoticeService } from "../notice/service.js";
import type { QuestionRegistry } from "../question/registry.js";
import type { SearchService } from "../search/service.js";
import type { AutoNamer } from "../session/auto-name.js";
import type { messageTable } from "../session/messages.js";
import type { SessionService } from "../session/service.js";
import type { UpdateService } from "../update/service.js";
import type { WorkspaceService } from "../workspace/service.js";

/**
 * procedure 拿到的那一层。全部必填：缺哪一个，调用点就得自己判「有没有」，那份判断迟早会
 * 变成一条没人走过的分支。
 *
 * `runtime` 是「哪些会话有活 Agent」唯一的答案（`get` / `wake` / `kill` 都问它）；宿主自己不留第二份。
 *
 * `onError` 是落库、发事件这两条路上不跨 wire 的失败出口（`HostObserver` 要它）；它的去向是
 * 宿主日志，不是客户端。
 */
export interface HostApiDeps {
  readonly sessions: SessionService;
  /** 起名那一件事（自动那一条与用户点名的 `session.autoTitle` 共用同一套） */
  readonly autoNamer: AutoNamer;
  readonly workspaces: WorkspaceService;
  readonly runtime: AgentRuntime;
  readonly definitions: AgentDefinitionService;
  /**
   * 内存里那一份配置。它同时是配置面的读口（`config.get` 读它）与写盘口的入口
   * （`GeneralConfig.patch` / `write`：写盘、更新内存那份、发事件都在那一处）。
   */
  readonly config: GeneralConfig;
  /** 配置面的四个写口。读不在这里 —— 读只有 `config` 一处 */
  readonly endpoints: EndpointService;
  readonly models: ModelService;
  readonly imageModels: ImageModelService;
  readonly presets: PresetService;
  /**
   * MCP 那五层文件。与运行期（`openScope` 里的发现）看的是同一批文件、问的是不同的问题：
   * 这里问「每条写在哪一层、还能不能改」，那里问「怎么连」。
   */
  readonly mcp: McpConfig;
  readonly messages: ReturnType<typeof messageTable>;
  readonly inbox: ReturnType<typeof inboxTable>;
  /**
   * 正在重装的那几段会话。改完定义那条路开它、观察者读它：窗口里那一次清空不作废库里那几行
   * （「换模型不是杀死」）—— 两处必须拿到同一个对象，否则谁也
   * 看不见谁。
   */
  readonly reloads: ReloadWindow;
  readonly assets: AssetService;
  /**
   * 出网/Asset 端口（`readAsset` 在那里），与 `Scope` 拿到的是同一个对象：`materialsFor` 把它
   * 交给 SDK 的附件传输插件 —— 发出去之前按当下生效的模型重建 Asset 段时，那是它唯一需要的口。
   */
  readonly assetPort: ToolEnvDeps;
  readonly notices: NoticeService;
  readonly questions: QuestionRegistry;
  readonly search: SearchService;
  readonly handoff: HandoffService;
  /**
   * 升级的第 ② 段与「现在是哪一版」。只有 `host` 那两条 procedure 用它 —— 装包与拉起不在
   * 宿主里，这个服务也只做到「写 pin、请退出」为止。
   */
  readonly updates: UpdateService;
  /**
   * 关掉宿主。收尾与退出都在装配根上（`HostApp.requestShutdown`），这里只留一句「请」——
   * procedure 的答复先出去，收尾再开始。
   */
  readonly shutdown: () => void;
  readonly events: Bus<HostEvent>;
  readonly t: Translator;
  readonly onError: (error: unknown, what: string) => void;
}
