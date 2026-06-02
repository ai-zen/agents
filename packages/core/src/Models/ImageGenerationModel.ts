import { Model, ModelType } from "../Model.js";

export interface ImageGenerationOptions {
  signal?: AbortSignal;
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  n?: number;
}

export interface ImageResult {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export interface ImageGenerationResponse {
  created?: number;
  data: ImageResult[];
  content_filter?: any[];
}

export abstract class ImageGenerationModel<C = {}> extends Model<C> {
  static type = ModelType.ImageGeneration;

  abstract generate(
    options: ImageGenerationOptions,
  ): Promise<ImageGenerationResponse>;
}
