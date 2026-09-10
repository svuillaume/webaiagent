#!/usr/bin/env python3
"""Reads a ~/.lacework.toml (first [profile] section only, same rule serve.py's
_lw_creds() uses) and prints shell `export` lines for the forticnapp-mcp env vars.
Usage: python3 parse_lacework_toml.py /path/to/lacework.toml
"""
import sys

path = sys.argv[1]
account = api_key = api_secret = ''
past_first_section = False
for line in open(path):
    line = line.strip()
    if line.startswith('['):
        if past_first_section:
            break
        past_first_section = True
        continue
    if line.startswith('account') and not account:
        account = line.split('=', 1)[1].strip().strip('"')
    elif line.startswith('api_key') and not api_key:
        api_key = line.split('=', 1)[1].strip().strip('"')
    elif line.startswith('api_secret') and not api_secret:
        api_secret = line.split('=', 1)[1].strip().strip('"')

if not (account and api_key and api_secret):
    print(f'echo "Could not find account/api_key/api_secret in {path}" >&2; exit 1', file=sys.stdout)
    sys.exit(0)

print(f'export FORTICNAPP_API_BASE_URL="https://{account}.lacework.net"')
print(f'export FORTICNAPP_KEY_ID="{api_key}"')
print(f'export FORTICNAPP_API_SECRET="{api_secret}"')
