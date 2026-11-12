#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const USAGE = `
scan-secrets.mjs —— 零依赖密钥扫描（pre-commit 钩子 / 手动 / CI 通用）

用法:
  node scripts/scan-secrets.mjs              扫「暂存区」（pre-commit 默认行为）
  node scripts/scan-secrets.mjs --all        扫仓库当前跟踪的全部文件
  node scripts/scan-secrets.mjs --history    扫 git 全历史里每一行新增内容
  node scripts/scan-secrets.mjs --help

退出码: 0 = 干净, 1 = 发现疑似密钥, 2 = 配置/读取错误

误报处理: 在仓库根目录建 .secret-scan.json, 例如
  {
    "ignorePaths": ["**/*.snap", "test/fixtures/**"],
    "ignoreValuePatterns": ["^sk-test", "example[.]com"]
  }
尽量按「值」放行而非整文件放行 —— 整文件放行会把真正的泄露一起吞掉。

临时跳过（仅在明确知情时）:
  SKIP_SECRET_SCAN=1 git commit ...
  git commit --no-verify
`;

const MAX_BYTES = 2 * 1024 * 1024;

const DEFAULT_CONFIG = {
  ignorePaths: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/coverage/**",
    "**/.git/**",
    "**/*.lock",
    "**/*.map",
    "**/*.snap",
    "**/pnpm-lock.yaml",
    "**/package-lock.json",
    "**/yarn.lock",
    "**/*.min.js",
  ],
  ignoreValuePatterns: [],
};

/** 强特征：命中即报，不看熵 */
const STRONG = [
  ["OpenAI / DeepSeek 类 API key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g],
  ["GitHub 个人访问令牌", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g],
  ["GitHub 细粒度令牌", /\bgithub_pat_[A-Za-z0-9_]{20,}/g],
  ["AWS Access Key ID", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["阿里云 AccessKey ID", /\bLTAI[0-9A-Za-z]{12,}\b/g],
  ["腾讯云 SecretId", /\bAKID[0-9A-Za-z]{13,}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}/g],
  ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{10,}/g],
  ["Stripe 密钥", /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g],
  ["SSH / PEM 私钥", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g],
  ["npm authToken", /\b_?authToken\s*=\s*([^\s;#]{10,})/g],
  ["JWT 令牌", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
];

/** 弱特征：变量名像密钥 + 值看着随机（需过熵检查）才报 */
const WEAK =
  /(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer|password|passwd)\s*[:=]\s*["'`]?([A-Za-z0-9_\-./+=]{16,})["'`]?/gi;

/** 占位符 / 假数据写法，直接放过 */
const PLACEHOLDER =
  /^(?:sk-(?:test|fake|dummy|example|placeholder|xxx+|aaa+|bbb+|mock|sample|demo|new|old|inv|real|1$)|(?:x{4,}|y{4,}|0{4,})|your[-_]?|example|placeholder|changeme|<.*>|\$\{|%[A-Z_]+%)/i;

/**
 * 顺着字母表 / 数字顺序敲出来的串（abcdefghij、0123456789、…），几乎肯定是手写假数据。
 * 真密钥是随机串，不会出现长距离的升序 / 降序。
 *
 * 阈值取「最长顺序段 ≥ 整个值的 70%」，因为这个判据很危险 —— 一旦放宽就会把
 * 合法格式里的「顺序填充」当成假数据，直接变成漏报。三种情况的实测值：
 *   顺序段 26 连 / 值长 35 = 74%  → 判为假数据（放行）
 *   顺序段 10 连 / 值长 54 = 19%  → 仍按真 key 报（顺序段只是格式里的填充）
 *   顺序段 14 连 / 值长 33 = 42%  → 仍报
 * 所以必须按占比算，不能按「连续多少位」算。
 */
function looksSequential(s) {
  let maxRun = 1;
  let run = 1;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (d === 1 || d === -1) {
      run++;
      if (run > maxRun) maxRun = run;
    } else {
      run = 1;
    }
  }
  return maxRun >= 8 && maxRun / s.length >= 0.7;
}

/**
 * 判断「匹配到的值」本身是不是噪音（已打码 / 环境变量引用 / 占位符）。
 * 注意：判断必须落在「值」上，绝不能落在「行」上 ——
 * 泄露经常就藏在这种行里：expect(maskApiKey("sk-真key")).toBe("sk-5…29ce")
 * 一旦按行跳过，整行连真正的明文字面量一起被吞掉。
 */
function isNoise(value, cfg) {
  if (/…|\*{2,}/.test(value)) return true; // 已打码
  if (/^(?:process\.env|import\.meta\.env|os\.environ|env\.|getenv)/.test(value)) return true;
  if (PLACEHOLDER.test(value)) return true;
  if (looksSequential(value)) return true;
  return cfg.ignoreValuePatterns.some((r) => r.test(value));
}

const MASK = (s) => (s.length <= 10 ? "*".repeat(s.length) : `${s.slice(0, 5)}…${s.slice(-4)}`);

function entropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function loadConfig(root) {
  const p = path.join(root, ".secret-scan.json");
  if (!fs.existsSync(p)) return { ...DEFAULT_CONFIG, ignoreValuePatterns: [] };
  try {
    const user = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      ignorePaths: [...DEFAULT_CONFIG.ignorePaths, ...(user.ignorePaths ?? [])],
      ignoreValuePatterns: (user.ignoreValuePatterns ?? []).map((s) => new RegExp(s, "i")),
    };
  } catch (e) {
    console.error(`✖ .secret-scan.json 解析失败：${e.message}`);
    process.exit(2);
  }
}

/** 极简 glob：支持 ** 与 *，够用即可 */
function globToRe(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${re}$`);
}

function makeFilter(cfg, root) {
  const res = cfg.ignorePaths.map(globToRe);
  return (relPath) => {
    const p = relPath.replace(/\\/g, "/");
    if (res.some((r) => r.test(p))) return false;
    try {
      if (fs.statSync(path.join(root, p)).size > MAX_BYTES) return false;
    } catch {
      /* 暂存区里有、工作区已删的文件：继续扫 */
    }
    return true;
  };
}

function scanText(text, cfg) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const [kind, re] of STRONG) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        const value = m[1] ?? m[0];
        if (!isNoise(value, cfg)) out.push({ line: i + 1, kind, value });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }

    WEAK.lastIndex = 0;
    let w;
    while ((w = WEAK.exec(line))) {
      const value = w[1];
      const looksRandom = /[0-9]/.test(value) && /[A-Za-z]/.test(value) && entropy(value) >= 3.2;
      if (looksRandom && !isNoise(value, cfg)) {
        out.push({ line: i + 1, kind: "高熵密钥赋值", value });
      }
    }
  }
  return out;
}

function report(findings, scopeLabel, scannedCount) {
  if (findings.length === 0) {
    console.log(`✔ 密钥扫描通过（${scopeLabel}，${scannedCount} 个文件）`);
    return 0;
  }
  console.error(`\n✖ 发现 ${findings.length} 处疑似密钥泄露（${scopeLabel}）\n`);
  for (const f of findings) {
    console.error(`  ${f.where}`);
    console.error(`     类型: ${f.kind}   值: ${MASK(f.value)} (长度 ${f.value.length})`);
  }
  console.error(`
阻止提交。请按情况处理:
  1. 确实是假数据 / 测试夹具 → 换成明显的占位符（如 sk-test-0000...），
     或在 .secret-scan.json 的 ignoreValuePatterns 里按值放行;
  2. 确实是真密钥 → 立刻去服务商控制台吊销并轮换，再从代码里删掉。
     注意: 一旦进了 git 历史，删文件也还在历史里，吊销才是止损动作。
  3. 明确知情且必须提交 → SKIP_SECRET_SCAN=1 git commit ... 或 git commit --no-verify
`);
  return 1;
}

function scanHistory(cfg) {
  const diff = spawnSync(
    "git",
    ["log", "--all", "-p", "--unified=0", "--pretty=format:\u0001%h %ad", "--date=short"],
    { encoding: "utf8", maxBuffer: 1 << 30 },
  );
  if (diff.status !== 0) {
    console.error("✖ 读取 git 历史失败");
    return 2;
  }
  const findings = [];
  let commit = "";
  let file = "";
  let lineNo = 0;
  for (const line of diff.stdout.split("\n")) {
    if (line.startsWith("\u0001")) {
      commit = line.slice(1).trim();
      continue;
    }
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "");
      lineNo = 0;
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /\+(\d+)/.exec(line);
      lineNo = m ? Number(m[1]) - 1 : 0;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      lineNo++;
      if (!file || file === "/dev/null") continue;
      for (const f of scanText(line.slice(1), cfg)) {
        findings.push({ where: `${commit}  ${file}:${lineNo}`, ...f });
      }
    }
  }
  const uniq = new Map();
  for (const f of findings) {
    const k = `${f.where}|${f.value}`;
    if (!uniq.has(k)) uniq.set(k, f);
  }
  return report([...uniq.values()], "git 全历史", 0);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const mode = argv.includes("--all") ? "all" : argv.includes("--history") ? "history" : "staged";

  const rootRes = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (rootRes.status !== 0) {
    console.log("· 不在 git 仓库内，跳过密钥扫描");
    return 0;
  }
  const root = rootRes.stdout.trim();
  const cfg = loadConfig(root);
  const keep = makeFilter(cfg, root);
  process.chdir(root);

  if (mode === "history") return scanHistory(cfg);

  let files;
  if (mode === "all") {
    files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  } else {
    files = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
    if (files.length === 0) {
      console.log("✔ 密钥扫描通过（暂存区为空）");
      return 0;
    }
  }

  const findings = [];
  let scanned = 0;
  for (const rel of files) {
    if (!keep(rel)) continue;
    let text;
    try {
      text =
        mode === "all"
          ? fs.readFileSync(rel, "utf8")
          : execFileSync("git", ["show", `:${rel}`], {
              encoding: "utf8",
              maxBuffer: 32 * 1024 * 1024,
            });
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    scanned++;
    for (const f of scanText(text, cfg)) findings.push({ where: `${rel}:${f.line}`, ...f });
  }
  return report(findings, mode === "all" ? "全仓库跟踪文件" : "暂存区", scanned);
}

process.exit(main());
