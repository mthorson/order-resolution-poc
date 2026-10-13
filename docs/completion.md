# PoC status

## Built

- Evidence review UI, edited drafts, snapshot-bound decisions, viewer/reviewer permissions.
- Cognito, HTTPS AWS deployment, persistent jobs, isolated workers, cancellation, and manual retry.
- Source-change detection, metadata audits, usage/latency metrics, and operational alerts.
- Private backup storage, daily backup units, verified restore tooling, and cleanup dry runs.
- CloudFormation templates and CI checks; GitHub runs the workflow on pushes and pull requests.

## Checked

- TypeScript check, UI build, 74 backend tests, and 11 browser tests passed.
- npm audit: zero vulnerabilities; container scan: zero CRITICAL, three unfixed HIGH.
- HTTPS health 200, unsigned case API 401, live Cognito sign-in and both roles verified.
- Fixed the homepage redirect guard; cross-site APIs remain blocked.
- Temporary QA accounts/credentials deleted; original access policy restored.
- CASE-001 keeps a labeled QA changes-requested record; it is not human acceptance.
- Credential-free test evidence: `runs/deployment-checks/live-auth.json`.
- Deployed isolated Bedrock job succeeded; its earlier provider failure is preserved.
- S3 backup restored into disposable cloud storage: five cases, two jobs, valid audit chain.
- Live service restarted successfully; daily backup timer is enabled.
- Original live cases: 5/5; rules baseline: 5/5.
- Latest narrative regression repeat: 3/5; rules baseline: 0/5.
- Frozen final set, first pass: 2/2; rules baseline: 0/2.
- New model outputs still need human review; no measured business improvement claimed.

## Evaluation records

- Original: `60713c7c-d316-4067-97ca-12ca5cae1dfe`.
- Regression repeat: `e1ab7cc1-7d6f-4300-bc60-668bf32aef2e`.
- Frozen final: `1bc4ed3a-03bd-48ae-8f13-69e078b842b9`.
- Reports and failed attempts remain under `runs/evaluations/`; nothing was replaced.
- Recorded live runs: prompt v5, validator v3, Haiku 5.5. Current validator v4 checks conflict values.
- [Portable synthetic records](../evals/records/README.md) preserve the recorded successes and failures; current checks retain 5/5, 3/5, and 2/2.

## Human steps

- Run `bash scripts/test-sign-in.sh` to choose account passwords and check both roles.
- The $50 account-wide budget is a warning signal, not a hard cap.
- Choose an alarm recipient; current alerts are visible in the app and AWS console.
- Review the new outputs, especially narrative extraction and draft usefulness.

## Scope

- Synthetic data only; no HIPAA-compliance claim or real-data release approval.
- One host and one active case worker; another cloud and multiple hosts aren't tested.
- Model variability remains: one narrative miss and one rejected response in the regression repeat.
- OCR/images stay paused. No external messages, clinical decisions, or system updates.
- [Demo](demo.md), [deployment](deployment.md), [recovery](recovery.md), [security](security-and-compliance.md).

## Sharing

- Fresh-copy npm install, build, saved-record verification, and five-case startup passed.
- README starts with a self-contained Docker demo; Linux Node setup is also available.
- Candidate values are checked against quotes and independent evaluation answers.
- Pre-start cancellation stops worker launch; Reload asks before discarding edits.
- Hosted deployment still uses its previously published image; these fixes are in the local source.
