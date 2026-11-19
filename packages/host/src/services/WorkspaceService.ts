/**
 * Workspace 服务：项目（一个工作目录）的登记、查看、改名、删除。
 *
 * 对应能力编号：F-C1 的前置（项目中承载对话）、D9 / D10 / D12（一等公民、cwd 不可变、
 * 目录不存在照常可看）、D11（删项目连带删名下对话，目录本身不碰）、D17（删除前给代价）、
 * F-F9（不可撤销动作由客户端二次确认，宿主负责算账）、R14（cwd 唯一）、R20（列表顺序）。
 *
 * 这个服务只做「一条项目记录怎么变」与「代价是多少」；文件系统方面只回答一件事 ——
 * 目录还在不在（`FolderFact.exists`），是否只读由客户端判断（D12）。
 */

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import type { AssetRepository } from "../storage/AssetRepository.js";
import type { SessionRepository } from "../storage/SessionRepository.js";
import type { MessageRepository } from "../storage/MessageRepository.js";
import type { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import type { WorkspaceRow } from "../storage/types.js";
import { HostError } from "../wire/errors.js";
import type {
  FolderFact,
  RemovalConsequences,
  WorkspaceCreateParams,
  WorkspaceCreateResult,
  WorkspaceGetParams,
  WorkspaceGetResult,
  WorkspaceListParams,
  WorkspaceListResult,
  WorkspaceRemoveParams,
  WorkspaceRemoveResult,
  WorkspaceRenameParams,
  WorkspaceRenameResult,
  WorkspaceView,
} from "../wire/index.js";
import type { SessionRuntimePort, AssetSweeper } from "./SessionService.js";

/**
 * `workspace.remove` 的结果。
 *
 * wire 的 `WorkspaceRemoveResult` 只有「删了没 + 代价」；真正把 `assets/` 下的文件
 * 清掉是 asset 那一层的事（PRD D17「图片按引用清理」），所以这里多带一份这些对话引用过的
 * 素材 id（删完之后由 asset 层问「还剩几张引用」，归零才删）。
 */
export interface WorkspaceRemovalReport extends WorkspaceRemoveResult {
  /** 这些对话引用过的素材 id（可能还有别的对话在用） */
  assetIds: string[];
}

/** Workspace 服务的依赖；由单根组装后注入，服务自己不取任何全局路径 */
export interface WorkspaceServiceDeps {
  workspaces: WorkspaceRepository;
  sessions: SessionRepository;
  messages: MessageRepository;
  assets: AssetRepository;
  /** 引用归零的素材交给它删行删文件；不注入时字节会留在盘上（引用行已经没了） */
  sweepAssets?: AssetSweeper;
  /**
   * 运行时钩子：删项目会连带删掉它名下的对话，这些对话在运行时里可能还留着现场
   * （`ChatRunner` 手上那条桥、`AgentRegistry` 里那个 agent），删之前一并请它扔掉。
   */
  runtime: SessionRuntimePort;
  /** 时钟，测试注入用；缺省 `Date.now` */
  now?: () => number;
}

/** 时间戳（毫秒）转 wire 上的 ISO 8601 字符串 */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 目录是否存在；取不到（权限、悬空链接等）按「不存在」回报事实（D12） */
export async function pathExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 目录事实：路径 + 还在不在（PRD D12）。
 *
 * 只给事实，不给结论 —— 目录没了对话照样能看，是否禁掉发送由客户端判断。
 */
export async function toFolderFact(cwd: string): Promise<FolderFact> {
  return { cwd, exists: cwd.length > 0 && (await pathExists(cwd)) };
}

/** 名字不能是空白串；`field` 用于把「哪个字段不对」结构化地告诉客户端 */
function requireName(value: string, field: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0) {
    throw new HostError("invalid_params", {
      params: { field },
      detail: { field, reason: "empty" },
    });
  }
  return name;
}

/**
 * cwd 归一化成绝对路径。
 *
 * 相对路径按宿主进程的工作目录解析会得到「随启动方式漂移」的路径（D9 的 cwd 一旦
 * 定死就不再变），所以这里要求调用方给绝对路径，再由 `resolve` 把 `..`、尾斜杠归一。
 */
function normalizeCwd(value: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw.length === 0) {
    throw new HostError("invalid_params", {
      params: { field: "cwd" },
      detail: { field: "cwd", reason: "empty" },
    });
  }
  if (!isAbsolute(raw)) {
    throw new HostError("invalid_params", {
      params: { field: "cwd" },
      detail: { field: "cwd", reason: "not_absolute", cwd: value },
    });
  }
  return resolve(raw);
}

export class WorkspaceService {
  private readonly workspaces: WorkspaceRepository;
  private readonly sessions: SessionRepository;
  private readonly messages: MessageRepository;
  private readonly assets: AssetRepository;
  private readonly sweepAssets?: AssetSweeper;
  private readonly runtime: SessionRuntimePort;
  private readonly now: () => number;

  constructor(deps: WorkspaceServiceDeps) {
    this.workspaces = deps.workspaces;
    this.sessions = deps.sessions;
    this.messages = deps.messages;
    this.assets = deps.assets;
    this.sweepAssets = deps.sweepAssets;
    this.runtime = deps.runtime;
    this.now = deps.now ?? Date.now;
  }

  /**
   * 列出项目（PRD D9 / D12 / R20）。
   *
   * 顺序按创建时间倒序（仓储里定死）。目录已不存在的项目默认也列出来 —— 它名下的对话
   * 与历史仍然可用（D12），藏起来只会让人以为数据丢了；显式传 `includeMissingFolders: false`
   * 时才过滤掉。
   */
  async list(params: WorkspaceListParams = {}): Promise<WorkspaceListResult> {
    const rows = await this.workspaces.list();
    const views: WorkspaceView[] = [];
    for (const row of rows) {
      const view = await this.toView(row);
      if (params.includeMissingFolders === false && !view.folder.exists) continue;
      views.push(view);
    }
    return { workspaces: views };
  }

  /**
   * 登记一个目录为项目（PRD D9 / D10）。
   *
   * 同一个 cwd 只登记一次（R14：两次登记会让两个 Scope 抢同一个目录）。名字不传就用
   * 目录名 —— 这个名字之后可改，cwd 不可改。
   */
  async create(params: WorkspaceCreateParams): Promise<WorkspaceCreateResult> {
    const cwd = normalizeCwd(params.cwd);
    const existing = await this.workspaces.getByCwd(cwd);
    if (existing) {
      throw new HostError("invalid_params", {
        params: { field: "cwd" },
        detail: { field: "cwd", reason: "already_registered", cwd, workspaceId: existing.id },
      });
    }

    const name = params.name === undefined || params.name.trim().length === 0
      ? basename(cwd) || cwd
      : params.name.trim();
    const id = randomUUID();
    await this.workspaces.create({ id, name, cwd, createdAt: this.now() });

    const row = await this.workspaces.get(id);
    if (!row) {
      throw new HostError("internal", { detail: { reason: "workspace vanished after insert", id } });
    }
    return { workspace: await this.toView(row) };
  }

  async get(params: WorkspaceGetParams): Promise<WorkspaceGetResult> {
    return { workspace: await this.toView(await this.requireRow(params.workspaceId)) };
  }

  /** 改名：id 与 cwd 不动（PRD D9），只换显示名 */
  async rename(params: WorkspaceRenameParams): Promise<WorkspaceRenameResult> {
    const row = await this.requireRow(params.workspaceId);
    const name = requireName(params.name, "name");
    await this.workspaces.rename(row.id, name);
    return { workspace: await this.toView({ ...row, name }) };
  }

  /**
   * 删项目（PRD D11 / D17 / F-F9 / R7）。
   *
   * `dryRun` 只算账：名下对话数、消息数、素材数，客户端拿去向用户说明代价。真删时按外键
   * 级联把对话、消息、问题行、素材的引用关系一起删掉；`assets/` 下的文件不在服务的删除范围里
   * （D11：目录本身宿主不碰），但素材的字节要按引用清 —— 那张图可能还有别的项目的对话在用，
   * 所以只把「这些对话引用过哪几份素材」交给 asset 层，删完之后由它问「还剩几张引用」。
   */
  async remove(params: WorkspaceRemoveParams): Promise<WorkspaceRemovalReport> {
    const row = await this.requireRow(params.workspaceId);
    const sessions = await this.sessions.listByWorkspace(row.id);

    const consequences: RemovalConsequences = {
      sessions: sessions.length,
      messages: 0,
      assets: 0,
    };
    const assetIds = new Set<string>();
    for (const session of sessions) {
      // 这个数来自 `countBySession`：每段对话在 `messages` 表里的全部行（子 Agent 的话
      // 从来不入库，`CORE.md` §17）。侧栏摘要的 `messageCount` 走 `listBySession`，两者
      // 数的是同一批行、口径永远相等 —— 一个只取数、一个取行，没有第二套算法。
      consequences.messages += await this.messages.countBySession(session.id);
      const assets = await this.assets.listBySession(session.id);
      consequences.assets += assets.length;
      for (const asset of assets) assetIds.add(asset.id);
    }

    if (params.dryRun === true) {
      return { removed: false, consequences, assetIds: [...assetIds] };
    }

    // 先请运行时忘掉这些对话，再删行：反过来会在运行时里留下指向已删记录的覆盖项
    for (const session of sessions) {
      await this.runtime.forget(session.id);
    }
    const changes = await this.workspaces.delete(row.id);
    // 关系行已经随外键没了：归零的那几份素材才删行删文件
    if (changes > 0) await this.sweepAssets?.([...assetIds]);
    return { removed: changes > 0, consequences, assetIds: [...assetIds] };
  }

  private async requireRow(workspaceId: string): Promise<WorkspaceRow> {
    const row = typeof workspaceId === "string" && workspaceId.length > 0
      ? await this.workspaces.get(workspaceId)
      : undefined;
    if (!row) {
      throw new HostError("not_found", {
        params: { entity: "workspace" },
        detail: { workspaceId },
      });
    }
    return row;
  }

  /**
   * 组装一个项目的对外形状。
   *
   * `updatedAt` 在 `workspaces` 表里没有对应列，这里取「最近一次对话活动」当它；一条对话
   * 都没有时就是创建时间。`lastActivityAt` 同理来自对话的 `updatedAt`（新增消息会推进它）。
   */
  private async toView(row: WorkspaceRow): Promise<WorkspaceView> {
    const sessions = await this.sessions.listByWorkspace(row.id);
    const lastActivityAt = sessions.reduce<number | null>(
      (latest, session) =>
        latest === null || session.updatedAt > latest ? session.updatedAt : latest,
      null,
    );
    return {
      id: row.id,
      name: row.name,
      folder: await toFolderFact(row.cwd),
      createdAt: iso(row.createdAt),
      updatedAt: iso(lastActivityAt ?? row.createdAt),
      sessionCount: sessions.length,
      lastActivityAt: lastActivityAt === null ? null : iso(lastActivityAt),
    };
  }
}
