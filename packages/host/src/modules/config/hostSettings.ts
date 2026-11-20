import { dirname } from "node:path";

import { ensureDirectory, readTextFile, writeTextFile } from "../../infra/files.js";

/** 端口的三档优先级：启动参数 > `<数据根>/host.json` > 这个数（启动参数那一档在启动处，不在这里） */
const DEFAULT_PORT = 8790;

interface HostSettingsFile {
  port?: number;
}

export interface HostSettingsDeps {
  /** `<数据根>/host.json`：宿主自己的设置，与用户配置 `config.json` 分开存 */
  readonly path: string;
}

export class HostSettings {
  constructor(private readonly deps: HostSettingsDeps) {}

  port(): number {
    const text = readTextFile(this.deps.path);
    if (text === undefined) return DEFAULT_PORT;
    try {
      return (JSON.parse(text) as HostSettingsFile).port ?? DEFAULT_PORT;
    } catch (cause) {
      throw new Error(`Cannot parse host settings "${this.deps.path}"`, { cause });
    }
  }

  setPort(port: number): void {
    ensureDirectory(dirname(this.deps.path));
    writeTextFile(this.deps.path, `${JSON.stringify({ port }, null, 2)}\n`);
  }
}
