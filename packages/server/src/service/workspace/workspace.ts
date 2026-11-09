/**
 * 工作区（workspace）在盘上的身份与位置。
 *
 * 会话属于**工作区**，不属于某个前端：CLI、桌面端、将来的浏览器连同一台服务端时，
 * 看到的是同一份 `<aiZenDir>/workspaces/<workspaceId>/`（这是把会话搬出 `cli/` 的原因）。
 *
 * ## workspaceId 长什么样
 *
 * `<目录名规范化>-<sha256 前 8 位>`，例如 `/home/ubuntu/projects/ai-zen/cli` →
 * `cli-3f9a1c2b`。两条要求同时满足：
 *   - **认得出**：人 `ls` 一眼知道是哪个项目（纯哈希做不到）；
 *   - **不撞车**：目录名规范化会丢掉信息（`a/b-c` 与 `a-b/c` 同名），所以带路径哈希。
 * 同一目录的不同写法（相对路径、尾部斜杠）先 `resolve()` 再算，收敛成同一个 id。
 *
 * id 是**确定性派生**的，不需要注册表就能找回某个目录的会话：这一版先这样，
 * 等工作区成为真正的一等对象（有生命周期、可重命名、可远程）时，由注册表接管分配。
 *
 * `workspace.json` 记着原始路径 —— 哈希不可逆，没有这张纸，磁盘上永远查不出
 * `cli-3f9a1c2b` 到底是哪个目录。
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface Workspace {
  id: string;
  /** 规范化后的绝对路径 */
  path: string;
  /** 该工作区的根目录（`<workspacesRoot>/<id>`） */
  rootDir: string;
}

/** 由工作目录路径算出稳定的 workspaceId（不碰磁盘） */
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
 * 客户端只带 `workspaceId` 的调用（`workspace.files`、`session.last` 等）拿不到路径：
 * 路径是**服务端**的磁盘事实，客户端知道的只是 id。而 id 是哈希派生的（`workspaceIdFor`），
 * 光看 id 推不回路径 —— `workspace.json` 就是为此留的那张纸。
 *
 * 返回 `null` 而不是抛错：调用方（处理器）要把它变成带 code 的协议错误，
 * 「有没有这个工作区」是调用方的判断，不是本函数的异常语义。
 */
export async function readWorkspace(options: {
  workspacesRoot: string;
  id: string;
}): Promise<Workspace | null> {
  // id 直接来自客户端参数（`workspaceId`），必须先挡住逃出 workspacesRoot 的写法。
  // 与 `FileSessionStore` 里挡会话 id 同一个理由、同一处判断：`join()` 不认 `..`。
  if (!isSafeId(options.id)) return null;

  const rootDir = join(options.workspacesRoot, options.id);
  try {
    const parsed = JSON.parse(await fs.readFile(join(rootDir, "workspace.json"), "utf-8")) as {
      path?: unknown;
    };
    // 形状不对（旧版残留、手改坏）一律当作没有，不猜
    if (typeof parsed?.path !== "string" || parsed.path.length === 0) return null;
    return { id: options.id, path: parsed.path, rootDir };
  } catch {
    return null; // 没有这个工作区（目录或记录不存在 / 读不动）
  }
}

/**
 * 确保工作区目录存在，返回它的身份与位置。
 *
 * 会建 `<rootDir>/` 并写下 `workspace.json`（已存在就不动它：那份记录是**首次**
 * 认定的路径，改目录名不该让旧记录被悄悄改写）。
 */
export async function ensureWorkspace(options: {
  workspacesRoot: string;
  path: string;
}): Promise<Workspace> {
  const absolute = resolve(options.path);
  const id = workspaceIdFor(absolute);
  const rootDir = join(options.workspacesRoot, id);
  const recordPath = join(rootDir, "workspace.json");

  try {
    await fs.access(recordPath);
  } catch {
    await fs.mkdir(rootDir, { recursive: true });
    const tmp = `${recordPath}.tmp`;
    const record = { schema: 1, id, path: absolute, createdAt: new Date().toISOString() };
    await fs.writeFile(tmp, JSON.stringify(record, null, 2), "utf-8");
    // 原子换名：并发（两个前端同时首次进入同一目录）最多覆盖成同一份内容
    await fs.rename(tmp, recordPath);
  }

  return { id, path: absolute, rootDir };
}

/** 工作区 id 只做目录名用：不许带分隔符、不许是 `.` / `..`（子目录不是工作区的概念） */
function isSafeId(id: string): boolean {
  return id.length > 0 && id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\");
}
