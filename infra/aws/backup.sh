#!/bin/bash
set -euo pipefail
umask 077
region=us-west-2
repository=476383094422.dkr.ecr.us-west-2.amazonaws.com/order-resolution-poc
bucket=order-review-poc-app-backups-tbfpovutgjfd
snapshot=$(date -u +%Y%m%dT%H%M%SZ)
backup_root=/var/lib/order-review/backups
mkdir -p "$backup_root"
chown 1000:1000 "$backup_root"
image_tag=$(aws ssm get-parameter --name /order-review-poc/image-tag --region "$region" --query Parameter.Value --output text)
# Never copy a database while its worker is writing.
systemctl stop order-review.service
trap 'systemctl start order-review.service' EXIT
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --mount type=bind,source=/var/lib/order-review/data,target=/app/runs \
  --mount type=bind,source="$backup_root",target=/backup \
  "$repository:$image_tag" node src/maintenance-cli.ts --action backup --destination "/backup/$snapshot"
aws s3 sync "$backup_root/$snapshot" "s3://$bucket/$snapshot/" --region "$region" --sse AES256 --only-show-errors
# Remove only the snapshot this invocation just uploaded.
rm -rf -- "$backup_root/$snapshot"
printf 'Backup uploaded: %s\n' "$snapshot"
