#!/usr/bin/env python3
"""Create only missing, protected evidence-storage secrets; never print values."""
import os
from pathlib import Path
import secrets
import sys


def prepare(root):
    directory = Path(root) / 'secrets'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def put(name, value):
        path = directory / name
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as stream:
                stream.write(value)
        except FileExistsError:
            pass
        return path.read_text().strip()

    put('storage_access_key', 'GK' + secrets.token_hex(16))
    put('storage_secret_key', secrets.token_hex(32))
    rpc = put('garage_rpc_secret', secrets.token_hex(32))
    admin = put('garage_admin_token', secrets.token_hex(32))
    put('garage_config', f'''metadata_dir = "/meta"
data_dir = "/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "garage:3901"
rpc_secret = "{rpc}"
[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
[admin]
api_bind_addr = "127.0.0.1:3903"
admin_token = "{admin}"
''')


if __name__ == '__main__':
    prepare(sys.argv[1])
    print('Protected evidence-storage configuration ready.')
