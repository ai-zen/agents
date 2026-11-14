import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { en } from "./en.js";
import { zh } from "./zh.js";
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  hasMessage,
  normalizeLanguage,
  render,
  template,
  type MessageKey,
} from "./index.js";
import { BIZ_CODES, defaultMessageKey } from "../wire/errors.js";

describe("文案表", () => {
  it("en 与 zh 的键完全一致（类型层面）", () => {
    // 少一个键或多一个键都会在这里编译失败：satisfies 把键集合钉在 en 上
    const parity: Record<keyof typeof en, string> = zh;
    expect(Object.keys(parity).length).toBe(Object.keys(en).length);
  });

  it("en 与 zh 的键完全一致（运行时）", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it("每条文案都不为空、不含 undefined 这类拼接事故", () => {
    for (const dict of [en, zh]) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), key).not.toBe("");
        expect(value, key).not.toContain("undefined");
        expect(value, key).not.toContain("Error:");
      }
    }
  });

  /**
   * 每个词条都真的有人取。
   *
   * 宿主的词典是**闭集**（`MessageKey = keyof typeof en`），类型能保证「写下的键一定存在」，
   * 但保证不了反方向：功能搬走 / 屏改版 / 规则归客户端之后，句子留在词典里没人读。
   * 它们不会报错，只会让读词典的人以为那些行为还在（`status.*` 六态、`usage.*`、
   * `notice.workspaceDeleted` 这批就是这么活了很久，其中还在说「Project」）。
   *
   * 判据是「在生产码里出现过这个名字」：键都是字面量（动态取文案只有 `notice.*` 一条路，
   * 而那条路的码也是别处的字面量），所以出现即代表有人取。用例与词典自身不算。
   */
  it("每个词条在生产码里都有人取（不留没人读的句子）", async () => {
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "i18n") await walk(path);
          continue;
        }
        if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
      }
    };
    await walk(fileURLToPath(new URL("../", import.meta.url)));
    const production = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");

    // 按**带引号的整串**匹配：`includes("notice.logWarning")` 会把 `notice.logWarningX`
    // 也算命中，那样守卫是假的（实测过）
    const orphans = Object.keys(en).filter(
      (key) => !production.includes(`"${key}"`) && !production.includes(`'${key}'`),
    );
    expect(orphans).toEqual([]);
  });

  it("每个业务码都有非空的兜底文案", () => {
    for (const code of BIZ_CODES) {
      const key = defaultMessageKey(code);
      expect(hasMessage(key), code).toBe(true);
      expect(en[key].trim()).not.toBe("");
      expect(zh[key].trim()).not.toBe("");
    }
  });
});

describe("normalizeLanguage", () => {
  it("认得受支持的语言原样", () => {
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("zh")).toBe("zh");
  });

  it("认得大小写与带地区的写法", () => {
    expect(normalizeLanguage("ZH")).toBe("zh");
    expect(normalizeLanguage("zh-CN")).toBe("zh");
    expect(normalizeLanguage("en_US")).toBe("en");
    expect(normalizeLanguage(" pt-BR ")).toBe(DEFAULT_LANGUAGE);
  });

  it("认不出来就回落默认语言", () => {
    expect(normalizeLanguage(undefined)).toBe(DEFAULT_LANGUAGE);
    expect(normalizeLanguage(null)).toBe(DEFAULT_LANGUAGE);
    expect(normalizeLanguage(42)).toBe(DEFAULT_LANGUAGE);
    expect(normalizeLanguage({ language: "zh" })).toBe(DEFAULT_LANGUAGE);
    expect(normalizeLanguage("")).toBe(DEFAULT_LANGUAGE);
    expect(normalizeLanguage("klingon")).toBe(DEFAULT_LANGUAGE);
  });

  it("默认语言是英文（PRD D8）", () => {
    expect(DEFAULT_LANGUAGE).toBe("en");
    expect(LANGUAGES).toContain("en");
    expect(LANGUAGES).toContain("zh");
  });
});

describe("render", () => {
  it("按语言取对应的那一句", () => {
    expect(render("en", "error.busy")).toBe(en["error.busy"]);
    expect(render("zh", "error.busy")).toBe(zh["error.busy"]);
  });

  it("替换 {name} 形式的占位符", () => {
    expect(render("en", "error.notFound", { entity: "conversation" })).toContain("conversation");
    expect(render("zh", "error.notFound", { entity: "对话" })).toContain("对话");
    expect(render("zh", "error.notFound", { entity: "对话" })).not.toContain("{entity}");
  });

  it("多个占位符各自替换", () => {
    const text = render("en", "error.contextGuard", { limit: 1000, used: 1200 });
    expect(text).toContain("1000");
    expect(text).toContain("1200");
    expect(text).not.toContain("{limit}");
    expect(text).not.toContain("{used}");
  });

  it("数字与布尔按可读形式拼接，对象 JSON 化", () => {
    expect(render("en", "error.payloadTooLarge", { size: 21, limit: "20MB" })).toContain("21");
    expect(render("en", "question.handoff.prompt", { flag: true })).toBe(
      en["question.handoff.prompt"],
    );
    expect(render("zh", "question.handoff.prompt", { percent: 80 })).toContain("80");
  });

  it("缺参数时保留占位符，不把 undefined 拼进句子", () => {
    const text = render("en", "error.notFound", {});
    expect(text).toContain("{entity}");
    expect(text).not.toContain("undefined");
    expect(render("en", "error.notFound")).toBe(en["error.notFound"]);
  });

  it("参数值为 null 时同样保留占位符", () => {
    expect(render("en", "error.notFound", { entity: null })).toContain("{entity}");
  });

  it("取不到模板时返回 undefined，由调用方决定说什么", () => {
    expect(template("zh", "error.busy")).toBe(zh["error.busy"]);
    expect(template("zh", "no.such.key" as MessageKey)).toBeUndefined();
  });

  it("hasMessage 只认已知键", () => {
    expect(hasMessage("error.busy")).toBe(true);
    expect(hasMessage("error.nope")).toBe(false);
    expect(hasMessage("toString")).toBe(false);
  });
});
