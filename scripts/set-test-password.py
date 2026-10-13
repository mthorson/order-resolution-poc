#!/usr/bin/env python3
"""Let the account owner choose a first password without printing or saving it."""
import argparse
import getpass
import json
import re
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--username", required=True, choices=["viewer-demo", "reviewer-demo"])
parser.add_argument("--pool", required=True)
parser.add_argument("--profile", default="thorson-sandbox1-admin")
parser.add_argument("--region", default="us-west-2")
args = parser.parse_args()
aws = ["aws", "cognito-idp", "--profile", args.profile, "--region", args.region]

try:
    user = subprocess.run(aws + ["admin-get-user", "--user-pool-id", args.pool,
        "--username", args.username, "--output", "json"], check=True, capture_output=True, text=True)
    if json.loads(user.stdout)["UserStatus"] == "CONFIRMED":
        print(f"{args.username} already has a permanent password; leaving it unchanged.")
        raise SystemExit(0)
    print(f"Choose the first password for {args.username}.")
    print("Use at least 14 characters with uppercase, lowercase, numbers, and symbols.")
    password = getpass.getpass("Password (hidden): ")
    if len(password) < 14 or not all(re.search(pattern, password) for pattern in [r"[A-Z]", r"[a-z]", r"[0-9]", r"[^A-Za-z0-9\s]"]):
        raise ValueError("The password doesn't meet the requirements.")
    if password != getpass.getpass("Confirm password (hidden): "):
        raise ValueError("Passwords don't match.")
    # The command line contains only a private temporary filename, never the password.
    with tempfile.NamedTemporaryFile(mode="w+", suffix=".json") as request:
        json.dump({"UserPoolId": args.pool, "Username": args.username,
            "Password": password, "Permanent": True}, request)
        request.flush()
        subprocess.run(aws + ["admin-set-user-password", "--cli-input-json", f"file://{request.name}"],
            check=True, capture_output=True, text=True)
    print(f"First password set for {args.username}; it wasn't printed or saved locally.")
except ValueError as error:
    parser.exit(1, f"{error}\n")
except subprocess.CalledProcessError:
    parser.exit(1, "AWS couldn't complete password setup. Check the account, pool, and password policy.\n")
