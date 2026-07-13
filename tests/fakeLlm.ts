import type OpenAI from "openai";

interface CreateArgs {
  tools?: Array<{ type: string; function: { name: string } }>;
  messages: Array<{ role: string; content?: unknown }>;
}

function toolCallResponse(name: string, args: Record<string, unknown>) {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }]
      }
    }]
  };
}

/**
 * Stands in for the language model in agent tests: first searches the evidence store with the
 * user's question, then finishes with the given answer. Citing no ids makes the agent surface
 * everything the search harvested, so assertions can inspect realistic evidence and timelines.
 */
export function scriptedLlm(
  shortAnswer = "The scripted investigation reached an evidence-backed conclusion for this test."
): OpenAI {
  const create = async (args: CreateArgs) => {
    const searchTool = args.tools?.find((tool) => tool.function.name !== "finish");
    const searched = args.messages.some((message) => message.role === "tool");
    if (!searched && searchTool) {
      const question = [...args.messages].reverse().find((message) => message.role === "user");
      return toolCallResponse(searchTool.function.name, { query: String(question?.content ?? "") });
    }
    return toolCallResponse("finish", {
      shortAnswer,
      confidence: "medium",
      likelyRootCause: "Scripted root cause for tests.",
      citedEvidenceIds: [],
      openQuestions: ["Who owns the follow-up fix?"],
      recommendedActions: ["Confirm the causal chain with the service owner."]
    });
  };
  return { chat: { completions: { create } } } as unknown as OpenAI;
}
