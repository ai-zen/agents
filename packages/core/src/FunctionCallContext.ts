import { Agent } from "./Agent.js";
import { AgentNS } from "./AgentNS.js";

/**
 * Function calling context
 */
export class FunctionCallContext {
  agent: Agent;
  function_call: AgentNS.FunctionCall;
  parsed_args: any;
  result_message: AgentNS.Message;
  is_prevent_default = false;
  parse_error?: string;

  constructor(options: {
    agent: Agent;
    function_call: AgentNS.FunctionCall;
    result_message: AgentNS.Message;
    allowJsonParseError?: boolean;
  }) {
    this.agent = options.agent;
    this.function_call = options.function_call;
    this.result_message = options.result_message;

    if (options.function_call.arguments) {
      try {
        this.parsed_args = JSON.parse(options.function_call.arguments);
      } catch (e: any) {
        if (options.allowJsonParseError) {
          this.parsed_args = undefined;
          this.parse_error = e.message;
        } else {
          throw e;
        }
      }
    }
  }

  /**
   * Usually used to mark blocking the next round of chat.
   */
  preventDefault() {
    this.is_prevent_default = true;
  }
}
