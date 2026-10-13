# Security and compliance

Reviewed October 12, 2026. This is our control plan, not proof of HIPAA compliance.

## Where we are now

- Synthetic fixtures only; labels aren't proof that content contains no PHI.
- Fresh worker per case; queue and CLI share a single-host lock.
- Node permissions limit worker reads to its case and writes to its run folder.
- Non-root container, read-only root, dropped capabilities, owner-only run files.
- HTTPS at CloudFront; origin HTTP restricted to CloudFront network ranges. Real data needs authenticated/encrypted origin transport.
- Encrypted EBS and private, encrypted S3 backups; stop workers before backup/restore.
- Cognito sign-in, signed tokens, PKCE, 15-minute sessions, explicit case assignments.
- Viewer/reviewer roles checked on the server; trusted identity saved with decisions.
- Local demo names are self-reported; localhost isn't production authentication.
- Hash-linked audit events omit document bodies; this isn't a remotely anchored, immutable audit store.
- Daily job limits, request rate limits, timeouts, cancellation, and explicit manual retry.
- Source membership checks quarantine suspicious attachments; they don't establish authenticity.
- Three unfixed HIGH runtime findings remain; track vendor fixes before any real-data release.
- MFA is optional in the demo. No general outbound network allowlist or distributed lock.

## Before real patient data

- Have privacy/security owners confirm HIPAA roles, permitted use, and release approval.
- Map PHI in inputs, prompts, responses, artifacts, logs, backups, and vendor systems.
- Document risks, mitigations, owners, and remaining gaps. [HHS risk analysis](https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html)
- Put required business associate agreements (BAAs) in place before vendors handle PHI.
- Verify the exact services, models, regions, and features covered by those agreements.
- Review vendor retention, training use, support access, subprocessors, and deletion.
- Encryption or a cloud provider's marketing claim alone doesn't establish compliance. [HHS cloud guidance](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html)

## Keep patients separate

- First release: one active case job per deployment, with a fresh worker process per job.
- Enforce serialization in the runner/queue; two separate CLI launches must not bypass it.
- Lock and SQLite scope are one host on one filesystem; multiple hosts are unsupported.
- Same-host dead processes are detected; cross-host locks require operator confirmation.
- Give each worker only its authorized case files and output location.
- Use a new model request/context each run; no shared patient chat history, memory, or caches.
- Scope storage, retrieval, and outputs by organization, patient, case, and run.
- Verify document membership before sending content to the model; quarantine mismatches or unclear identity.
- Production needs authoritative case membership and authorization beyond demo text headers.
- Bind results and reviewer approval to the exact case snapshot.
- Terminate workers and clean temporary files after success, failure, timeout, or cancellation.
- Serial processing reduces risk; it doesn't prevent leakage from stale state, wrong attachments, or incorrect permissions.
- Concurrent processing is a later design change requiring isolation tests and review.

These are project choices, not a HIPAA requirement to process patients serially. HIPAA calls for appropriate safeguards based on risk. [HHS Security Rule](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html)

## Protect the data

- Limit exposed fields and documents to the task; apply minimum-necessary rules where applicable. [HHS guidance](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/minimum-necessary-requirement/index.html)
- Require sign-in, reviewer roles, case-level authorization, and strong authentication.
- Use scoped workload credentials, managed secrets, TLS, and encryption at rest.
- Restrict network destinations to approved dependencies; source text can't authorize tools.
- Keep PHI out of Git, ordinary logs, terminal output, traces, and error messages.
- Treat saved prompts, raw outputs, and drafts as sensitive case records.
- Define retention and deletion for records, temporary files, backups, and vendor copies.
- Protect audit records; log access, analysis, edits, and approvals without document bodies.
- Document secure device/facility access, staff training, recovery, and incident/breach procedures.
- Recheck controls and agreements for each cloud deployment. [HHS safeguards](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html)

## Prove the controls work

- Test A then B: no A content survives in B's context, output, cache, or artifacts.
- Test simultaneous starts, wrong-patient attachments, and forged identifiers.
- Test denied access, path escapes, prompt injection, and output routing.
- Test crashes, retries, cancellation, cleanup, and backup restoration.
- Inspect logs and saved artifacts for unintended PHI exposure.
- Keep test evidence and security-owner approval before real-data release.

Passing these tests supports the review; it cannot guarantee zero contamination or establish compliance by itself.
