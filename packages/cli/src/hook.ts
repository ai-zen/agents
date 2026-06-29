import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

const MARKER_START = "# === aiz hook (开始) ===";
const MARKER_END = "# === aiz hook (结束) ===";

function detectShell(): { rcFile: string; hookFn: string } | null {
  const shell = process.env.SHELL || "";
  const home = homedir();

  if (shell.includes("zsh")) {
    return { rcFile: join(home, ".zshrc"), hookFn: "command_not_found_handler" };
  }
  if (shell.includes("bash")) {
    return { rcFile: join(home, ".bashrc"), hookFn: "command_not_found_handle" };
  }
  return null;
}

function hookCode(hookFn: string): string {
  return [
    "",
    MARKER_START,
    `${hookFn}() {`,
    '  aiz "$@"',
    "}",
    MARKER_END,
    "",
  ].join("\n");
}

function isInstalled(rcFile: string): boolean {
  if (!existsSync(rcFile)) return false;
  const content = readFileSync(rcFile, "utf-8");
  return content.includes(MARKER_START);
}

export function installHook(): void {
  const shell = detectShell();
  if (!shell) {
    console.error("❌ 不支持的 shell（仅支持 bash / zsh）");
    process.exit(1);
  }

  if (isInstalled(shell.rcFile)) {
    console.log("ℹ️  aiz hook 已安装，无需重复操作");
    return;
  }

  appendFileSync(shell.rcFile, hookCode(shell.hookFn), "utf-8");
  console.log(`✅ aiz hook 已安装到 ${shell.rcFile}`);
  console.log(`   重启终端或执行 source ${shell.rcFile} 即可生效`);
  console.log(`   之后输入不存在的命令会自动转发给 AI 处理`);
}

export function uninstallHook(): void {
  const shell = detectShell();
  if (!shell) {
    console.error("❌ 不支持的 shell（仅支持 bash / zsh）");
    process.exit(1);
  }

  if (!existsSync(shell.rcFile)) {
    console.log("ℹ️  aiz hook 未安装（文件不存在）");
    return;
  }

  const content = readFileSync(shell.rcFile, "utf-8");
  if (!content.includes(MARKER_START)) {
    console.log("ℹ️  aiz hook 未安装");
    return;
  }

  const lines = content.split("\n");
  const newLines: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === MARKER_START) {
      skipping = true;
      continue;
    }
    if (line.trim() === MARKER_END) {
      skipping = false;
      continue;
    }
    if (!skipping) {
      newLines.push(line);
    }
  }

  writeFileSync(shell.rcFile, newLines.join("\n"), "utf-8");
  console.log(`✅ aiz hook 已从 ${shell.rcFile} 卸载`);
}
