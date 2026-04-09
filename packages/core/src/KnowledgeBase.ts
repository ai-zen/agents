import { PickRequired } from "./Common.js";
import { EmbeddingModel } from "./Models/index.js";
import { DatabaseRecord, Vector, VectorDatabase } from "./VectorDatabase.js";

export interface KnowledgeItem extends DatabaseRecord {
  title: string;
  text: string;
}

export class KnowledgeBase {
  model: EmbeddingModel;
  model_config: {};
  data: KnowledgeItem[];

  private db: VectorDatabase<KnowledgeItem>;

  constructor(options: PickRequired<KnowledgeBase, "model">) {
    if (!options.model)
      throw new Error("KnowledgeBase must have a model");
    this.model = options.model;
    this.model_config = options.model_config ?? {};
    this.data = options.data ?? [];
    this.db = new VectorDatabase(this.data);
  }

  search(targetVector: Vector, topN: number, minScore: number) {
    return this.db.search(targetVector, topN, minScore);
  }
}
