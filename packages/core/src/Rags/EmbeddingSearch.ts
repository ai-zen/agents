import { AgentNS } from "../AgentNS.js";
import { PickRequired } from "../Common.js";
import { Endpoint } from "../Endpoint.js";
import { KnowledgeBase } from "../KnowledgeBase.js";
import { Message } from "../Message.js";
import { Rag } from "../Rag.js";

export class EmbeddingSearch extends Rag {
  knowledge_bases: KnowledgeBase[];
  template: (
    question: AgentNS.MessageContent,
    references: string[],
  ) => AgentNS.MessageContent;
  endpoints: Endpoint[];

  constructor(options: PickRequired<EmbeddingSearch, "knowledge_bases">) {
    super();
    this.knowledge_bases = options.knowledge_bases ?? [];
    this.template = options.template ?? this.defaultTemplate;
    this.endpoints = options.endpoints ?? [];
  }

  private defaultTemplate(
    question: AgentNS.MessageContent,
    references: string[],
  ): AgentNS.MessageContent {
    const formattedReference = references.map((ref) => `<${ref}>`).join(", ");
    const partA = `My question is: \n\n`;
    const partB = `\n\nAnswer my question based on the following information: \n\n${formattedReference}`;
    if (question instanceof Array) {
      return [
        { type: "text", text: partA },
        ...question,
        { type: "text", text: partB },
      ];
    } else {
      return `${partA}${question}${partB}`;
    }
  }

  async rewrite(questionMessage: AgentNS.Message) {
    const references = await this.query(questionMessage.content!.toString());
    if (references?.length) {
      Message.rewrite(
        questionMessage,
        this.template(questionMessage.content!, references),
      );
    }
  }

  /**
   * Query the knowledge base for related information.
   */
  async query(question: string) {
    const results = await Promise.all(
      this.knowledge_bases.map(async (kb) => {
        const vector = await kb.model.createEmbedding(question as string);
        const records = kb.search(vector, 5, 0.8);
        const texts = records.map((x) => x.text);

        return texts;
      }),
    );

    return results.flat().filter((x) => x) as string[];
  }
}
