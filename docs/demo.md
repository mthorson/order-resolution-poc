# Five-minute demo

- Local: follow the Docker or Linux quick start in the [README](../README.md); no account needed.
- Hosted: ask the project owner for reviewer-demo credentials, then open the [demo](https://d325n366v4dizu.cloudfront.net).
- CASE-002: select a missing field; compare relevant source excerpts.
- CASE-004: compare DOB/panel conflicts and dates; recency doesn't pick a winner.
- CASE-005: show the quarantined wrong-case attachment and injection warning.
- Edit a draft, confirm the evidence check, and save a decision.
- Reanalyze: watch the durable job, then open its new result; old reviews stay intact.
- Open Operations for usage, latency, versions, review effort, and failures.
- Hosted only: in a private window, viewer-demo sees only CASE-001 and cannot save reviews.
- Explain the result honestly: final AI 2/2 versus rules 0/2, but regression repeat 3/5.
- Images/OCR, clinical decisions, and external messages are outside this demo.

## Owner setup

- Choose account passwords with `bash scripts/test-sign-in.sh`; this requires your local AWS configuration.
- Check both accounts before sharing; give credentials privately to the recipient.
- Recipients do not need AWS access or the setup wizard.
