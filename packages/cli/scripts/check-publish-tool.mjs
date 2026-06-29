#!/usr/bin/env node

/**
 * 检查发布工具是否为 pnpm
 * 防止误用 npm publish 导致 workspace:* 协议未被替换的问题
 */

const execPath = process.env.npm_execpath || '';
const userAgent = process.env.npm_config_user_agent || '';

const isPnpm = execPath.includes('pnpm') || userAgent.includes('pnpm');

if (!isPnpm) {
  console.error('');
  console.error('  ❌ 发布失败：检测到使用 npm 发布！');
  console.error('');
  console.error('     本项目的依赖使用了 pnpm workspace 协议 (workspace:*)');
  console.error('     使用 npm publish 会导致 workspace:* 无法被正确替换为实际版本号');
  console.error('     从而导致用户安装时找不到依赖包而失败。');
  console.error('');
  console.error('  ✅ 请使用以下命令发布：');
  console.error('     pnpm publish');
  console.error('');
  process.exit(1);
}

console.log('  ✅ 发布工具检测通过 (pnpm)');
