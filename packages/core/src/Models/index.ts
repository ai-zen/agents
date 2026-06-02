export * from "./ChatCompletionModels/index.js";
export * from "./EmbeddingModels/index.js";
export * from "./ImageGenerationModels/index.js";

import { ChatCompletionModels } from "./ChatCompletionModels/index.js";
import { EmbeddingModels } from "./EmbeddingModels/index.js";
import { ImageGenerationModels } from "./ImageGenerationModels/index.js";

export { ChatCompletionModels, EmbeddingModels, ImageGenerationModels };

export const Models = {
  ...ChatCompletionModels,
  ...EmbeddingModels,
  ...ImageGenerationModels,
};

export * from "./EmbeddingModel.js";
export * from "./ChatCompletionModel.js";
export * from "./ImageGenerationModel.js";
