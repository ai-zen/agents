/**
 * 素材行：一份上传的文件。字节在 `<数据根>/assets/<sha256>`，行里只记这份字节是什么。
 *
 * `name` 是用户给的那个名字，只用于显示与下载时的文件名：磁盘上的文件名是摘要，
 * 所以重名、改名都碰不到字节。
 */
export interface Asset {
  id: string;
  sha256: string;
  mime: string;
  name: string | null;
  createdAt: number;
}
