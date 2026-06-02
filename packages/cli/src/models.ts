import { Model, ModelParams, ImageModel } from "./types.js";
import { readConfig, saveConfig } from "./config.js";

// ==================== 对话模型管理 ====================

export function getModel(modelId: string): Model | undefined {
  const config = readConfig();
  return config.models.find((m) => m.id === modelId);
}

export function getModels(): Model[] {
  const config = readConfig();
  return config.models;
}

export function getDefaultModel(): Model | undefined {
  const config = readConfig();
  if (config.defaultModel) {
    return getModel(config.defaultModel);
  }
  return config.models.length > 0 ? config.models[0] : undefined;
}

export function setDefaultModel(modelId: string): void {
  const config = readConfig();
  if (!config.models.find((m) => m.id === modelId)) {
    throw new Error(`模型 ${modelId} 不存在`);
  }
  config.defaultModel = modelId;
  saveConfig(config);
}

export function upsertModel(model: Model): void {
  const config = readConfig();
  const index = config.models.findIndex((m) => m.id === model.id);
  if (index >= 0) {
    config.models[index] = model;
  } else {
    config.models.push(model);
  }
  saveConfig(config);
}

export function deleteModel(modelId: string): void {
  const config = readConfig();
  config.models = config.models.filter((m) => m.id !== modelId);
  saveConfig(config);
}

export function getModelsByEndpoint(endpointId: string): Model[] {
  const config = readConfig();
  return config.models.filter((m) => m.endpointId === endpointId);
}

export function mergeParams(
  defaultParams?: ModelParams,
  overrideParams?: ModelParams,
): ModelParams {
  return { ...defaultParams, ...overrideParams };
}

// ==================== 图片生成模型管理 ====================

export function getImageModel(imageModelId: string): ImageModel | undefined {
  const config = readConfig();
  return config.imageModels?.find((m) => m.id === imageModelId);
}

export function getImageModels(): ImageModel[] {
  const config = readConfig();
  return config.imageModels || [];
}

export function getDefaultImageModel(): ImageModel | undefined {
  const config = readConfig();
  if (config.defaultImageModel) {
    return getImageModel(config.defaultImageModel);
  }
  return config.imageModels?.[0];
}

export function setDefaultImageModel(imageModelId: string): void {
  const config = readConfig();
  if (!config.imageModels?.find((m) => m.id === imageModelId)) {
    throw new Error(`图片模型 ${imageModelId} 不存在`);
  }
  config.defaultImageModel = imageModelId;
  saveConfig(config);
}

export function upsertImageModel(model: ImageModel): void {
  const config = readConfig();
  if (!config.imageModels) config.imageModels = [];
  const index = config.imageModels.findIndex((m) => m.id === model.id);
  if (index >= 0) {
    config.imageModels[index] = model;
  } else {
    config.imageModels.push(model);
  }
  saveConfig(config);
}

export function deleteImageModel(imageModelId: string): void {
  const config = readConfig();
  if (config.imageModels) {
    config.imageModels = config.imageModels.filter((m) => m.id !== imageModelId);
  }
  saveConfig(config);
}
