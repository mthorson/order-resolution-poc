# Recover the demo

## Failed jobs

- Read the saved failure and its original input; no hidden model retries.
- Fix changed documents or configuration, then request a new analysis.
- Interrupted jobs become failed on restart; queued jobs remain queued.
- Same-host worker recovery checks PID and process start time.
- A lock from another host needs confirmation that its worker stopped.
- Cancel stops the local process; remote model computation may still finish.

## Cloud backup

- Daily at 02:00 UTC; app pauses while copying consistent data, then restarts.
- Units and script: `infra/aws/backup.*`; installer: `python3 scripts/install-cloud-backup.py`.
- S3 bucket: `order-review-poc-app-backups-tbfpovutgjfd`; snapshots expire after 30 days.
- Includes cases, saved inputs, outputs, reviews, SQLite jobs, and audit records.
- Identity settings and access assignments stay in CloudFormation/SSM; sessions aren't backed up.
- Cloud restore rehearsal passed: five cases, two jobs, and a valid audit chain.
- Use SSM to run `systemctl start order-review-backup.service` for an immediate snapshot.
- Inspect `journalctl -u order-review-backup.service`; a backup failure needs operator attention.

## Local backup and restore

```sh
# Stop the app and any CLI analysis first.
npm run maintain -- --action backup --destination /tmp/order-review-backup
# In a clean checkout/storage folder:
npm run maintain -- --action restore --source /tmp/order-review-backup
```

- Destination must be outside the project and not already exist.
- Restore checks every hash before writing; different existing files block restoration.
- For AWS, download a snapshot to private staging storage; restore into a fresh mounted runs folder with the same image.
- Verify case count, job history, audit integrity, and reviews before switching storage.
- Keep the original data folder until the restored app passes checks.

## Cleanup

```sh
npm run maintain -- --action cleanup --days 30
# Inspect the eligible list before deleting:
npm run maintain -- --action cleanup --days 30 --apply
```

- Worker must be stopped; default is a dry run.
- Referenced runs and reviewed runs are retained; this isn't a complete records-retention policy.
- Audits and job history stay intact; define a real retention policy before real data.

## Monitoring

- App alerts: stuck jobs, repeated failures, daily model-call threshold.
- AWS alarms: repeated job failures and sustained CPU pressure.
- No alert recipient is configured; check the app and AWS console during demos.
- The $50 sandbox-account budget is a signal, not a hard spending cap.
