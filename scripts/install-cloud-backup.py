#!/usr/bin/env python3
"""Install the checked-in backup units through SSM; no SSH or secrets required."""
import argparse
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--profile', default='thorson-sandbox1-admin')
parser.add_argument('--region', default='us-west-2')
parser.add_argument('--stack', default='order-review-poc-app')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
base = ['aws', '--profile', args.profile, '--region', args.region]
stack = json.loads(subprocess.check_output(base + ['cloudformation', 'describe-stacks', '--stack-name', args.stack]))['Stacks'][0]
outputs = {entry['OutputKey']: entry['OutputValue'] for entry in stack['Outputs']}
commands = ['set -eu']
for source, target in [('backup.sh', '/usr/local/bin/order-review-backup'), ('backup.service', '/etc/systemd/system/order-review-backup.service'), ('backup.timer', '/etc/systemd/system/order-review-backup.timer')]:
    body = (root / 'infra/aws' / source).read_text()
    if source == 'backup.sh':
        body = body.replace('region=us-west-2', 'region=' + args.region)
        body = body.replace('repository=476383094422.dkr.ecr.us-west-2.amazonaws.com/order-resolution-poc', 'repository=' + outputs['RepositoryUri'])
        body = body.replace('bucket=order-review-poc-app-backups-tbfpovutgjfd', 'bucket=' + outputs['BackupBucket'])
    commands.append("cat > " + target + " <<'BACKUP_FILE'\n" + body + '\nBACKUP_FILE')
commands += ['chmod 700 /usr/local/bin/order-review-backup', 'systemctl daemon-reload', 'systemctl enable --now order-review-backup.timer']
result = json.loads(subprocess.check_output(base + ['ssm', 'send-command', '--instance-ids', outputs['InstanceId'], '--document-name', 'AWS-RunShellScript', '--parameters', json.dumps({'commands': commands})]))
print(json.dumps({'commandId': result['Command']['CommandId']}))
