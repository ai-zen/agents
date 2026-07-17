---
name: project-guide
description: 项目开发规范和指南
license: MIT
sub-agent: true
---

# 项目开发指南

## 编码规范

- 使用 TypeScript 严格模式
- 使用 pnpm 管理依赖
- 所有代码必须经过测试

## 目录结构

```
src/
  types/      ← 类型定义
  config/     ← 配置读写
  crud/       ← 实体 CRUD
  runtime/    ← 运行时
  plugin/     ← 插件
  shared/     ← 共享
```

## 提交规范

使用 conventional commits 格式：
- feat: 新功能
- fix: 修复
- chore: 杂项
- docs: 文档
- test: 测试
