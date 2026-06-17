import { AzureOpenAI } from "./AzureOpenAI.js";
import { CommonEndpoint } from "./CommonEndpoint.js";
import { OpenAI } from "./OpenAI.js";
import { Zhipu } from "./Zhipu.js";

export const Endpoints = {
  AzureOpenAI,
  CommonEndpoint,
  OpenAI,
  Zhipu,
};

export type EndpointKeys = keyof typeof Endpoints;

export * from "./AzureOpenAI.js";
export * from "./CommonEndpoint.js";
export * from "./OpenAI.js";
export * from "./Zhipu.js";
