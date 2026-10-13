# Saved evaluations

- Curated synthetic live results from October 12, 2026; no credentials or reviewer identities included.
- Reports keep recorded scores, run IDs, model/version metadata, failures, and pending human review.
- Result paths are relative to each report directory. Original private runs remain untouched.
- Development: AI 5/5, baseline 5/5. Narrative repeat: AI 3/5, baseline 0/5. Final: AI 2/2, baseline 0/2.

```sh
npm ci
npm run verify:records
```

- Rechecks saved outputs against source snapshots, quotes, expected issue fields, and expected conflict values.
- Makes no model calls. Exit 0 means current pass/fail verdicts match the recorded verdicts, including failures.
- Historical validator: v3. Current validator: v4, adding conflict candidate-value checks.
- Original report hashes refer to the original expected files. Current expected files add conflict values; historical reports are not rewritten to claim a new live evaluation.
- This is reviewable saved evidence, not independent proof of provider execution or accuracy at scale.
- The final sample has two cases; narrative regression cases were used during prompt development.
- Human assessment of meaning and draft usefulness remains pending.
