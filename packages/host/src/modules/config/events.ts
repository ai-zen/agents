/**
 * 配置里变的是哪一片。`general` 是除模型与 AgentDefinition 之外的其余部分：端点、默认项、全局开关。
 *
 * 事件不带改后的值：需要新值的一方自己再读一次配置。事件里再放一份，就有一份会和磁盘上
 * 那一份各自漂移。
 */
export type ConfigEvent =
  | { readonly kind: "general" }
  | { readonly kind: "models" }
  | { readonly kind: "mcp"; readonly scope: string }
  | { readonly kind: "agentDefinition"; readonly agentDefinitionId: string };
