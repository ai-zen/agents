import { dirname } from "node:path";

import { ensureDirectory, readTextFile, writeTextFile } from "../../infra/files.js";

import type { CredentialService } from "./service.js";

/**
 * 保证本地凭证交付文件 `file` 里放着这一串能用得上的明文。
 *
 * 判据只有「库里认不认这一串」：文件不存在、内容为空、那一串已吊销，三种处境的结论相同，都不该
 * 继续交付，所以不各写一支。认的那一串原样留着，不重写 —— 重启时换一串新的，会让客户端上次读走
 * 的那串随宿主重启一起失效。
 */
export function ensureLocalToken(credentials: CredentialService, file: string): void {
  // 写进去的内容带一个换行，读回来必须先 `trim`：拿带换行的原样去 `verify` 永远查不到，于是每次
  // 启动都会新造一串
  const delivered = readTextFile(file)?.trim() ?? "";
  if (delivered !== "" && credentials.verify(delivered) !== undefined) return;

  const { token } = credentials.create("local");
  // `writeTextFile` 只往目标目录里写临时文件，不建目录；而 `run/` 在首次启动时还不存在
  ensureDirectory(dirname(file));
  writeTextFile(file, `${token}\n`, 0o600);
}
