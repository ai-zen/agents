import type { LogSink } from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import { writeVersionPin } from "../../infra/versionPin.js";
import type { Translator } from "../i18n/index.js";

/**
 * registry 上这个包的那一格。`<包名>/<版本>` 是一个具体版本的元数据，2xx 即「这个号在」——
 * 不问 dist-tag、也不做 semver 比较：挑版本是客户端的事。
 */
const REGISTRY = "https://registry.npmjs.org/@ai-zen/agents-host";

/** 一个具体的版本号：三段数字，可带预发布或构建后缀。范围（`^2.0.0`）与 tag（`latest`、`next`）都不认 */
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface UpdateDeps {
  /** `<数据根>/run/next-version.json`：写下这条 pin，拉起那一侧才知道下次该跑哪一版 */
  readonly pinFile: string;
  /** 磁盘上那一份（现读）的版本 */
  readonly installedVersion: () => string;
  /** 问 registry 有没有这个号；网络不通、404 都回 false */
  readonly registryHas: (version: string) => Promise<boolean>;
  /** 验过、pin 也写了之后请宿主退出（由装配根接上） */
  readonly requestRestart: (version: string) => void;
  readonly t: Translator;
  readonly log: LogSink;
}

/**
 * 升级的三段分工里，宿主只做第 ② 段：验「这一版拿得到」→ 写 pin → 以升级为理由退出。
 *
 * 第 ① 段（挑版本）是客户端的事：它去各 dist-tag 里取 semver 最高，再把这个号告诉宿主，所以
 * {@link upgrade} 只收一个具体的版本号。第 ③ 段（拉起）是启动方式的事：它读 pin、把那一版装
 * 下来再起。装包与拉起都不在这里 —— 宿主不 re-exec 自己，也不碰 npm。
 */
export class UpdateService {
  constructor(private readonly deps: UpdateDeps) {}

  /** 现在是哪一版（客户端要显示的那一格）。现读：就地换过之后，这个答案要跟着变 */
  version(): string {
    return this.deps.installedVersion();
  }

  /**
   * 两条判据验「这一版拿得到」，成立就写 pin 并请宿主退出，不成立就报 `not_available` 而
   * **不退出** —— 把「这一版不存在」挡在弄死服务之前。
   */
  async upgrade(version: string): Promise<{ version: string; restarting: true }> {
    if (!VERSION.test(version)) {
      throw new HostError(
        "invalid_params",
        this.deps.t("{version} 不是一个具体的版本号：挑版本是客户端的事，宿主只认一个号", {
          version,
        }),
        { version },
      );
    }

    // 判据 A：磁盘上那份 `package.json` 已经是目标。就地换过的三种形状（桌面端、docker、
    // `npm i -g`）里，这个问题的答案就在磁盘上，不必再出一次网
    const installed = this.deps.installedVersion() === version;
    // 判据 B：`npx` 拉起的宿主，它自己那一份永不变化，只有 registry 说得出这个号在不在
    const available = installed ? true : await this.deps.registryHas(version);

    if (!available) {
      throw new HostError(
        "not_available",
        this.deps.t("{version} 在 registry 上没有，磁盘上也不是这一版", { version }),
        { version },
      );
    }

    // pin 先落盘、再请退出：反过来的话，启动方式可能在 pin 还不存在的那一刻就把服务拉起来，
    // 于是它拉起的还是老版本
    writeVersionPin(this.deps.pinFile, { version, requestedAt: new Date().toISOString() });
    // 这是「请」，不是「做」：真正把新版拉起来的是启动方式
    this.deps.requestRestart(version);

    return { version, restarting: true };
  }
}

/**
 * 判据 B 的默认实现：问 registry 有没有这个号。
 *
 * 网络不通与 404 是同一个结论（这一版拿不到），所以都不抛，只记一句日志 —— 抛出去会把一次
 * 「升不上去」变成一次「宿主内部出错」，而前者客户端要按 `not_available` 说清是哪一段没成。
 */
export async function registryHasVersion(version: string, log: LogSink): Promise<boolean> {
  const url = `${REGISTRY}/${version}`;
  try {
    const response = await fetch(url);
    return response.ok;
  } catch (error) {
    log.warn(`Cannot reach the registry for "${url}"`, { error });
    return false;
  }
}
