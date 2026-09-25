// A LangGraph.js agent: the context goes into the model call inside the node (never into the
// graph's state), the history tools run through ToolNode, and the callback records the answers.
//   NIADRA_API_KEY=... OPENAI_API_KEY=...
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { Niadra, handles } from "@niadra/sdk";
import { NiadraCallbackHandler, niadraTools, withNiadraContext } from "@niadra/sdk/langchain";

const niadra = new Niadra();

/** One customer message in; `userId` comes from your session, never from the model. */
export async function reply(userId: string, threadId: string, text: string): Promise<string> {
  const convo = niadra.conversation({ subject: handles.appUserId(userId), channel: "web_chat", conversation_id: threadId });
  const tools = niadraTools(convo);
  const model = new ChatOpenAI({ model: "gpt-4.1" }).bindTools(tools);

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", async (state) => ({ messages: [await model.invoke(await withNiadraContext(convo, state.messages))] }))
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition, ["tools", END])
    .addEdge("tools", "agent")
    .compile();

  const result = await graph.invoke(
    { messages: [new SystemMessage("You are Acme's support agent. Be brief."), new HumanMessage(text)] },
    { callbacks: [new NiadraCallbackHandler(convo)] },
  );
  return result.messages.at(-1)?.text ?? "";
}
