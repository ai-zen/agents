import { ChatCompletionModels } from "./ChatCompletionModels/index.js";
import { EmbeddingModels } from "./EmbeddingModels/index.js";

export { ChatCompletionModels, EmbeddingModels };

export const Models = {
  ...ChatCompletionModels,
  ...EmbeddingModels,
};

export * from "./EmbeddingModel.js";
export * from "./ChatCompletionModel.js";
