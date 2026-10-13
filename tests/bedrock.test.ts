import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { ModelInvocationError } from "../src/analyzer.ts";
import { createBedrockAdapter } from "../src/bedrock.ts";
import { loadCase } from "../src/load-case.ts";

test("Bedrock adapter separates instructions/evidence and normalizes the response", async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const send = mock.method(BedrockRuntimeClient.prototype, "send", async (command: ConverseCommand, options: { abortSignal: AbortSignal }) => {
    calls++;
    assert.equal(options.abortSignal, signal);
    assert.equal(command.input.modelId, "test-model");
    assert.deepEqual(command.input.system, [{ text: "Trusted rules" }]);
    assert.equal(command.input.messages?.length, 1);
    assert.equal(command.input.inferenceConfig?.maxTokens, 1234);
    return { output: { message: { content: [{ text: "{" }, { text: "}" }] } },
      stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 8 } };
  });
  const bedrock = createBedrockAdapter("us-west-2", "test-model");
  try {
    const response = await bedrock.adapter.generate({ instructions: "Trusted rules",
      caseBundle: await loadCase("fixtures/patients/patient-001"), maxOutputTokens: 1234, signal });
    assert.deepEqual(response, { text: "{}", completion: "complete", usage: { inputTokens: 12, outputTokens: 8 } });
    assert.equal(calls, 1);
  } finally { bedrock.close(); send.mock.restore(); }
});

test("Bedrock errors don't expose provider details or trigger adapter retries", async () => {
  let calls = 0;
  const send = mock.method(BedrockRuntimeClient.prototype, "send", async () => {
    calls++; throw new Error("Sensitive provider details");
  });
  const bedrock = createBedrockAdapter("us-west-2", "test-model");
  try {
    await assert.rejects(bedrock.adapter.generate({ instructions: "rules",
      caseBundle: await loadCase("fixtures/patients/patient-001"), maxOutputTokens: 100,
      signal: new AbortController().signal }), (error: unknown) => {
      assert.ok(error instanceof ModelInvocationError);
      assert.doesNotMatch(error.message, /Sensitive/);
      return true;
    });
    assert.equal(calls, 1);
  } finally { bedrock.close(); send.mock.restore(); }
});

test("Haiku returns a structured output-only proposal with low-effort reasoning", async () => {
  const send = mock.method(BedrockRuntimeClient.prototype, "send", async (command: ConverseCommand) => {
    assert.deepEqual(command.input.additionalModelRequestFields, { thinking: { type: "adaptive" }, output_config: { effort: "low" } });
    assert.deepEqual(command.input.toolConfig?.toolChoice, { tool: { name: "propose_case" } });
    return { output: { message: { content: [{ toolUse: { name: "propose_case", toolUseId: "test", input: { value: "structured" } } }] } }, stopReason: "tool_use" };
  });
  const bedrock = createBedrockAdapter("us-west-2", "us.anthropic.claude-haiku-5-5");
  try { await bedrock.adapter.generate({ instructions: "rules", caseBundle: await loadCase("fixtures/patients/patient-001"),
    maxOutputTokens: 4096, signal: new AbortController().signal }); }
  finally { bedrock.close(); send.mock.restore(); }
});
