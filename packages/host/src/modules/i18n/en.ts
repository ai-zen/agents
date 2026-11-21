/**
 * 英文文案。**键就是那句中文原文**，值是对应的英文。
 *
 * 用原文当键，是为了不另维护一份键清单：多一份清单，就多一份会和原文对不上的账。
 * 代价是改一个中文字就失配，所以缺译文时回落成原文，不抛。
 */
export const en: Record<string, string> = {
  "找不到 id 为 {sessionId} 的会话": 'Cannot find the session "{sessionId}"',
  "找不到 id 为 {workspaceId} 的项目": 'Cannot find the workspace "{workspaceId}"',
  "目录 {cwd} 已经有项目了": 'A workspace already exists at "{cwd}"',
  "找不到 id 为 {modelId} 的模型": 'Cannot find the model "{modelId}"',
  "找不到 id 为 {agentDefinitionId} 的助手": 'Cannot find the agent definition "{agentDefinitionId}"',
  "找不到 id 为 {endpointId} 的端点": 'Cannot find the endpoint "{endpointId}"',
  "交接阈值 {handoff} 必须小于防护阈值 {guard}":
    "Handoff threshold {handoff} must be less than the guard threshold {guard}",
  "找不到思考档位表 {preset}": 'Cannot find the reasoning preset "{preset}"',
  "读不出 MCP 配置 {path}": 'Cannot read the MCP config "{path}"',
  "MCP 配置 {path} 不由宿主写入": 'The host does not write the MCP config "{path}"',
  "MCP 配置 {path} 里没有名为 {name} 的服务器":
    'The MCP config "{path}" has no server named "{name}"',
  "目录 {cwd} 上的能力容器还有 {count} 段会话活着，无法拆除":
    'Cannot dispose the scope at "{cwd}": {count} sessions are still live',
  "会话 {sessionId} 没有运行中的执行体，先运行它再投递":
    'Session "{sessionId}" has no running agent; start the session before sending',
  "宿主内部出错，这次调用没有完成": "Internal host failure: the call did not complete",
  "助手 {agentDefinitionId} 没有可用的模型":
    'The agent definition "{agentDefinitionId}" has no usable model',
  "找不到 id 为 {assetId} 的素材": 'Cannot find the asset "{assetId}"',
  "找不到 id 为 {credentialId} 的凭证": 'Cannot find the credential "{credentialId}"',
  "找不到 id 为 {questionId} 的题": 'Cannot find the question "{questionId}"',
  "题 {questionId} 的候选项里没有 {value}":
    'The question "{questionId}" has no choice "{value}"',
  "会话 {sessionId} 正在交接": 'Session "{sessionId}" is being handed off',
  "已存档_{name}": "archived_{name}",
  "会话 {sessionId} 没有运行中的执行体，无法交接":
    'Session "{sessionId}" has no running agent; handoff requires one',
  "会话 {sessionId} 还在回答，等它答完再交接":
    'Session "{sessionId}" is still answering; hand off after it becomes idle',
  "会话 {sessionId} 的输出已暂停，先恢复再交接":
    'Output for session "{sessionId}" is paused; resume it before handing off',
};
