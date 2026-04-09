import {
  Agent,
  AgentContext,
  AgentTool,
  CallbackTool,
  ChatCompletionModels,
  CodeTool,
  EmbeddingModels,
  EmbeddingSearch,
  Endpoints,
  IndexedSearchTool,
  KnowledgeBase,
  Message,
  Tool,
} from "@ai-zen/agents-core";
import { Rag } from "@ai-zen/agents-core/dist/Rag";
import { ChatPL } from "../types/ChatPL";

export function useDeserialize(options: {
  getEndpoint?(id: string): ChatPL.EndpointPO | undefined;
  getModel?(id: string): ChatPL.ModelPO | undefined;
  getTools?(ids: string[]): ChatPL.ToolPO[];
  getAgentTools?(ids: string[]): ChatPL.AgentToolPO[];
  getAgents?(ids: string[]): ChatPL.AgentPO[];
  getKnowledgeBases?(ids: string[]): ChatPL.KnowledgeBasePO[];
}) {
  async function formatEndpoint(endpointPO: ChatPL.EndpointPO) {
    return new Endpoints[endpointPO.endpoint_key]({
      ...endpointPO.endpoint_config,
    });
  }

  async function formatEmbeddingModel(
    modelPO: ChatPL.ModelPO,
    model_config: any,
  ) {
    const endpointPo = options.getEndpoint?.(modelPO.endpoint_id);
    if (!endpointPo) {
      throw new Error("Endpoint not found");
    }
    const endpoint = await formatEndpoint(endpointPo);
    return new EmbeddingModels[modelPO.base as keyof typeof EmbeddingModels]({
      model_config: model_config,
      request_config: await endpoint.embedding(modelPO.name),
    });
  }

  async function formatChatCompletionModel(
    modelPO: ChatPL.ModelPO,
    model_config: any,
  ) {
    const endpointPo = options.getEndpoint?.(modelPO.endpoint_id);
    if (!endpointPo) {
      throw new Error("Endpoint not found");
    }
    const endpoint = await formatEndpoint(endpointPo);
    return new ChatCompletionModels[
      modelPO.base as keyof typeof ChatCompletionModels
    ]({
      model_config: model_config,
      request_config: await endpoint.chatCompletion(modelPO.name),
    });
  }

  async function formatTool(toolPO: ChatPL.ToolPO): Promise<Tool> {
    if (toolPO.code) {
      return new CodeTool(toolPO as Required<ChatPL.ToolPO>);
    } else if (toolPO.callback) {
      return new CallbackTool(toolPO as Required<ChatPL.ToolPO>);
    }
    throw new Error("Unknown tool type");
  }

  async function formatKnowledgeBase(
    knowledgeBasePO: ChatPL.KnowledgeBasePO,
  ): Promise<KnowledgeBase> {
    const modelPo = options.getModel?.(knowledgeBasePO.model_id);
    if (!modelPo) {
      throw new Error("Model not found");
    }
    const model = await formatEmbeddingModel(
      modelPo,
      knowledgeBasePO.model_config,
    );
    return new KnowledgeBase({
      ...knowledgeBasePO,
      model,
    });
  }

  async function formatChatContext(
    chatContextPO: ChatPL.ChatContextPO,
  ): Promise<AgentContext> {
    const messages = chatContextPO.messages.map((x) => new Message(x));

    const tools: Tool[] = await Promise.all([
      ...(options.getTools?.(chatContextPO.tools_ids)?.map(formatTool) ?? []),
      ...(options
        .getAgentTools?.(chatContextPO.agent_tools_ids)
        ?.map(formatAgentTool) ?? []),
    ]);

    let rag: Rag | undefined = undefined;
    if (
      chatContextPO.retrieval_type == ChatPL.RetrievalType.RAG_EMBEDDING_SEARCH
    ) {
      const knowledge_bases = await Promise.all(
        options
          .getKnowledgeBases?.(chatContextPO.knowledge_bases_ids)
          ?.map(formatKnowledgeBase) ?? [],
      );
      rag = new EmbeddingSearch({
        knowledge_bases: knowledge_bases,
      });
    } else if (
      chatContextPO.retrieval_type == ChatPL.RetrievalType.TOOL_INDEXED_SEARCH
    ) {
      const entries =
        options
          .getKnowledgeBases?.(chatContextPO.knowledge_bases_ids)
          ?.map((x) => x.data)
          .flat() ?? [];
      tools.push(new IndexedSearchTool({ entries }));
    }

    const modelPo = options.getModel?.(chatContextPO.model_id);
    if (!modelPo) {
      throw new Error("Model not found");
    }
    const model = await formatChatCompletionModel(
      modelPo,
      chatContextPO.model_config,
    );

    return new AgentContext({
      ...chatContextPO,
      model: model,
      messages,
      tools,
      rag,
    });
  }

  async function formatAgent(agentPO: ChatPL.AgentPO): Promise<Agent> {
    return new Agent({
      ...agentPO,
      ...(await formatChatContext(agentPO)),
    });
  }

  async function formatAgentTool(
    agentToolPO: ChatPL.AgentToolPO,
  ): Promise<AgentTool> {
    return new AgentTool({
      ...agentToolPO,
      ...(await formatChatContext(agentToolPO)),
    });
  }

  return {
    formatEndpoint,
    formatEmbeddingModel,
    formatChatCompletionModel,
    formatTool,
    formatKnowledgeBase,
    formatChatContext,
    formatAgent,
    formatAgentTool,
  };
}
