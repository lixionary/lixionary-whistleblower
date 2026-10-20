#!/usr/bin/env bash
set -euo pipefail
umask 077
restic_bin="${RESTIC_BIN:-restic}"
: "${RESTIC_REPOSITORY:?Set an offsite sftp repository}"
: "${RESTIC_PASSWORD_FILE:?Set the protected restic password file}"
[[ "$RESTIC_REPOSITORY" == sftp:* ]] || { echo 'Offsite SFTP repository required'; exit 1; }
config_dir="${SUITE_CONFIG_DIR:-.suite-config}"
env_file="${SUITE_ENV_FILE:-$config_dir/suite.env}"
checkpoint_dir="${SUITE_CHECKPOINT_DIR:-$config_dir/checkpoints}"
mkdir -p "$checkpoint_dir"
staging="$(mktemp -d)"
compose=(docker compose --env-file "$env_file")
if [[ -f "$config_dir/active-release.json" ]]; then
  compose=(docker compose -f docker-compose.yml -f deploy/compose.vps.yml -f "$config_dir/active-release.json" --env-file "$env_file")
fi
restart_services(){ "${compose[@]}" start case-api privacy-api web >/dev/null; }
trap 'restart_services; find "$staging" -depth -delete' EXIT
"${compose[@]}" stop web case-api privacy-api >/dev/null
"${compose[@]}" run --rm --no-deps case-migrate node dist/cli/audit.js checkpoint - > "$staging/checkpoint.json"
"${compose[@]}" exec -T case-db pg_dump -U postgres -Fc suite_cases > "$staging/cases.dump"
"${compose[@]}" exec -T private-db pg_dump -U postgres -Fc suite_privacy > "$staging/privacy.dump"
vault_volume="$(docker inspect "$("${compose[@]}" ps --all -q privacy-api)" --format '{{range .Mounts}}{{if eq .Destination "/data/privacy"}}{{.Name}}{{end}}{{end}}')"
[[ -n "$vault_volume" ]] || { echo 'Vault volume not found'; exit 1; }
docker run --rm --network none -v "$vault_volume:/vault:ro" -v "$staging:/snapshot" alpine:3.22 tar -C /vault -cf /snapshot/vault.tar .
private_image="$(docker inspect "$("${compose[@]}" ps --all -q privacy-api)" --format '{{.Image}}')"
if docker run --rm --network none --entrypoint test "$private_image" -f /app/dist/cli/evidence-storage.js; then
  "${compose[@]}" run -T --rm --no-deps --entrypoint node --user "$(id -u):$(id -g)" -v "$staging:/snapshot" privacy-api dist/cli/evidence-storage.js export /snapshot/objects >/dev/null
fi
tar -C "$config_dir" -cf "$staging/config.tar" secrets suite.env
retention="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1])); if(!c.policy?.configured || !c.policy.body.retention) process.exit(1); process.stdout.write(String(c.policy.body.retention.backups))' "$staging/checkpoint.json")"
held="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(c.held.length?"held":"routine")' "$staging/checkpoint.json")"
restart_services
# Host SSH configuration must pin the offsite server key and restrict the backup account.
"$restic_bin" backup "$staging" --tag whistle-suite --tag "$held" >/dev/null
"$restic_bin" check >/dev/null
cp "$staging/checkpoint.json" "$checkpoint_dir/latest.json"
# Keep legal-hold snapshots indefinitely; release them only through the documented hold review.
"$restic_bin" forget --tag whistle-suite,routine --group-by tags --keep-within "${retention}d" --prune >/dev/null
# Prune eligible audit prefixes only after the integrity checkpoint is safely offsite.
"${compose[@]}" run --rm --no-deps -v "$checkpoint_dir:/checkpoint:ro" -e AUDIT_CHECKPOINT_FILE=/checkpoint/latest.json case-migrate node dist/cli/audit.js prune /checkpoint/latest.json >/dev/null
printf 'Encrypted offsite backup and audit checkpoint verified.\n'
