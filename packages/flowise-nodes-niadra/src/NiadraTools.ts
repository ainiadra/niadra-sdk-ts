import { niadraTools } from "@niadra/sdk/langchain";
import { CUSTOMER_INPUTS, clientFor, conversationFor } from "./common";
import type { ICommonObject, INode, INodeData, INodeParams } from "./flowise";

/**
 * The navigation kit for an agent node's Tools input: search_customer_history,
 * get_customer_timeline and open_history_item (and search_agent_memory with Agent Memory),
 * bound to the chat's customer. No tool has a parameter that names a customer.
 */
class NiadraTools_Tools implements INode {
  label = "Niadra Customer History";
  name = "niadraCustomerHistory";
  version = 1;
  type = "NiadraCustomerHistory";
  icon = "niadra.svg";
  category = "Tools";
  description = "Search the customer's past conversations, promises, actions and business objects";
  documentation = "https://docs.niadra.com/en";
  baseClasses = [this.type, "Tool", "StructuredTool"];
  inputs: INodeParams[] = CUSTOMER_INPUTS;

  async init(nodeData: INodeData, _input: string, options: ICommonObject = {}): Promise<ReturnType<typeof niadraTools>> {
    const sessionId = String(options.sessionId ?? options.chatId ?? "");
    const conversation = conversationFor(nodeData, clientFor(nodeData), sessionId);
    if (!conversation) return [];
    return niadraTools(conversation, nodeData.inputs?.agentMemory ? { agentMemory: true } : {});
  }
}

export const nodeClass = NiadraTools_Tools;
