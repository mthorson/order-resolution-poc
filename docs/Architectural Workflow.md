# Architectural Workflow

1. **Goal and test data — Done**
   - Find missing and conflicting order details.
   - Five original cases, five regression cases, two frozen final cases.

2. **Contracts and success measures — Done**
   - Findings, exact evidence, status, and a follow-up draft.
   - [Rules](contracts-and-rules.md); [security plan](security-and-compliance.md).

3. **Analyzer design — Done**
   - Portable TypeScript core; replaceable model adapter.
   - AI proposes; code checks; humans decide.

4. **Working analyzer — Done**
   - One case per fresh process; quarantine and strict validation.
   - Private snapshots, raw responses, versions, and usage.

5. **Evaluation — Automated checks done**
   - Development AI 5/5; fresh final AI 2/2 versus rules 0/2.
   - New outputs still need human evidence and draft review.

6. **Reviewer dashboard — Done**
   - Selected-item evidence, dates, drafts, and saved decisions.
   - Changed documents require fresh analysis and review.

7. **Deployment and recovery — Implemented**
   - AWS HTTPS, Cognito, durable jobs, backups, and restore tools.
   - One host; manual retry after failures, with daily call limits.
   - Live sign-in and role checks passed; choose your own account passwords.

8. **Metrics — Done**
   - Usage, latency, jobs, versions, and recorded review time.
   - Cost stays unpriced until rates are verified.

9. **Monitoring — Implemented**
   - Job alerts, CloudWatch alarms, and a $50 monthly budget.
   - Budget covers the sandbox account, including other work.
   - Alarm delivery needs an owner/channel.

10. **Images and OCR — Paused**
    - Discuss source format before building it.

- See [completion notes](completion.md) and the [demo guide](demo.md).
