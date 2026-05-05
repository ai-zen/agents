import { Endpoint } from "./types.js";
import { readConfig, saveConfig } from "./config.js";

// ==================== 端点管理 ====================

export function getEndpoint(endpointId: string): Endpoint | undefined {
  const config = readConfig();
  return config.endpoints.find((e) => e.id === endpointId);
}

export function getEndpoints(): Endpoint[] {
  const config = readConfig();
  return config.endpoints;
}

export function upsertEndpoint(endpoint: Endpoint): void {
  const config = readConfig();
  const index = config.endpoints.findIndex((e) => e.id === endpoint.id);
  if (index >= 0) {
    config.endpoints[index] = endpoint;
  } else {
    config.endpoints.push(endpoint);
  }
  saveConfig(config);
}

export function deleteEndpoint(endpointId: string): void {
  const config = readConfig();
  config.endpoints = config.endpoints.filter((e) => e.id !== endpointId);
  saveConfig(config);
}
