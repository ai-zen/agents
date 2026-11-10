/**
 * 工作区（workspace）在盘上的身份与位置 —— 一个**一等对象**：有名字、id 冻结、可重定位。
 *
 * 会话属于**工作区**，不属于某个前端：CLI、桌面端、将来的浏览器连同一台服务端时，
 * 看到的是同一份 `<aiZenDir>/workspaces/<workspaceId>/`（这是把会话搬出 `cli/` 的原因）。
 *
 * ## 一个工作区在盘上是什么
 *
 *   <workspacesRoot>/<workspaceId>/workspace.json   身份与位置（就是本文件管的这张纸）
 *   <workspacesRoot>/<workspaceId>/sessions/        它的会话存档（`FileSessionStore`）
 *   <workspacesRoot>/<workspaceId>/last-session.json 「上一轮会话」指针
 *
 * ## workspaceId 长什么样，以及为什么它**不能**跟着路径变
 *
 * id 的形状是 `<目录名规范化>-<sha256 前 8 位>`，例如
 * `/home/ubuntu/projects/ai-zen/cli` → `cli-3f9a1c2b`：
 *   - **认得出**：人 `ls` 一眼知道是哪个项目（纯哈希做不到）；
 *   - **不撞车**：目录名规范化会丢掉信息（`a/b-c` 与 `a-b/c` 同名），所以带路径哈希。
 * 这个值只是**首次分配时**的候选（`workspaceIdFor`），分配之后**冻结**：
 * `mv ~/proj ~/proj2` 之后 id 仍然是 `proj-<hash(旧路径)>`。
 *
 * 为什么必须以「一张纸 + 冻结的 id」为准，而不是每次由路径重算：
 * 会话存在 `workspaces/<id>/sessions/` 下，id 一旦随路径漂移，用户 `mv` 完目录再进去
 * 就会算出一个**新 id**，旧 id 下的历史还在盘上却没有任何入口能找回它 ——
 * 「挪个目录，历史就没了」。所以：
 *   - `workspace.json` 记着路径与名字（哈希不可逆，没有这张纸，盘上永远查不出
 *     `cli-3f9a1c2b` 是哪个目录）；
 *   - 路径变了要**显式**搬（`relocateWorkspace`：改那份记录的 path，id 不动），
 *     而不是由下一次 `resolve` 悄悄派生一个新身份。
 *
 * ## 路径比较一律先 `resolve()`
 *
 * 相对路径、尾部斜杠、`..` 都要收敛到同一个绝对路径再比：`/a/b/../c` 与 `/a/c` 是同一个
 * 工作区，`./proj` 与 `proj` 也是。只在这一层规范化一次，别处（handler / 客户端）不再各做
 * 一遍 —— 两份规范化迟早会在某个写法上判得不一样。
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, join, resolve } from "node:path";
import type {
  WorkspaceRelocateResult,
  WorkspaceRemoveResult,
  WorkspaceRenameResult,
  WorkspaceSummary,
} from "../../protocol/sessions.js";

export interface Workspace {
  id: string;
  /** 规范化后的绝对路径 */
  path: string;
  /** 该工作区的根目录（`<workspacesRoot>/<id>`） */
  rootDir: string;
  /** 显示名；`undefined` = 还没起过名（客户端拿目录 basename 兜底） */
  title?: string;
}

/**
 * `workspace.json` 里**本层认的**字段。
 *
 * 老记录只有 `{ schema, id, path, createdAt }`，没有 `title` —— 读的时候 `title` 就是
 * `undefined`，不补、也不为了补它去写盘（一次读不该改别人的文件）。`createdAt` 只是
 * 原样带过去，本层不用它排序（理由见 `listWorkspaces`）。
 */
interface WorkspaceRecord {
  path: string;
  title?: string;
  createdAt?: string;
}

/** 记录文件名。只此一处写死（读写都从这里取） */
const RECORD_FILE = "workspace.json";

/** 由工作目录路径算出稳定的 workspaceId（不碰磁盘）—— id 的**唯一**算法 */
export function workspaceIdFor(path: string): string {
  const absolute = resolve(path);
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 8);
  const name = basename(absolute)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `${name || "root"}-${hash}`;
}

/**
 * 由 `workspaceId` 找回工作区（读 `workspace.json`；没有这个工作区时返回 `null`）。
 *
 * ## 为什么需要「反查」
 *
 * 客户端只带 `workspaceId` 的调用（`workspace.files`、`session.last`、`session.create`
 * 不给 path 的那条路）拿不到路径：路径是**服务端**的磁盘事实，客户端知道的只是 id。
 * 而 id 是哈希派生的，光看 id 推不回路径 —— `workspace.json` 就是为此留的那张纸。
 *
 * 返回 `null` 而不是抛错：调用方（处理器）要把它变成带 code 的协议错误，
 * 「有没有这个工作区」是调用方的判断，不是本函数的异常语义。
 */
export async function readWorkspace(options: {
  workspacesRoot: string;
  id: string;
}): Promise<Workspace | null> {
  const found = await recordOf(options.workspacesRoot, options.id);
  if (!found) return null;
  return {
    id: options.id,
    path: found.record.path,
    rootDir: found.rootDir,
    ...(found.record.title ? { title: found.record.title } : {}),
  };
}

/**
 * 确保这个路径有一份工作区记录，返回它的身份与位置（`workspace.resolve` 的实现）。
 *
 * 三条分支，顺序就是它们的代价顺序：
 *
 *   1. **快路径**：`workspaceIdFor(path)` 命中的记录存在**且 path 与它一致** → 直接用。
 *      绝大多数调用走这条（客户端启动第一句就是它），代价是**一次**读文件，不扫目录。
 *   2. **慢路径**：快路径不命中时，扫 `<workspacesRoot>` 下每个工作区目录里的
 *      `workspace.json`，找 `path === 目标路径` 的记录，命中就复用**那个 id**。
 *      什么时候会走到这里：
 *      这个目录被 `mv` 过、而记录已经被 `relocateWorkspace` 指到新路径 —— 冻结的 id
 *      不再等于 `workspaceIdFor(当前路径)`。**这是目录改名之后重新进入该目录的唯一入口**：
 *      不扫这一遍，用户 `mv` 完就再也找不回自己的历史（会话还在 `<旧id>/sessions/` 下）。
 *   3. **新建**：都不命中 → 写下一条新记录，id 用 `workspaceIdFor(path)` 算出来的值
 *      （形状不变：`目录名-8位hash`），此后**永不再改**。
 *
 * 已存在就**不重写**记录：那份记录是首次认定的路径与名字，改目录名不该让旧记录被悄悄
 * 改写（要改只有两条明确的路：`relocateWorkspace` / `renameWorkspace`）。
 */
export async function ensureWorkspace(options: {
  workspacesRoot: string;
  path: string;
}): Promise<Workspace> {
  const absolute = resolve(options.path);

  // 1) 快路径。`derived` 非空但 path 不同 = 这个 id 归**另一个**目录（relocate 之后
  //    的正常局面），不能拿它当本目录的身份 —— 继续往下找。
  const derivedId = workspaceIdFor(absolute);
  const derived = await readWorkspace({ workspacesRoot: options.workspacesRoot, id: derivedId });
  if (derived?.path === absolute) return derived;

  // 2) 慢路径：盘上有没有一份记录说的正是这个路径（不管它挂在哪个 id 下）。
  const found = await findByPath(options.workspacesRoot, absolute);
  if (found) {
    return {
      id: found.id,
      path: absolute,
      rootDir: found.rootDir,
      ...(found.record.title ? { title: found.record.title } : {}),
    };
  }

  // 3) 新建。id 的候选是派生值；若那个 id 已被别的路径占着（`derived` 非空就是这种情况：
  //    id 冻结之后就存在「同一个派生值归老记录」的局面），只能往后找空位 —— 绝不能拿
  //    派生值去覆盖那份记录，那会把一段历史悄悄接到另一个目录上（正是本文件要修的病）。
  const id =
    derived === null ? derivedId : await nextFreeWorkspaceId(options.workspacesRoot, derivedId);
  const rootDir = join(options.workspacesRoot, id);
  await writeRecord(rootDir, id, { path: absolute, createdAt: new Date().toISOString() });
  return { id, path: absolute, rootDir };
}

/**
 * 盘上全部工作区（`workspace.list`）。
 *
 * `pathExists` 是这一版的要害：路径是一个**可以随时被 `mv` / `rm` 掉**的事实，而记录是
 * 冻结的。目录不在了就要让客户端看见（提示用户去修），而不是让它在列表里静默失踪 ——
 * 那等于「挪个目录，历史就没了」的另一种形态。
 *
 * ## 顺序（确定的一种，写在这里而不是让调用方猜）
 *
 * 显示名（`title`，缺省用目录 basename）的码位序，同名再按 id。
 *   - 不按 `updatedAt`：工作区记录里没有它（`createdAt` 是「首次认定」的时间，改完名
 *     不会变），按它排也挡不住「两次调用顺序抖动」；
 *   - id 唯一 ⇒ 这是一个**全序**：同一份盘两次调用顺序一致，客户端不必自己重排；
 *   - 不用 `localeCompare`：它读进程级 locale，本包不读全局（服务端同时接中英文客户端时，
 *     列表顺序不该随服务端机器的 locale 漂）。
 */
export async function listWorkspaces(options: {
  workspacesRoot: string;
}): Promise<WorkspaceSummary[]> {
  const scanned = await scanWorkspaces(options.workspacesRoot);
  const summaries = await Promise.all(
    scanned.map(async (item): Promise<WorkspaceSummary> => {
      return {
        workspaceId: item.id,
        ...(item.record.title ? { title: item.record.title } : {}),
        path: item.record.path,
        pathExists: await pathExists(item.record.path),
      };
    }),
  );
  return summaries.sort(
    (a, b) => compare(displayNameOf(a), displayNameOf(b)) || compare(a.workspaceId, b.workspaceId),
  );
}

/**
 * 改显示名（`workspace.rename`）：**不动 id、不动 path**，只写 `title`。
 *
 * 与 `session.rename` 同名同义。名字是给人看的，不是身份：拿它当身份就会出现
 * 「改个名字，历史没了」。空标题回 `bad-params` —— 「没名字」的表示是 `title` 缺席
 * （客户端拿 basename 兜底），不是空串。
 */
export async function renameWorkspace(options: {
  workspacesRoot: string;
  id: string;
  title: string;
}): Promise<WorkspaceRenameResult> {
  const title = options.title.trim();
  if (!title) throw codedError("bad-params", "title must not be empty");

  const found = await recordOf(options.workspacesRoot, options.id);
  if (!found) throw codedError("unknown-workspace", `unknown workspace: ${options.id}`);
  // 只改 title，其余字段原样带回去（`path` / `createdAt` 一个字都不动）
  await writeRecord(found.rootDir, options.id, { ...found.record, title });
  return { workspaceId: options.id, title };
}

/**
 * 删工作区：**连它的全部会话一起**（`<workspacesRoot>/<id>/` 整个目录，含 `sessions/`
 * 与「上一轮会话」指针）。
 *
 * 这就是「把这个工作区和它的全部会话一起删」的语义 —— 不是只删一条记录、把历史留成
 * 孤儿目录。想删一段会话用 `session.remove`（它只动 `sessions/` 里的一个存档）。
 *
 * 幂等：本来就不在 → `removed: false`（与 `agent.remove` / `session.remove` 同一口径）。
 * 删的是**目录本身**而不是那份记录：记录被手改坏、目录还在时，用户更需要的是能删掉它，
 * 而不是一个 `removed:false` 加一堆谁也清不掉的残留。
 */
export async function removeWorkspace(options: {
  workspacesRoot: string;
  id: string;
}): Promise<WorkspaceRemoveResult> {
  // id 直接来自客户端参数，先挡住逃出 workspacesRoot 的写法（`join()` 不认 `..`）
  if (!isSafeId(options.id)) return { removed: false };
  const rootDir = join(options.workspacesRoot, options.id);
  const existed = await pathExists(rootDir);
  await fs.rm(rootDir, { recursive: true, force: true });
  return { removed: existed };
}

/**
 * 把工作区记录的 path 改到新目录（`workspace.relocate`）：**id 不变**。
 *
 * 这是「目录改名之后历史不丢」的另一半：客户端拿着旧 id 调它，此后任何人再对**新路径**
 * `resolve`，`ensureWorkspace` 的慢路径都会扫到这份记录、复用同一个 id —— 于是
 * `sessions/` 里那份历史又能被列出来。
 *
 * 三条约束都是「不替用户猜」：
 *   - 新路径必须**已存在**（`workspace-path-missing`）：`mkdir` 是用户的动作；服务端替他
 *     建一个空目录，等于把历史接到一个空目录上 —— 用户以为接着聊，其实进了新目录；
 *   - 该路径不能已被**另一个**工作区记录占着（`workspace-exists`）：两份记录指同一个目录，
 *     会话就会在两个 id 下各长一份，谁也不知道哪份是真的；
 *   - id 不动：它就是历史所在的那个目录名。
 */
export async function relocateWorkspace(options: {
  workspacesRoot: string;
  id: string;
  path: string;
}): Promise<WorkspaceRelocateResult> {
  const found = await recordOf(options.workspacesRoot, options.id);
  if (!found) throw codedError("unknown-workspace", `unknown workspace: ${options.id}`);

  const absolute = resolve(options.path);
  await requireWorkspacePath(absolute);

  const occupant = await findByPath(options.workspacesRoot, absolute);
  if (occupant && occupant.id !== options.id) {
    throw codedError("workspace-exists", `workspace already exists: ${absolute}`);
  }
  await writeRecord(found.rootDir, options.id, { ...found.record, path: absolute });
  return { workspaceId: options.id, path: absolute };
}

/**
 * 确认工作区路径此刻还在（`session.create` 的前置条件，`relocateWorkspace` 也用它）。
 *
 * 为什么**必须**报错而不是替用户 `mkdir`：开会话时目录已经不在了，说明用户手里的工作区
 * 是被改名 / 删除 / 移动过的。悄悄建一个空目录让他「接着聊」，聊的其实是另一个空目录
 * （历史还在旧 id 的 `sessions/` 里），这是最坏的失败形态 —— 用户以为续上了，实际从头开始。
 *
 * 与 `listWorkspaces` 的 `pathExists` 是**同一条判断**：客户端看见 `pathExists:false`
 * 与开会话时拿到 `workspace-path-missing`，说的必须是同一件事。
 */
export async function requireWorkspacePath(path: string): Promise<void> {
  if (await pathExists(path)) return;
  throw codedError("workspace-path-missing", `workspace path does not exist: ${path}`);
}

/**
 * 读一条记录（含它的根目录）。
 *
 * id 来自客户端参数的**安全判定只在这里做一次**（`readWorkspace` 与三个写操作共用）：
 * 逃出 `workspacesRoot` 的写法一律当作「没有这个工作区」，与 `FileSessionStore` 里挡
 * 会话 id 同一个理由。
 */
async function recordOf(
  workspacesRoot: string,
  id: string,
): Promise<{ rootDir: string; record: WorkspaceRecord } | null> {
  if (!isSafeId(id)) return null;
  const rootDir = join(workspacesRoot, id);
  const record = await readRecord(rootDir);
  return record ? { rootDir, record } : null;
}

/**
 * 读一条记录的字段（不碰 id / 根目录）。
 *
 * 形状不对（旧版残留、手改坏、只有 `path` 之外的半截）一律当作没有，不猜。老记录没有
 * `title` 是**正常**的：它不在返回值里，调用方就当「还没起过名」。
 */
async function readRecord(rootDir: string): Promise<WorkspaceRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(join(rootDir, RECORD_FILE), "utf-8")) as {
      path?: unknown;
      title?: unknown;
      createdAt?: unknown;
    } | null;
    if (typeof parsed?.path !== "string" || parsed.path.length === 0) return null;
    return {
      path: parsed.path,
      ...(typeof parsed.title === "string" && parsed.title.length > 0
        ? { title: parsed.title }
        : {}),
      ...(typeof parsed.createdAt === "string" ? { createdAt: parsed.createdAt } : {}),
    };
  } catch {
    return null; // 没有这个工作区（目录或记录不存在 / 读不动）
  }
}

/**
 * 原子写一条记录 —— 「`workspace.json` 怎么写」的**唯一**实现（新建 / 改名 / 重定位共用）。
 *
 * 先写 `<file>.tmp` 再 `rename`：进程在写一半被杀会留下半截 JSON，读回来解析失败 ——
 * 整个工作区就此「不存在」，它的会话也跟着失去入口。同一文件系统内 rename 是原子的，
 * 任何时刻读到的要么是旧记录、要么是完整的新记录。并发（两个前端同时首次进入同一目录）
 * 时最多覆盖成同一份内容。
 */
async function writeRecord(rootDir: string, id: string, record: WorkspaceRecord): Promise<void> {
  await fs.mkdir(rootDir, { recursive: true });
  const target = join(rootDir, RECORD_FILE);
  const tmp = `${target}.tmp`;
  const body = { schema: 1, id, ...record };
  await fs.writeFile(tmp, JSON.stringify(body, null, 2), "utf-8");
  await fs.rename(tmp, target);
}

/** 一条扫出来的工作区（记录 + 它所在的根目录） */
interface ScannedWorkspace {
  id: string;
  rootDir: string;
  record: WorkspaceRecord;
}

/**
 * 扫 `<workspacesRoot>` 下每个子目录里的 `workspace.json`。
 *
 * 「盘上有哪些工作区」只有这一份实现：`listWorkspaces` 与 `ensureWorkspace` 的慢路径都走它，
 * 谁也不另写一遍目录遍历。没有 `<workspacesRoot>` 目录时回空表（还没建过工作区，不是错误）。
 */
async function scanWorkspaces(workspacesRoot: string): Promise<ScannedWorkspace[]> {
  let names: string[];
  try {
    names = await fs.readdir(workspacesRoot);
  } catch {
    return [];
  }
  const found: ScannedWorkspace[] = [];
  for (const name of names) {
    const rootDir = join(workspacesRoot, name);
    const record = await readRecord(rootDir);
    // 不是目录、没有记录、记录写坏：都不是工作区（`readdir` 的结果里两者都有）
    if (!record) continue;
    found.push({ id: name, rootDir, record });
  }
  return found;
}

/**
 * 由**路径**找回已有记录 —— 就是 `ensureWorkspace` 的慢路径。
 *
 * 只在不命中快路径时调用（见那里的三条分支），代价是 O(<工作区数>) 次 `readFile`。
 * 正常启动（id 没漂）一次都不会走到：快路径一次读文件就够了。
 */
async function findByPath(workspacesRoot: string, path: string): Promise<ScannedWorkspace | null> {
  const scanned = await scanWorkspaces(workspacesRoot);
  return scanned.find((item) => item.record.path === path) ?? null;
}

/**
 * 派生 id 被占用时往后找空位（`<base>-2`、`<base>-3`…）。
 *
 * 只给 `ensureWorkspace` 的新建分支用，且调用方已确认 `<base>` 被占：id 冻结之后，
 * 「派生值」只是一个候选，不代表它没被别人用着。
 */
async function nextFreeWorkspaceId(workspacesRoot: string, base: string): Promise<string> {
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!(await readWorkspace({ workspacesRoot, id: candidate }))) return candidate;
  }
}

/**
 * 这个路径此刻是不是一个**目录**。
 *
 * 用 `stat` 而不是 `access`：工作区的 path 是 Agent 的 cwd，一个同名的普通文件占着它
 * 同样算「这个工作区没了」（工具一进去就会失败）。两处判断共用它：`pathExists` 与
 * `session.create` 的前置条件。
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 列表里那一行的显示名：起过名用名字，没起过用目录 basename（与客户端兜底口径一致） */
function displayNameOf(summary: WorkspaceSummary): string {
  return summary.title ?? basename(summary.path);
}

/** 码位序（不用 `localeCompare`：那是进程级 locale，理由见 `listWorkspaces`） */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 带机器可判别 code 的错误。与 `SessionManager` / `ConfigService` / `AssetService` 里
 * 同一个写法：每个服务自带一份，服务层不 import `daemon/`（依赖方向是 daemon → service）。
 */
function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error as Error & { code: string };
}

/** 工作区 id 只做目录名用：不许带分隔符、不许是 `.` / `..`（子目录不是工作区的概念） */
function isSafeId(id: string): boolean {
  return id.length > 0 && id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\");
}
