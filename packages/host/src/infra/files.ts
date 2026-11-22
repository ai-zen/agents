import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** 文件不在返回 `undefined`；其它读失败照抛 */
export function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throwWithCause(`Cannot read file "${path}"`, error);
  }
}

/**
 * 原子写：先写同目录临时文件再 `rename`。
 *
 * `mode` 是**尽力而为**：`rename` 保得住临时文件建出来时的权限，但目标文件已经存在时它改不动
 * 既有权限，所以写完再 `chmod` 一次；`chmod` 失败不报错（Windows 上它本来就是空操作，那里的
 * 保护来自目录的访问控制）。没有权限保证这回事，`0600` 只是让同机其他用户读不到。
 */
export function writeTextFile(path: string, content: string, mode?: number): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, mode === undefined ? {} : { mode });
    renameSync(temporary, path);
    if (mode !== undefined) {
      try {
        chmodSync(path, mode);
      } catch {
        // 见上：权限是尽力而为，设不上不影响内容已经写对
      }
    }
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
