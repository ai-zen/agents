import { AgentNS, EndpointKeys, Models } from "@ai-zen/agents-core";
import { ModelType } from "@ai-zen/agents-core/dist/Model";

/**
 * Chat Persistence Layer
 */
export namespace ChatPL {
  export interface ModelPO {
    id: string;
    /** 模型标题 */
    title: string;
    /** 模型图标 */
    icon: string;
    /** 模型标识，用于服务端调用的唯一标识 */
    name: string;
    /** 模型类型 */
    type: ModelType;
    /** 模型基类 */
    base: keyof typeof Models;
    /** 服务端 */
    endpoint_id: string;
    INPUT_MAX_TOKENS?: number;
    OUTPUT_MAX_TOKENS_LOWER_LIMIT?: number;
    OUTPUT_MAX_TOKENS?: number;
    IS_SUPPORT_FUNCTION_CALL?: boolean;
    IS_SUPPORT_TOOLS_CALL?: boolean;
    IS_SUPPORT_IMAGE_CONTENT?: boolean;
  }

  export interface ToolPO extends AgentNS.ToolDefine {
    id: string;
    title: string;
    icon: string;
    code?: string;
    callback?: (...args: any[]) => any;
  }

  export enum RetrievalType {
    RAG_EMBEDDING_SEARCH = "embedding_search",
    TOOL_INDEXED_SEARCH = "tool_indexed_search",
  }

  export interface ChatContextPO {
    model_id: string;
    model_config: any;
    messages: AgentNS.Message[];
    knowledge_bases_ids: string[];
    retrieval_type?: RetrievalType;
    tools_ids: string[];
    agent_tools_ids: string[];
    id: string;
    title: string;
    icon: string;
  }

  export interface AgentToolPO extends ChatContextPO, AgentNS.ToolDefine {}

  export interface AgentPO extends ChatContextPO {}

  export interface SessionPO {
    id: string;
    title: string;
    icon: string;
    agent_id: string;
    messages: AgentNS.Message[];
    new_message_image: string;
    new_message_content: string;
    model_id?: string;
    model_config?: any;
  }

  export interface EndpointPO {
    id: string;
    title: string;
    icon: string;
    endpoint_key: EndpointKeys;
    endpoint_config: any;
  }

  export interface KnowledgeItemPO {
    id: string;
    title: string;
    keywords: string[];
    text: string;
    vector: number[];
  }

  export interface KnowledgeBasePO {
    id: string;
    title: string;
    icon: string;
    model_id: string;
    model_config: any;
    data: KnowledgeItemPO[];
  }
}
