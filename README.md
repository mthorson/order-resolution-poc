# Order resolution PoC

Help reviewers find missing or conflicting order information, inspect its evidence, and record a decision. AI proposes; code checks; humans decide.

Synthetic data only. No clinical decisions, messages, or order updates are executed.

## Try the demo

Use Docker on Linux, macOS, or Windows. No AWS account or saved run files needed.

```sh
docker build -t order-resolution-poc:local .
docker run --rm --name order-review-demo \
  -p 127.0.0.1:3000:3000 --read-only --tmpfs /tmp \
  --mount type=volume,source=order-review-demo-data,target=/app/runs \
  --cap-drop ALL --security-opt no-new-privileges \
  order-resolution-poc:local
```

Open <http://localhost:3000>. The demo seeds five prepared cases; reviews persist in the named volume. Reanalyze replays prepared responses and makes no cloud calls.

On Linux with Node 26+, you can also run:

```sh
npm ci
npm run build:ui
npm run serve -- --demo
```

- The UI worker uses Linux process locks; use Docker on macOS or Windows.
- [Five-minute walkthrough](docs/demo.md): missing fields, conflicts, quarantine, drafts, and review history.
- [Live synthetic demo](https://d325n366v4dizu.cloudfront.net): ask the project owner for demo credentials. You do not need AWS access.
- [Deployment](docs/deployment.md), [sign-in](docs/sign-in-and-access.md), and [recovery](docs/recovery.md).

## What it demonstrates

- Exact source quotations, grouped evidence, dates, and quarantined attachments.
- Runtime schemas, candidate-value checks, deterministic status rules, and human approval.
- Edited drafts and decisions saved separately against immutable source snapshots.
- Cognito sign-in, viewer/reviewer roles, and explicit case assignments.
- Durable jobs, isolated workers, cancellation, usage metrics, backups, and restore tooling.
- A TypeScript core with a replaceable model adapter and container deployment.

## Evaluation

| Dataset | Live AI | Rules baseline | Meaning |
| --- | --- | --- | --- |
| Five development cases | 5/5 | 5/5 | Development fixtures |
| Five narrative regression cases, latest repeat | 3/5 | 0/5 | Used during prompt development |
| Two frozen final cases, first pass | 2/2 | 0/2 | Small fresh sample |

- These results do not establish accuracy at scale or measured business improvement.
- Narrative failures include a missed supplied field and a rejected model response.
- Human assessment of the new outputs and draft usefulness remains pending.
- The baseline handles labeled text; it is not a general narrative parser.
- [Saved synthetic evidence](evals/records/README.md) includes successes and failures, with portable paths.

```sh
npm run verify:records
npm run evaluate -- --playback
npm run evaluate -- --dataset heldout --playback
```

Verification rechecks saved live outputs with current validation; it makes no model calls. Playback checks prepared responses and the harness, not model quality.

## Check the project

```sh
npm run check
npm test
npm run build:ui
npx playwright install --with-deps chromium
npm run test:ui
npm audit --audit-level=high
```

Backend and browser tests cover evidence integrity, roles, review persistence, cancellation, and unsaved edits. CI also builds and scans the container.

## Use the CLIs

```sh
npm run load-case -- --case fixtures/patients/patient-001
npm run analyze-case -- --case fixtures/patients/patient-001 --proposal fixtures/proposals/complete-case.json
npm run evaluate -- --playback
npm run ui
```

- Each command supports named flags and `--help`.
- `ui` opens a saved evaluation; use `serve -- --demo` for the self-contained demo.
- To preview one saved result, pass the path printed by analyze-case to `npm run review-case -- --result <path>`.
- CLI runs use a local lock. After a crash, confirm the worker stopped before removing `runs/.case-run.lock`.
- Run artifacts are private and Git-ignored; published synthetic records are a separate curated copy.

## Live analysis

```sh
AWS_PROFILE=your-profile npm run analyze-case -- \
  --case fixtures/patients/patient-001 --model YOUR_MODEL_ID --region YOUR_REGION
npm run evaluate -- --profile YOUR_PROFILE --region YOUR_REGION --model YOUR_MODEL_ID
```

- Paid calls require your AWS login and an accessible Converse-compatible model.
- One call per case, no automatic retries, a 60-second timeout, and 4,096 output tokens.
- Cancellation stops local startup/work; a remote call already sent may still finish.
- Use `--dataset heldout` for regression cases or `--dataset final` for the final set. Final playback responses are not included.
- Cost remains unpriced until a verified pricing basis is configured.

## Limits

- Quote/value matching does not establish semantic correctness or source authenticity.
- Human review remains required, including for apparently complete cases.
- One host and one active worker; multiple hosts and another cloud are untested.
- OCR/images, real patient data, external messages, and system updates are outside scope.
- No HIPAA-compliance or production-readiness claim.
- [Contracts and rules](docs/contracts-and-rules.md), [analyzer](docs/case-analyzer.md), [security](docs/security-and-compliance.md), and [status](docs/completion.md).
