/**
 * 统一时间格式化工具
 *
 * 所有用户可见的时间文案统一使用 dayjs + zh-cn locale，
 * 确保各种场景（主菜单、对话列表、Agent 列表、草稿保存等）显示一致。
 */

import dayjs from "dayjs";
import "dayjs/locale/zh-cn.js";

// 全局设置中文 locale
dayjs.locale("zh-cn");

/**
 * 格式化时间戳为"相对时间"（用于列表展示）
 *
 * 规则：
 *   - 今天：     HH:mm
 *   - 昨天：     昨天 HH:mm
 *   - 今年：     M月D日 HH:mm
 *   - 更早：     YYYY年M月D日 HH:mm
 */
export function formatRelativeTime(isoString: string): string {
  const d = dayjs(isoString);
  const now = dayjs();

  if (d.isSame(now, "day")) {
    return d.format("HH:mm");
  }
  if (d.isSame(now.subtract(1, "day"), "day")) {
    return `昨天 ${d.format("HH:mm")}`;
  }
  if (d.isSame(now, "year")) {
    return d.format("M月D日 HH:mm");
  }
  return d.format("YYYY年M月D日 HH:mm");
}

/**
 * 格式化时间戳为完整中文格式（用于详情展示）
 * 例：2025年7月1日 14:30:00
 */
export function formatFullTime(isoString: string): string {
  return dayjs(isoString).format("YYYY年M月D日 HH:mm:ss");
}

/**
 * 格式化时间戳为保存名称用的格式，兼容文件名
 * 例：2025年07月01日_14时30分00秒
 */
export function formatShortTime(isoString: string): string {
  return dayjs(isoString).format("YYYY年MM月DD日HH时mm分ss秒");
}

/**
 * 格式化消息数量+时间（用于主菜单草稿提示）
 * 例：12 条消息, 今天 14:30
 */
export function formatMessageTime(messageCount: number, isoString: string): string {
  return `${messageCount} 条消息, ${formatRelativeTime(isoString)}`;
}

/**
 * 格式化文件大小为人类可读格式
 * 例：1.2 KB, 3.5 MB
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
