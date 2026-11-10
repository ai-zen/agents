/**
 * 资产清单 —— `asset.list` 的服务端实现（**只读**）。
 *
 * ## 为什么这一层不自己扫目录
 *
 * 「扫哪些目录、同名谁优先、什么算一个 skill、哪些文件是工具」这套规则在 SDK 的发现逻辑里
 * （`discoverSkills` / `discoverUserToolFiles`），Agent 装配用的也是它。这里再写一份目录扫描，
 * 就会有两份规则：Agent 实际装了 12 个 skill，面板上列出 9 个，用户以为坏了 —— 而且这种偏差
 * 是慢慢长出来的（先少一个目录，再少一种扩展名）。所以本模块只做三件事：
 *
 *   1. **选层**：按 `scope` 从 `agentPaths.assetDirs` 的三份目录表里挑（分层定义只在那里）；
 *   2. **标注**：给每条资产标 `source`（项目层 / 全局层）；
 *   3. **收窄**：把 SDK 的发现结果压成 `AssetSummary`（列表要的是「一行怎么显示」，
 *      不是正文、不是工具参数表）。
 *
 * ## 一个要留意的代价
 *
 * 列**工具**清单会真的 `import()` 那些文件（SDK 的发现本来就是「加载成 Tool 实例」），
 * 也就是会执行用户的代码。这不是本模块引入的（Agent 装配每次刷新都在做同一件事，且 SDK
 * 侧接着宿主护栏：`process.exit` 被接管、控制台输出被改道、挂死的 import 有超时），但它是
 * 「只读清单」这句话的一个例外，写在这里以免下次有人以为列清单是纯文件操作。
 *
 * ## 工作区路径只能反查
 *
 * 项目层资产挂在工作区路径上，而调用方只有 `workspaceId`（路径是**服务端**的磁盘事实）。
 * 反查失败回 `unknown-workspace`，不是「空清单」—— 一个看起来成功、实际什么都没扫到的
 * 回答，会让用户以为项目里压根没有 skill。
 */

import { isAbsolute, relative } from "node:path";
import { discoverSkills, discoverUserToolFiles } from "@ai-zen/agents-sdk";
import { ERROR_CODES, codedError } from "@ai-zen/agents-protocol";
import type {
  AssetListParams,
  AssetListResult,
  AssetScope,
  AssetSummary,
} from "@ai-zen/agents-protocol";
import { readWorkspace } from "../workspace/workspace.js";
import { assetDirs } from "../agent/agentPaths.js";

export interface AssetServiceOptions {
  /** 配置根（`~/.ai-zen`）：全局层资产在 `<aiZenDir>/skills` 与 `<aiZenDir>/tools` */
  aiZenDir: string;
  /** 用户主目录（`~/.agents/skills` 那层） */
  homeDir: string;
  /** `<aiZenDir>/workspaces`：项目层要靠它把 workspaceId 反查成路径 */
  workspacesRoot: string;
}

export class AssetService {
  private readonly options: AssetServiceOptions;

  constructor(options: AssetServiceOptions) {
    this.options = options;
  }

  /**
   * 列资产。
   *
   * `scope` 缺省 = 两层都列（项目层在前，于是同名时项目层覆盖全局层 —— 与能力发现同一个
   * 优先级）。没给 `workspaceId` 时项目层无从谈起，于是只有全局层那几条：不猜「你说的项目
   * 是哪个」（`scope: "project"` 缺 `workspaceId` 已在协议层当参数错挡掉）。
   */
  async list(input: AssetListParams): Promise<AssetListResult> {
    const workspacePath = await this.workspacePathOf(input);
    const dirs = assetDirs({ ...this.options, workspacePath });

    // 只把**请求的那几层**交给发现（不是全扫完再过滤）：两层同名时靠前的层胜出，
    // 先扫全再按 source 过滤会把「项目层覆盖了全局层」这条规则在过滤之后丢掉
    // —— `scope: "global"` 会列出一个其实已经被项目层盖掉的名字。
    const skillsDirs =
      input.scope === "global"
        ? dirs.global.skillsDirs
        : input.scope === "project"
          ? dirs.project.skillsDirs
          : dirs.skillsDirs;
    const toolsDirs =
      input.scope === "global"
        ? dirs.global.toolsDirs
        : input.scope === "project"
          ? dirs.project.toolsDirs
          : dirs.toolsDirs;

    const assets =
      input.kind === "skill"
        ? await skillsIn(skillsDirs, workspacePath)
        : await toolsIn(toolsDirs, workspacePath);

    return { assets };
  }

  /** 需要项目层时把 `workspaceId` 反查成路径；否则返回 `null`（不问项目层） */
  private async workspacePathOf(input: AssetListParams): Promise<string | null> {
    // 只看全局层：压根不需要工作区（也就不该因为「工作区不存在」而失败）
    if (input.scope === "global") return null;
    if (!input.workspaceId) return null;
    const workspace = await readWorkspace({
      workspacesRoot: this.options.workspacesRoot,
      id: input.workspaceId,
    });
    if (!workspace) {
      throw codedError(ERROR_CODES.unknownWorkspace, `unknown workspace: ${input.workspaceId}`);
    }
    return workspace.path;
  }
}

/** 技能：SDK 发现的结果 → 列表条目（`dirPath` 就是它的位置） */
async function skillsIn(dirs: string[], workspacePath: string | null): Promise<AssetSummary[]> {
  const skills = await discoverSkills(dirs, { silent: true });
  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    // 空描述当作没有：客户端不必为「空串」与「没这个字段」写两个分支
    ...(skill.description ? { description: skill.description } : {}),
    source: sourceOf(skill.dirPath, workspacePath),
    // skill 的单位是**目录**（多文件，`SKILL.md` 在它里面）
    path: skill.dirPath,
  }));
}

/** 用户工具：同上，但单位是**文件**（一个工具就是一个模块） */
async function toolsIn(dirs: string[], workspacePath: string | null): Promise<AssetSummary[]> {
  const files = await discoverUserToolFiles(dirs, { silent: true });
  return files.map((file) => {
    const definition = file.tool.function;
    return {
      // id = 文件名：它才是发现时去重用的那个键（同名文件跨目录只留靠前那个）
      id: file.name,
      name: definition?.name ?? file.name,
      ...(definition?.description ? { description: definition.description } : {}),
      source: sourceOf(file.path, workspacePath),
      path: file.path,
    };
  });
}

/**
 * 一条资产属于哪一层 —— 「项目级」的定义就是**它挂在工作区路径下**。
 *
 * 只此一处判定：目录表已经按层分好了，但合并列表里要能标出来源，而按路径归属来标是最不
 * 会漂的办法（往分层表里再塞一个 `source` 字段，就会出现「目录改了、标注忘了」）。
 */
function sourceOf(path: string, workspacePath: string | null): AssetScope {
  if (!workspacePath) return "global";
  const relativePath = relative(workspacePath, path);
  return relativePath.startsWith("..") || isAbsolute(relativePath) ? "global" : "project";
}
