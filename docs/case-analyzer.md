# Design the case analyzer

## One call

```ts
const result = await analyzeCase(bundle, options);
```

- `bundle`: one loaded case snapshot.
- `options`: run ID, rules version, limits, and model adapter.
- `result`: validated analysis or explicit failure.
- Interface and implementation: [analyzer.ts](../src/analyzer.ts).
- Follow the [security plan](security-and-compliance.md): fresh case context, one active job, no shared patient state.

## Inside the analyzer

1. Check the bundle, hashes, supported rules, and size limits.
2. Quarantine mismatched/unclear headers; build instructions separately from remaining case text.
3. Call the model within the time, call, and output limits.
4. Parse its proposal; check shape, evidence, membership, and corrections.
5. Apply rules, calculate status, and check the follow-up draft.
6. Return the result with run metadata.

- Expected failures return `analysis_failed`; coding bugs still surface as errors.
- Invalid evidence never becomes a ready result.
- Semantic support still needs evaluation and human review.

## Model adapter

- `generate(request)` returns raw text, completion reason, and usage.
- Bedrock handles AWS authentication and provider-specific formatting.
- A controlled test adapter returns prepared responses without cloud calls.
- Adapters respect cancellation and report provider failures.
- Provider context limits count the full request; oversized inputs fail explicitly.
- Adapter retries count toward the same budget; start with no hidden retries.
- Switching providers requires evaluation; no automatic provider fallback.
- Haiku uses a schema-constrained, output-only proposal tool; local validation remains mandatory.
- An adapter must honor the abort signal. Remote computation can still finish after cancellation.

## Keep outside this module

- The [local runner](../src/analyze-case-cli.ts) owns file loading, the shared lock, and saved artifacts.
- Each CLI invocation starts a fresh process and model request.
- Exclusion details are merged locally after the model responds; quarantined text stays out of the request.
- Preserve raw responses before validation, including failed attempts.
- Persisting audit artifacts is required before reporting a run as saved.
- The job runner owns persistence and the UI owns human decisions; external actions stay out of scope.
- Workers use Node file permissions; the container has a read-only root. Network egress is not an allowlist.

## Missing-field inventory

- Code records every included source supplied to the model as considered input.
- Unknown source IDs still fail; the original model response stays unchanged.
- This inventory doesn't prove the model understood every document or that a field is absent.
