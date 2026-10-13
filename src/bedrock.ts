import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { ModelInvocationError, type ModelAdapter } from "./analyzer.ts";
import { z } from "zod";
import { proposalSchema } from "./validate-proposal.ts";

export function createBedrockAdapter(region: string, model: string) {
  const client = new BedrockRuntimeClient({ region, maxAttempts: 1 });
  const adapter: ModelAdapter = {
    provider: "aws-bedrock", model,
    async generate(request) {
      try {
        const response = await client.send(new ConverseCommand({
          modelId: model,
          system: [{ text: request.instructions }],
          messages: [{ role: "user", content: [{ text: JSON.stringify(request.caseBundle) }] }],
          inferenceConfig: { maxTokens: request.maxOutputTokens },
          ...(model.endsWith("claude-haiku-5-5") ? {
            additionalModelRequestFields: { thinking: { type: "adaptive" }, output_config: { effort: "low" } },
            toolConfig: { tools: [{ toolSpec: { name: "propose_case", description: "Return the case-review proposal; this output-only tool does not execute actions.",
              inputSchema: { json: JSON.parse(JSON.stringify(z.toJSONSchema(proposalSchema))) } } }], toolChoice: { tool: { name: "propose_case" } } },
          } : {}),
        }), { abortSignal: request.signal });
        const tools = response.output?.message?.content?.flatMap((part) => part.toolUse ? [part.toolUse] : []) ?? [];
        const proposal = tools.length === 1 && tools[0].name === "propose_case" && tools[0].input;
        const text = proposal ? JSON.stringify(proposal) : response.output?.message?.content?.flatMap((part) => part.text ? [part.text] : []).join("") ?? "";
        return { text,
          completion: response.stopReason === "end_turn" || (response.stopReason === "tool_use" && proposal) ? "complete" : response.stopReason === "max_tokens" ? "truncated" : "refused",
          usage: response.usage?.inputTokens !== undefined && response.usage.outputTokens !== undefined
            ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : null,
        };
      } catch { throw new ModelInvocationError(); }
    },
  };
  return { adapter, close: () => client.destroy() };
}
