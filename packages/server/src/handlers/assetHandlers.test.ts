/**
 * `asset.*` 的验收。
 *
 * 两个方法（`asset.begin` / `asset.end`）由接线层接管，所以这一域的表是空的 —— 用例把
 * 「为什么空」钉成事实：这两个方法名在契约里、但不在 handler 表里，而上传链路（含素材落定）
 * 由 `WsHub` + `UploadReceiver` 走通。剩下的是附件结局的按语言重渲染（那一域的翻译工作）。
 */

import { describe, expect, it } from "vitest";

import { render } from "../i18n/index.js";
import { METHOD_NAMES } from "../wire/index.js";
import type { AttachmentOutcome, ProblemFact } from "../wire/index.js";
import { createAssetHandlers, localizeOutcome } from "./assetHandlers.js";

/** 一条退化成文字的附件结局（素材层按默认语言渲染出来的样子） */
function fallbackOutcome(): AttachmentOutcome {
  const problem: ProblemFact = {
    code: "message.imageAsText",
    messageKey: "message.imageAsText",
    params: { model: "Test Model", name: "a.png" },
    message: render("en", "message.imageAsText", { model: "Test Model", name: "a.png" }),
    detail: { assetId: "asset-1", reason: "model_without_vision" },
  };
  return { assetId: "asset-1", deliveredAs: "text_fallback", section: null, problem };
}

describe("createAssetHandlers", () => {
  it("上传的两个方法由接线层接管，表里不重复注册", () => {
    const table = createAssetHandlers();
    expect(Object.keys(table)).toEqual([]);
    // 方法名本身在契约里（客户端能查、帮助页能列），只是实现不在这张表里
    expect(METHOD_NAMES).toContain("asset.begin");
    expect(METHOD_NAMES).toContain("asset.end");
    expect(table["asset.begin"]).toBeUndefined();
    expect(table["asset.end"]).toBeUndefined();
  });
});

describe("localizeOutcome", () => {
  it("没有失败原因时原样返回（同一个对象，不白造一份）", () => {
    const clean: AttachmentOutcome = {
      assetId: "asset-2",
      deliveredAs: "inline",
      section: { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
      problem: null,
    };
    expect(localizeOutcome(clean, "zh")).toBe(clean);
  });

  it("按连接语言重渲染句子，码与参数不动（D8）", () => {
    const outcome = fallbackOutcome();
    const chinese = localizeOutcome(outcome, "zh");

    expect(chinese.problem?.messageKey).toBe(outcome.problem?.messageKey);
    expect(chinese.problem?.params).toEqual(outcome.problem?.params);
    expect(chinese.problem?.detail).toEqual(outcome.problem?.detail);
    expect(chinese.problem?.message).toBe(
      render("zh", "message.imageAsText", outcome.problem?.params ?? {}),
    );
    expect(chinese.problem?.message).not.toBe(outcome.problem?.message);
    // 其余字段原样搬运
    expect(chinese.deliveredAs).toBe(outcome.deliveredAs);
    expect(chinese.assetId).toBe(outcome.assetId);
    expect(outcome.problem?.message).toBe(
      render("en", "message.imageAsText", outcome.problem?.params ?? {}),
    );
  });
});
