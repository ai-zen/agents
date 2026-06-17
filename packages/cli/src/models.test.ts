import { describe, it, expect, vi } from "vitest";
import {
  getModel,
  getModels,
  getDefaultModel,
  setDefaultModel,
  upsertModel,
  deleteModel,
  getModelsByEndpoint,
  getImageModel,
  getImageModels,
  getDefaultImageModel,
  setDefaultImageModel,
  upsertImageModel,
  deleteImageModel,
} from "./models.js";
import { defaultConfig } from "./config.js";
import { Model, ImageModel } from "./types.js";

// ==================== Mock 配置 ====================

const mockConfig = { ...defaultConfig };

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    readConfig: vi.fn(() => mockConfig),
    saveConfig: vi.fn(),
  };
});

// ==================== 测试数据 ====================

const newModel: Model = {
  id: "test-model",
  name: "测试模型",
  endpointId: "openai",
  modelName: "gpt-test",
  description: "用于测试的模型",
  defaultParams: { temperature: 0.5 },
};

const newImageModel: ImageModel = {
  id: "test-image-model",
  name: "测试图片模型",
  endpointId: "bigmodelcn",
  modelName: "cogview-test",
  description: "用于测试的图片模型",
  defaultSize: "1024x1024",
};

// ==================== 对话模型 ====================

describe("getModels", () => {
  it("返回所有对话模型", () => {
    const models = getModels();
    expect(models.length).toBeGreaterThan(0);
  });
});

describe("getModel", () => {
  it("按 ID 查找模型", () => {
    const model = getModel("deepseek-v4-flash");
    expect(model).toBeDefined();
    expect(model!.id).toBe("deepseek-v4-flash");
  });

  it("不存在的 ID 返回 undefined", () => {
    const model = getModel("non-existent");
    expect(model).toBeUndefined();
  });
});

describe("getDefaultModel", () => {
  it("返回默认模型", () => {
    const model = getDefaultModel();
    expect(model).toBeDefined();
    expect(model!.id).toBe(mockConfig.defaultModel);
  });

  it("未设置 defaultModel 时返回第一个", () => {
    const originalDefault = mockConfig.defaultModel;
    mockConfig.defaultModel = "";
    const model = getDefaultModel();
    expect(model).toBeDefined();
    expect(model!.id).toBe(mockConfig.models[0]?.id);
    mockConfig.defaultModel = originalDefault;
  });
});

describe("setDefaultModel", () => {
  it("设置默认模型", () => {
    setDefaultModel("deepseek-v4-flash");
    expect(mockConfig.defaultModel).toBe("deepseek-v4-flash");
  });

  it("设置不存在的模型时报错", () => {
    expect(() => setDefaultModel("non-existent")).toThrow("不存在");
  });
});

describe("upsertModel", () => {
  it("新增模型", () => {
    const count = mockConfig.models.length;
    upsertModel(newModel);
    expect(mockConfig.models.length).toBe(count + 1);
    expect(mockConfig.models.find((m) => m.id === "test-model")).toEqual(newModel);
  });

  it("更新已有模型", () => {
    const updated = { ...newModel, name: "更新后的模型" };
    upsertModel(updated);
    const m = mockConfig.models.find((m) => m.id === "test-model");
    expect(m).toBeDefined();
    expect(m!.name).toBe("更新后的模型");
  });
});

describe("deleteModel", () => {
  it("删除模型", () => {
    upsertModel(newModel);
    expect(mockConfig.models.find((m) => m.id === "test-model")).toBeDefined();
    deleteModel("test-model");
    expect(mockConfig.models.find((m) => m.id === "test-model")).toBeUndefined();
  });

  it("删除不存在的模型不报错", () => {
    expect(() => deleteModel("non-existent")).not.toThrow();
  });
});

describe("getModelsByEndpoint", () => {
  it("按端点 ID 筛选模型", () => {
    const models = getModelsByEndpoint("openai");
    expect(models.every((m) => m.endpointId === "openai")).toBe(true);
  });

  it("没有匹配时返回空数组", () => {
    const models = getModelsByEndpoint("non-existent");
    expect(models).toEqual([]);
  });
});

// ==================== 图片生成模型 ====================

describe("getImageModels", () => {
  it("返回所有图片生成模型", () => {
    const models = getImageModels();
    expect(models.length).toBeGreaterThan(0);
  });
});

describe("getImageModel", () => {
  it("按 ID 查找图片模型", () => {
    const model = getImageModel("cogview-4");
    expect(model).toBeDefined();
    expect(model!.id).toBe("cogview-4");
  });

  it("不存在的 ID 返回 undefined", () => {
    const model = getImageModel("non-existent");
    expect(model).toBeUndefined();
  });
});

describe("getDefaultImageModel", () => {
  it("返回默认图片生成模型", () => {
    const model = getDefaultImageModel();
    expect(model).toBeDefined();
    expect(model!.id).toBe(mockConfig.defaultImageModel);
  });
});

describe("setDefaultImageModel", () => {
  it("设置默认图片生成模型", () => {
    setDefaultImageModel("cogview-4");
    expect(mockConfig.defaultImageModel).toBe("cogview-4");
  });

  it("设置不存在的图片模型时报错", () => {
    expect(() => setDefaultImageModel("non-existent")).toThrow("不存在");
  });
});

describe("upsertImageModel", () => {
  it("新增图片模型", () => {
    const count = mockConfig.imageModels!.length;
    upsertImageModel(newImageModel);
    expect(mockConfig.imageModels!.length).toBe(count + 1);
    const m = mockConfig.imageModels!.find((m) => m.id === "test-image-model");
    expect(m).toEqual(newImageModel);
  });

  it("更新已有图片模型", () => {
    const updated = { ...newImageModel, defaultSize: "768x1344" };
    upsertImageModel(updated);
    const m = mockConfig.imageModels!.find((m) => m.id === "test-image-model");
    expect(m).toBeDefined();
    expect(m!.defaultSize).toBe("768x1344");
  });
});

describe("deleteImageModel", () => {
  it("删除图片模型", () => {
    upsertImageModel(newImageModel);
    expect(mockConfig.imageModels!.find((m) => m.id === "test-image-model")).toBeDefined();
    deleteImageModel("test-image-model");
    expect(mockConfig.imageModels!.find((m) => m.id === "test-image-model")).toBeUndefined();
  });

  it("删除不存在的图片模型不报错", () => {
    expect(() => deleteImageModel("non-existent")).not.toThrow();
  });
});
