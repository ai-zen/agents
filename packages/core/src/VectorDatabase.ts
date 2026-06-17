export type Vector = number[];

export interface DatabaseRecord {
  vector: Vector;
}

export class VectorDatabase<T extends DatabaseRecord> {
  private database: T[];

  constructor(database?: T[]) {
    this.database = database ?? [];
  }

  input(data: T[]): void {
    this.database.push(...data);
  }

  output(): T[] {
    return this.database;
  }

  cosineSimilarity(vec1: Vector, vec2: Vector): number {
    const dotProduct = vec1.reduce((acc, val, i) => acc + val * vec2[i], 0);
    const magnitude1 = Math.sqrt(vec1.reduce((acc, val) => acc + val * val, 0));
    const magnitude2 = Math.sqrt(vec2.reduce((acc, val) => acc + val * val, 0));
    if (magnitude1 === 0 || magnitude2 === 0) return 0;
    return dotProduct / (magnitude1 * magnitude2);
  }

  search(targetVector: Vector, topN: number, minScore: number): T[] {
    return this.database
      .map((record) => ({
        record,
        score: this.cosineSimilarity(targetVector, record.vector),
      }))
      .filter((x) => x.score > minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map((x) => x.record);
  }

  insert(record: T): void {
    this.database.push(record);
  }
}
