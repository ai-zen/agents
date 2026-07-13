# Skills 规范合规方案

> 补充 `sdk-design.md` §8，对齐 [Agent Skills 规范](https://agentskills.io/specification.md)。

---

## 1. 现状与差距

### 1.1 当前 `Frontmatter` 类型

```typescript
// src/capabilities/discovery/skills.ts (现状)
export interface Frontmatter {
  name?: string;
  description?: string;
  subAgent?: boolean;  // ← 非标准，Claude Code 启发
}
```

### 1.2 规范要求的字段

| 字段 | 必须 | 约束 | 当前 |
|------|:--:|------|:--:|
| `name` | ✅ | 1-64 字符，仅 `[a-z0-9-]`，不首尾连字符，不连续连字符，匹配目录名 | 解析但不校验 |
| `description` | ✅ | 1-1024 字符 | 解析但不校验 |
| `license` | 否 | 许可名或指向 LICENSE 文件 | ❌ 缺失 |
| `compatibility` | 否 | 最长 500 字符 | ❌ 缺失 |
| `metadata` | 否 | 任意 `Record<string,string>` 键值对 | ❌ 缺失 |
| `allowed-tools` | 否 | 空格分隔的工具名（实验性） | ❌ 缺失 |
| — | — | — | — |
| `sub-agent` | — | **扩展字段**，Claude Code 风格 | ✅ 已支持 |

---

## 2. 实现方案

### 2.1 扩展 `Frontmatter`

```typescript
export interface Frontmatter {
  // ---- 规范字段 ----
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];    // 空格分隔 → 解析为数组

  // ---- 扩展字段（非规范）----
  subAgent?: boolean;          // Claude Code 启发：声明可子 Agent 运行
}
```

### 2.2 新增 `SkillValidationError`

```typescript
export interface SkillValidationError {
  skillId: string;
  field: string;
  message: string;
}
```

### 2.3 新增校验函数

```typescript
/**
 * 校验单个 Skill 的 frontmatter 合规性。
 * name/description 的规则来自 agentskills.io 规范。
 * 返回警告列表（不阻塞加载，只做提示）。
 */
export function validateSkill(skillId: string, fm: Frontmatter): SkillValidationError[];
```

**`name` 校验规则：**

1. 必须存在且非空
2. 1-64 字符
3. 仅允许：小写字母 `[a-z]`、数字 `[0-9]`、连字符 `[-]`
4. 不能以 `-` 开头或结尾
5. 不能包含连续 `--`
6. 必须与父目录名匹配（由调用方传入 `dirName`）

**`description` 校验规则：**

1. 必须存在且非空
2. 1-1024 字符

### 2.4 更新 `parseFrontmatter`

当前逐行正则匹配只支持单值字段。metadata 是嵌套结构，allowed-tools 是空格分隔列表，需要更强解析。改用 **按行状态机 + key-value 提取**：

```
逐行读取 frontmatter 内容：
  - 遇到 "key: value" → 存入对应字段
  - 遇到 "key:" 且下一行缩进 → 进入嵌套模式（metadata）
  - allowed-tools 的值按空格 split 为数组
  - sub-agent 继续原样解析
```

### 2.5 更新 `discoverSkills` 和 `readSkill`

- `discoverSkills`：解析后调 `validateSkill`，将警告通过 logger 输出（不中断发现）
- `readSkill`：同样校验，同时 `Frontmatter` 包含完整规范字段
- `SkillInfo` 继承 `Frontmatter` 的 `metadata`、`license` 等字段，供上层使用

### 2.6 关于 `sub-agent` 扩展

- 保留在 `Frontmatter` 顶层（不放进 `metadata`）
- 在 `parseFrontmatter` 的 JSDoc 中标注 `@extension Claude Code inspired`
- `metadata` 作为规范标准字段同时支持，用户可选在 `metadata.sub-agent` 中冗余声明

---

## 3. 改动清单

| 文件 | 变更 |
|------|------|
| `src/capabilities/discovery/skills.ts` | ① 扩展 `Frontmatter` 类型（+4 字段）② 新增 `SkillValidationError` 类型 ③ 新增 `validateSkill()` ④ 重写 `parseFrontmatter()` 支持嵌套 metadata 和数组 allowedTools ⑤ `discoverSkills` / `readSkill` 集成校验 |
| `src/capabilities/discovery/skills.test.ts` | ① `parseFrontmatter` 测试：metadata 解析、allowed-tools 数组化、license/compatibility 提取 ② `validateSkill` 测试：合法/非法 name、合法/非法 description ③ `sub-agent` 扩展字段保持向后兼容 |

---

## 4. 不变的部分

- `SkillInfo` 接口基本不变，增加可选 `metadata`/`license`/`compatibility`/`allowedTools`
- `createSkillSubAgent` 不受影响（仅读 `subAgent` 和 `content`）
- `discoverSkills` 返回 `DisclosureItem[]` 签名不变
- `disclosure.ts` / `pipeline.ts` 不感知 frontmatter 细节

---

## 5. 测试用例（设计先行）

### `parseFrontmatter`

```
输入:
  ---
  name: my-skill
  description: Does something useful.
  license: MIT
  compatibility: requires git
  metadata:
    author: example-org
    version: "1.0"
  allowed-tools: Bash(git:*) Read
  sub-agent: true
  ---

期望:
  {
    name: "my-skill",
    description: "Does something useful.",
    license: "MIT",
    compatibility: "requires git",
    metadata: { author: "example-org", version: "1.0" },
    allowedTools: ["Bash(git:*)", "Read"],
    subAgent: true,
  }
```

### `validateSkill`

```
合法 name: "pdf-processing", "code-review", "data-analyzer"
非法 name: "PDF-Processing"(大写), "-leading"(首连字符), "trailing-"(尾连字符),
          "double--dash"(连续连字符), ""(空), "工具"(非 ASCII)

合法 description: "..."（1-1024 字符）
非法 description: ""（空），超过 1024 字符
```
