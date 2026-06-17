import { AgentNS } from "./AgentNS";

export abstract class Rag {
  abstract rewrite(
    questionMessage: AgentNS.Message,
    messages?: AgentNS.Message[]
  ): Promise<void>;
}
