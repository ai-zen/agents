---
name: git-helper
description: Git 操作指南和最佳实践
license: MIT
---

# Git 助手 Skill

## 常用命令

### 提交相关
- `git commit -m "message"` — 普通提交
- `git commit --amend` — 修改上次提交

### 分支管理
- `git branch -d <name>` — 删除已合并分支
- `git checkout -b <name>` — 创建并切换分支

### 撤销操作
- `git reset --soft HEAD~1` — 撤销上次提交但保留改动
- `git checkout -- <file>` — 丢弃工作区改动

## 最佳实践

1. 提交信息使用英文，前缀标明类型（feat/fix/chore/docs）
2. 每个提交只做一件事
3. 推送前先 rebase 到目标分支
