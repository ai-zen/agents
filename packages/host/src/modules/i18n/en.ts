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
  "项目 {workspaceId} 的目录 {cwd} 已经不在了":
    'The directory "{cwd}" of the workspace "{workspaceId}" is gone',
  "找不到 id 为 {modelId} 的模型": 'Cannot find the model "{modelId}"',
  "找不到 id 为 {agentDefinitionId} 的 AgentDefinition":
    'Cannot find the agent definition "{agentDefinitionId}"',
  "已经有 id 为 {agentDefinitionId} 的 AgentDefinition 了，改它走 update":
    'The agent definition "{agentDefinitionId}" already exists; use update to change it',
  "AgentDefinition 标识 {agentDefinitionId} 只能由字母、数字、点、下划线与连字符组成，且不以点、下划线与连字符开头":
    'The agent definition id "{agentDefinitionId}" must be usable as a file name: letters, digits, dot, underscore and hyphen, and it must not start with dot, underscore or hyphen',
  "AgentDefinition {agentDefinitionId} 的模板里至少要有一条 system 消息":
    'The template of the agent definition "{agentDefinitionId}" needs at least one system message',
  "AgentDefinition {agentDefinitionId} 的 {dimension} 权限只能是 allow 或 deny 其一":
    'The {dimension} permission of the agent definition "{agentDefinitionId}" must be either allow or deny, not both',
  "AgentDefinition {agentDefinitionId} 的 {dimension} 权限必须是字符串数组":
    'The {dimension} permission of the agent definition "{agentDefinitionId}" must be an array of strings',
  "subagent {agentDefinitionId} 的函数名不能为空":
    'The function name of the subagent "{agentDefinitionId}" must not be empty',
  "subagent {agentDefinitionId} 的参数结构不是合法的 JSON：{reason}":
    'The function parameters of the subagent "{agentDefinitionId}" are not valid JSON: {reason}',
  "subagent {agentDefinitionId} 的参数结构必须是一个对象：它是一份 JSON Schema":
    'The function parameters of the subagent "{agentDefinitionId}" must be an object: they are a JSON Schema',
  "「{agentDefinitionId}」不是出厂的那两个之一":
    '"{agentDefinitionId}" is not one of the two factory agent definitions',
  "找不到 id 为 {endpointId} 的端点": 'Cannot find the endpoint "{endpointId}"',
  "交接阈值 {handoff} 必须小于防护阈值 {guard}":
    "Handoff threshold {handoff} must be less than the guard threshold {guard}",
  "找不到思考档位表 {preset}": 'Cannot find the reasoning preset "{preset}"',
  "读不出 MCP 配置 {path}": 'Cannot read the MCP config "{path}"',
  "MCP 配置 {path} 不由宿主写入": 'The host does not write the MCP config "{path}"',
  "MCP 配置 {path} 里没有名为 {name} 的服务器":
    'The MCP config "{path}" has no server named "{name}"',
  "会话 {sessionId} 没有运行中的 Agent，先运行它再投递":
    'Session "{sessionId}" has no running agent; start the session before sending',
  "宿主内部出错，这次调用没有完成": "Internal host failure: the call did not complete",
  "{version} 不是一个具体的版本号：挑版本是客户端的事，宿主只认一个号":
    '"{version}" is not a concrete version: picking one is the client\'s job, the host takes a single number',
  "{version} 在 registry 上没有，磁盘上也不是这一版":
    '"{version}" is not on the registry, and the installed copy is not that version',
  宿主访问令牌无效: "The host access token is not valid",
  "AgentDefinition {agentDefinitionId} 没有可用的模型":
    'The agent definition "{agentDefinitionId}" has no usable model',
  "找不到 id 为 {assetId} 的 Asset": 'Cannot find the asset "{assetId}"',
  "一张最多 4MB（{max} 字节），这一张 {bytes} 字节；超出上限报错，不截断":
    "One image may be up to 4MB ({max} bytes); this one is {bytes} bytes. Over the limit is an error, the bytes are not truncated",
  "找不到 id 为 {credentialId} 的凭证": 'Cannot find the credential "{credentialId}"',
  "找不到 id 为 {questionId} 的题": 'Cannot find the question "{questionId}"',
  "题 {questionId} 的候选项里没有 {value}": 'The question "{questionId}" has no choice "{value}"',
  "会话 {sessionId} 正在交接": 'Session "{sessionId}" is being handed off',
  "已存档_{name}": "archived_{name}",
  "会话 {sessionId} 没有运行中的 Agent，无法交接":
    'Session "{sessionId}" has no running agent; handoff requires one',
  "会话 {sessionId} 还在回答，等它答完再交接":
    'Session "{sessionId}" is still answering; hand off after it becomes idle',
  "会话 {sessionId} 的输出已暂停，先恢复再交接":
    'Output for session "{sessionId}" is paused; resume it before handing off',
  "交接失败：{reason}": "Handoff failed: {reason}",
  "交接文档已写到 {path}": "The handoff document is at {path}",
  "这一段会话自动起名失败，名字还是创建时的那一个":
    "Automatic naming failed for this session; the name is still the one from creation time",
  "这一次请求没有发出去：上一次请求的输入用了 {used} tokens，超过了防护阈值 {guard}。换模型、调高防护阈值或者新开一段会话之后可以接着试。":
    "This request was not sent: the previous request's input used {used} tokens, above the guard threshold of {guard}. Switch the model, raise the guard threshold, or start a new session, then try again.",
  "配置里没有 id 为 {modelId} 的模型": 'The config has no model "{modelId}"',
  "这段会话没有生效模型，思考档位只能跟随 AgentDefinition":
    "This session has no effective model; the thinking level can only follow the agent definition",
  "模型 {modelId} 没有思考档位，只能跟随 AgentDefinition":
    'The model "{modelId}" has no thinking levels; the thinking level can only follow the agent definition',
  "模型 {modelId} 没有 {level} 这一档，可选：{levels}":
    'The model "{modelId}" has no level "{level}"; available: {levels}',
  "这一段历史里没有 id 为 {messageId} 的消息": 'This history has no message "{messageId}"',
  "已经有 id 为 {endpointId} 的端点了": 'An endpoint with id "{endpointId}" already exists',
  "模型 {ids}": "model(s) {ids}",
  "图片模型 {ids}": "image model(s) {ids}",
  "端点 {endpointId} 上还挂着{hanging}，先把它们换走或删掉":
    'The endpoint "{endpointId}" still has {hanging} on it; move them elsewhere or delete them first',
  "已经有 id 为 {modelId} 的模型了": 'A model with id "{modelId}" already exists',
  "模型 {modelId} 的交接阈值与防护阈值都必须是数字":
    'The handoff and guard thresholds of the model "{modelId}" must both be numbers',
  "「{modelId}」不是出厂的那几个模型之一": '"{modelId}" is not one of the factory models',
  "已经有 id 为 {imageModelId} 的图片模型了":
    'An image model with id "{imageModelId}" already exists',
  "找不到 id 为 {imageModelId} 的图片模型": 'Cannot find the image model "{imageModelId}"',
  "配置里没有 id 为 {imageModelId} 的图片模型": 'The config has no image model "{imageModelId}"',
  "「{imageModelId}」不是出厂的那几个图片模型之一":
    '"{imageModelId}" is not one of the factory image models',
  "思考档位表必须是一张「策略名 → 档位」的表":
    "The reasoning presets must be a table of preset name → levels",
  "思考档位表 {preset} 必须是一个对象": 'The reasoning preset "{preset}" must be an object',
  "思考档位表 {preset} 的 custom 只有 true / false 两种":
    'The "custom" field of the reasoning preset "{preset}" must be true or false',
  "思考档位表 {preset} 缺少 levels": 'The reasoning preset "{preset}" has no "levels"',
  "思考档位表 {preset} 的 {level} 这一档必须是一个对象：一档的补丁是「参数名 → 值」":
    'Level "{level}" of the reasoning preset "{preset}" must be an object: a level patch is a map of parameter name → value',
  "只能撤回到自己说过的话之前：assistant 那条消息与工具结果不是这个意思":
    "You can only rewind to before something you said yourself; replies and tool results are not yours to unsend",
  "这段会话还在跑，等它停下来再撤回": "This session is still running; rewind once it stops",
  "用哪种方式交接？": "How should the handoff be written?",
  "自交接：在这段会话里接着写交接文档":
    "Self-handoff: continue in this session and write the handoff document there",
  "独立交接：另起一次调用写交接文档":
    "Independent handoff: write the handoff document in a separate call",
  "不交接：保持现状": "No handoff: leave things as they are",
  "交接没有开始：{reason}": "The handoff did not start: {reason}",
};
