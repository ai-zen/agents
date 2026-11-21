import { homedir } from "node:os";
import { join } from "node:path";

/** 数据根：环境变量 `AI_ZEN_DIR`，缺省 `~/.ai-zen`。宿主与命令行读同一处，谁都不自己算一遍 */
export function resolveDataRoot(): string {
  return process.env.AI_ZEN_DIR ?? join(homedir(), ".ai-zen");
}

/**
 * 数据根下那几个固定位置。
 *
 * 宿主与命令行读同一份：库名、日志目录、助手目录、`run/` 下那三份文件，各出现在这里一次。
 * `run/` 下的三份各是一个交付口：`host.json` 说连哪儿，`token` 给本机客户端一串能用的凭证明文，
 * `next-version.json` 说下次该跑哪一版。
 */
export interface HostPaths {
  readonly dataRoot: string;
  readonly databaseFile: string;
  readonly logs: string;
  readonly agents: string;
  readonly run: string;
  readonly hostFile: string;
  readonly tokenFile: string;
  /**
   * 升级 pin：下次该跑哪一版。
   *
   * 与 `hostFile` 是两件事：那个说「此刻谁在服务」，这个说「下一拍该跑哪一版」。宿主不自己
   * 拉起自己，所以这件事只能落在文件上，由启动方式去读。
   */
  readonly versionPinFile: string;
}

export function hostPaths(dataRoot: string): HostPaths {
  const run = join(dataRoot, "run");
  return {
    dataRoot,
    databaseFile: join(dataRoot, "ai-zen.db"),
    logs: join(dataRoot, "logs"),
    agents: join(dataRoot, "agents"),
    run,
    hostFile: join(run, "host.json"),
    tokenFile: join(run, "token"),
    versionPinFile: join(run, "next-version.json"),
  };
}
