#!/usr/bin/env python3
"""Permit planned service retirements and private Garage storage only."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

RETIRED = {'scanner', 'case-redis', 'private-redis', 'privacy-worker', 'caddy'}
RETIRED_VOLUMES = {'suite-case-redis', 'suite-private-redis', 'suite-clamav', 'suite-caddy'}
GARAGE_IMAGE = "dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020"
CORE = {'case-api', 'privacy-api', 'converter', 'web', 'case-db', 'private-db'}


def validate(before, after):
    for kind, removable in [('networks', {'signature-updates'}), ('volumes', RETIRED_VOLUMES)]:
        old, new = before.get(kind, {}), after.get(kind, {})
        additions = {'evidence-storage'} if kind == 'networks' else {'garage-data', 'garage-meta'}
        if set(new) - set(old) - additions or set(old) - set(new) - removable:
            raise ValueError('Unrelated infrastructure changes require a separate procedure')
        if any(old[k] != new[k] for k in set(old) & set(new)):
            raise ValueError('Existing infrastructure must remain unchanged')
    old, new = before['services'], after['services']
    if not CORE <= set(new) or RETIRED & set(new):
        raise ValueError('Expected the six-service runtime topology')
    if set(old) - set(new) - RETIRED or set(new) - set(old) - {'garage'}:
        raise ValueError('Unrelated service additions or removals are not permitted')
    if 'garage' in new:
        garage = new['garage']
        if garage.get('image') != GARAGE_IMAGE or garage.get('ports') or set(garage.get('networks', {})) != {'evidence-storage'} or after.get('networks', {}).get('evidence-storage', {}).get('internal') is not True:
            raise ValueError('Evidence storage must use the pinned private Garage service')
    for name in ['case-db', 'private-db']:
        if old[name] != new[name]:
            raise ValueError('Database infrastructure must remain unchanged')
    for name in ['case-api', 'web']:
        if old[name].get('ports') != new[name].get('ports'):
            raise ValueError('Application port changes require a separate procedure')
    for secret in after.get('secrets', {}).values():
        if 'file' in secret and not Path(secret['file']).is_file():
            raise ValueError('A required production secret file is missing')


# No writes to Redis. Atomic inspection preserves the actual absolute expiry.
EXPORT = """
local cursor='0'
local result={}
repeat
 local page=redis.call('SCAN',cursor,'MATCH','limit:*','COUNT',1000)
 cursor=page[1]
 for _,key in ipairs(page[2]) do
  local expires=redis.call('PEXPIRETIME',key)
  if expires==-1 then return redis.error_reply('Counter has no expiry') end
  if expires>0 then
   table.insert(result,{key=key,hits=tonumber(redis.call('GET',key)),expires_ms=expires})
  end
 end
until cursor=='0'
if #result==0 then return '[]' end
return cjson.encode(result)
"""


def export_counters(service, output):
    if service not in {'case-redis', 'private-redis'}:
        raise ValueError('Unexpected counter store')
    payload = json.loads(subprocess.check_output([
        'docker', 'exec', f'whistle-suite-{service}-1', 'redis-cli', '--raw',
        'EVAL_RO', EXPORT, '0',
    ]))
    counters = {}
    for item in payload:
        key, hits = item['key'], item['hits']
        if not isinstance(key, str) or not key.startswith('limit:') or len(key) > 1024:
            raise ValueError('Invalid counter key')
        if not isinstance(hits, int) or not 0 < hits <= 9007199254740991:
            raise ValueError('Invalid counter value')
        expiry = datetime.datetime.fromtimestamp(item['expires_ms'] / 1000, datetime.timezone.utc)
        counters[key] = {'key': key, 'hits': hits, 'expires_at': expiry.isoformat()}
    with open(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump(list(counters.values()), stream)


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'validate':
            validate(json.loads(Path(sys.argv[2]).read_text()), json.loads(Path(sys.argv[3]).read_text()))
        elif sys.argv[1] == 'export':
            export_counters(sys.argv[2], sys.argv[3])
        else:
            raise ValueError('Unknown operation')
    except Exception:
        raise SystemExit('Deployment topology or rate-limit transition check failed')
