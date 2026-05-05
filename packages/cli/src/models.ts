import { Model, ModelParams } from "./types.js";
import { readConfig, saveConfig } from "./config.js";

// ==================== 模型管理 ====================

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
