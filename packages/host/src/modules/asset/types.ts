/**
 * 段上的本地标记：内容段里指回 `assets` 表那一行的 id（PRD 原文：`__asset_id` 只是本地标记）。
 *
 * 它不在 `AgentNS.MessageContentSection` 的类型里 —— 它是本机的扩展键，落库那一份原样带着它，
 * 出网那一份由 core 的字段白名单剥掉。写与读它的地方只有三处：宿主投递时数一遍（一条最多 4 张）、
 * 观察者落库时登记引用，以及发出去之前按实发模型重建（SDK 的 `AssetTransportPlugin`）。
 */
export const ASSET_ID_KEY = "__asset_id";

/**
 * Asset 行：一份上传的文件。字节在 `<数据根>/assets/<sha256>`，行里只记这份字节是什么。
 *
 * `name` 是用户给的那个名字，只用于显示与下载时的文件名：磁盘上的文件名是摘要，
 * 所以重名、改名都碰不到字节。
 */
export interface AssetRecord {
  id: string;
  sha256: string;
  mime: string;
  name: string | null;
  createdAt: number;
  /**
   * 宽高：**只给界面排版用**（图还没到的时候先按比例撑开占位框）。
   *
   * 解不出就是空 —— 只认 PNG 与 JPEG 的文件头，别的格式、字节不够都不去猜（见 `probe.ts`）。
   * 所以这两格是可选的，读的人不要按「一定在」来写。
   */
  width?: number;
  height?: number;
}
