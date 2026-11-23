/**
 * 项目行：一个工作目录及它的身份。时间一律是 epoch 毫秒。
 */
export interface WorkspaceRecord {
  id: string;
  /** 一开始是创建时间那一串毫秒；人改过之后就不再自动改它 */
  name: string;
  /** 归一化后的绝对路径。没有修改入口：位置不可变，换地方就是另一个项目 */
  cwd: string;
  createdAt: number;
}
