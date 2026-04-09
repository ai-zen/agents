import { Agent } from "./Agent";
import { AgentNS } from "./AgentNS";

/**
 * Function calling context
 */
export class FunctionCallContext {
  agent: Agent;
  function_call: AgentNS.FunctionCall;
  parsed_args: any;
  result_message: AgentNS.Message;
  is_prevent_default = false;

  constructor(options: {
    agent: Agent;
    function_call: AgentNS.FunctionCall;
    result_message: AgentNS.Message;
  }) {
    this.agent = options.agent;
    this.function_call = options.function_call;
    this.parsed_args = options.function_call.arguments
      ? JSON.parse(options.function_call.arguments)
      : undefined;
    this.result_message = options.result_message;
  }

  /**
   * Usually used to mark blocking the next round of chat.
   */
  preventDefault() {
    this.is_prevent_default = true;
  }
}
