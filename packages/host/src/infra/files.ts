import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** 文件不在返回 `undefined`；其它读失败照抛 */
export function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throwWithCause(`Cannot read file "${path}"`, error);
  }
}

/** 原子写：先写同目录临时文件再 `rename` */
export function writeTextFile(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, path);
  } catch (error) {
    throwWithCause(`Cannot write file "${path}"`, error);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** 建目录，已存在是 no-op */
export function ensureDirectory(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    throwWithCause(`Cannot create directory "${path}"`, error);
  }
}

function throwWithCause(fact: string, cause: unknown): never {
  const context = cause instanceof Error ? cause.message : String(cause);
  throw new Error(`${fact}: ${context}`, { cause });
}
