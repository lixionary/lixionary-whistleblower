#!/usr/bin/env bash
set -euo pipefail
umask 077
config_dir="${SUITE_CONFIG_DIR:-.suite-dev}"
if [[ "$#" -eq 0 ]]; then set -- --env-file "$config_dir/suite.env"; fi
compose=(docker compose "$@")
python3 scripts/setup-storage-config.py "$config_dir" >/dev/null
for name in storage_access_key storage_secret_key garage_config; do
  [[ -f "$config_dir/secrets/$name" ]] || { echo 'Run scripts/setup-suite.mjs to prepare protected storage configuration.' >&2; exit 1; }
done
"${compose[@]}" up -d --wait --wait-timeout 60 garage >/dev/null
key_id="$(cat "$config_dir/secrets/storage_access_key")"
key_secret="$(cat "$config_dir/secrets/storage_secret_key")"
if ! "${compose[@]}" exec -T garage /garage bucket info whistle-evidence >/dev/null 2>&1; then
  "${compose[@]}" exec -T garage /garage bucket create whistle-evidence >/dev/null 2>&1
fi
if ! "${compose[@]}" exec -T garage /garage key info "$key_id" >/dev/null 2>&1; then
  "${compose[@]}" exec -T garage /garage key import --yes -n whistle-evidence "$key_id" "$key_secret" >/dev/null 2>&1
fi
"${compose[@]}" exec -T garage /garage bucket allow --read --write whistle-evidence --key "$key_id" >/dev/null 2>&1
unset key_secret key_id
printf 'Private evidence bucket and application access ready.\n'
