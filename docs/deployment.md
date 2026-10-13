# Run the demo

## AWS

- URL: https://d325n366v4dizu.cloudfront.net
- Profile: `thorson-sandbox1-admin`; region: `us-west-2`.
- CloudFormation: `order-review-poc-auth` and `order-review-poc-app`.
- Source: [Cognito template](../infra/cognito/template.json), [app template](../infra/aws/template.json).
- One `t3.small` host; no SSH; use Systems Manager.
- HTTPS at CloudFront; private-origin network rule; encrypted persistent disk.
- Cognito accounts need first passwords: `bash scripts/test-sign-in.sh`.
- Five playback cases seed the first start; Reanalyze uses live Bedrock.
- Durable jobs: one patient at a time; 10 live jobs/day, 50 total/day.
- Host data: `/var/lib/order-review/data`; service: `order-review.service`.
- Immutable ECR image tag: `poc-v6`; runtime version lives in `/order-review-poc/image-tag`.
- Update templates through an inspected CloudFormation change set; restart the service after choosing a published image tag.
- Access changes live in `/order-review-poc/access`; restart refreshes the mounted policy.

## Cost

- Approved ceiling: $50/month; estimated compute, IPv4, and disk base: about $20/month.
- Model calls, traffic, logs, image storage, and backups add usage charges.
- The $50 budget covers the sandbox account, including unrelated work; it doesn't stop spending.
- No cost-tag activation is needed for this account-wide budget.
- Bedrock rates aren't verified here, so UI cost remains unpriced.
- Stop the EC2 instance when idle; disk, public IPv4, and backups can still cost money.
- Deleting the stack retains data storage; inspect retained resources when retiring the demo.

## Local playback

```sh
docker build -t order-resolution-poc:local .
docker run --rm --name order-review-demo \
  -p 127.0.0.1:3000:3000 --read-only --tmpfs /tmp \
  --mount type=volume,source=order-review-demo-data,target=/app/runs \
  --cap-drop ALL --security-opt no-new-privileges \
  order-resolution-poc:local
```

- Open `http://localhost:3000`; the named volume keeps jobs and reviews.
- Default jobs use playback and make no cloud calls.
- Without Docker on Linux/Node 26+: `npm ci`, `npm run build:ui`, then `npm run serve -- --demo`.
- macOS and Windows use Docker; UI worker ownership checks require Linux `/proc`.
- `/healthz` contains no case data; health checks don't test provider availability.

## Portability

- Same TypeScript core, container, HTTP API, and mounted data folder.
- Replace cloud identity settings, IAM/secrets, TLS ingress, backup storage, and monitoring.
- Another model provider needs an adapter and a fresh evaluation.
- SQLite and worker locks require one instance on one persistent filesystem.
- Multi-instance deployment needs shared sessions and distributed job ownership.
- AWS deployment is verified; another cloud hasn't been deployed or tested.

## Runtime security

- Non-root, read-only root, dropped capabilities, no new privileges.
- npm/Yarn tooling stays in build stages; the runtime starts directly with Node.
- ECR scan: zero CRITICAL, three unfixed HIGH findings in base libraries.
- CI blocks fixable HIGH/CRITICAL findings; it doesn't claim a vulnerability-free image.
- Review vendor patches before any real-data release.
