#!/usr/bin/env bash
set -euo pipefail
umask 077
restic_bin="${RESTIC_BIN:-restic}"
: "${RESTIC_REPOSITORY:?Set repository}"
: "${RESTIC_PASSWORD_FILE:?Set protected restic password file}"
: "${RESTORE_SNAPSHOT:?Set snapshot ID}"
: "${LATEST_MANIFEST:?Path to the newest verified checkpoint, including deletions and holds}"
: "${RESTORE_CONFIG_DIR:?Choose a new protected configuration directory}"
: "${RESTORE_PROJECT:?Choose a new isolated Compose project}"
[[ "$RESTORE_PROJECT" == whistle-suite-restore-* ]] || { echo 'Restore project must start with whistle-suite-restore-'; exit 1; }
[[ ! -e "$RESTORE_CONFIG_DIR" ]] || { echo 'Restore config directory must be new'; exit 1; }
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$RESTORE_PROJECT")" ]] || { echo 'Restore project already has containers'; exit 1; }
[[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$RESTORE_PROJECT")" ]] || { echo 'Restore project already has volumes'; exit 1; }
staging="$(mktemp -d)"
"$restic_bin" restore "$RESTORE_SNAPSHOT" --target "$staging" --verify >/dev/null
snapshot="$(find "$staging" -name cases.dump -type f -print -quit)"
[[ -n "$snapshot" ]] || { echo 'Snapshot does not contain suite data'; exit 1; }
snapshot="$(dirname "$snapshot")"
mkdir -p "$RESTORE_CONFIG_DIR"
tar -C "$RESTORE_CONFIG_DIR" -xf "$snapshot/config.tar"
export SUITE_CONFIG_DIR="$RESTORE_CONFIG_DIR"
python3 scripts/setup-storage-config.py "$RESTORE_CONFIG_DIR" >/dev/null
compose=(docker compose -f docker-compose.yml -f deploy/compose.restore.yml --project-name "$RESTORE_PROJECT" --env-file "$RESTORE_CONFIG_DIR/suite.env")
"${compose[@]}" up -d case-db private-db >/dev/null
for service in case-db private-db; do
  for attempt in $(seq 1 30); do
    if "${compose[@]}" exec -T "$service" pg_isready -U postgres >/dev/null; then break; fi
    sleep 1
  done
done
"${compose[@]}" exec -T case-db pg_restore -U postgres -d suite_cases --no-owner --no-privileges --exit-on-error < "$snapshot/cases.dump"
"${compose[@]}" exec -T private-db pg_restore -U postgres -d suite_privacy --no-owner --no-privileges --exit-on-error < "$snapshot/privacy.dump"
for domain in case private; do
  args=(run -T --rm)
  input=/dev/null
  if [[ -f "$snapshot/$domain-rate-limits.json" ]]; then
    args+=(-e RATE_LIMIT_IMPORT_STDIN=1)
    input="$snapshot/$domain-rate-limits.json"
  fi
  service=case-migrate
  [[ "$domain" != private ]] || service=private-migrate
  "${compose[@]}" "${args[@]}" "$service" < "$input" >/dev/null
done
docker volume create "${RESTORE_PROJECT}_suite-vault" >/dev/null
docker run --rm --network none -v "${RESTORE_PROJECT}_suite-vault:/vault" -v "$snapshot:/snapshot:ro" alpine:3.22 sh -c 'tar -C /vault -xf /snapshot/vault.tar && chown -R 1000:1000 /vault'
bash scripts/setup-storage.sh "${compose[@]:2}" >/dev/null
if [[ -f "$snapshot/objects/manifest.json" ]]; then
  "${compose[@]}" run -T --rm --no-deps --entrypoint node --user "$(id -u):$(id -g)" -v "$snapshot:/snapshot:ro" privacy-api dist/cli/evidence-storage.js import /snapshot/objects >/dev/null
else
  [[ "$("${compose[@]}" exec -T private-db psql -U postgres -d suite_privacy -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM files WHERE storage_backend='s3'")" == "0" ]] || { echo 'S3 evidence snapshot is missing its object manifest.' >&2; exit 1; }
fi
"${compose[@]}" run --rm --no-deps -v "$(dirname "$LATEST_MANIFEST"):/manifest:ro" -e "AUDIT_CHECKPOINT_FILE=/manifest/$(basename "$LATEST_MANIFEST")" case-migrate node dist/cli/audit.js replay-deletions "/manifest/$(basename "$LATEST_MANIFEST")" >/dev/null
"${compose[@]}" exec -T private-db psql -U postgres -d suite_privacy -v ON_ERROR_STOP=1 -c "UPDATE challenges SET used_at=now(); UPDATE admission_challenges SET used_at=now(),proof_hash=null; DELETE FROM intakes WHERE case_id IS NULL; DELETE FROM admission_grants; DELETE FROM delivery_jobs WHERE kind IN ('otp','notify','admission_otp','admission_decision');" >/dev/null
"${compose[@]}" run --rm --no-deps case-migrate node dist/cli/audit.js verify >/dev/null
printf 'Restored into an isolated, stopped suite. Review manifests and configure test delivery before starting it.\n'
printf 'Keep deploy/compose.restore.yml included when operating this restore; it removes published host ports.\n'
printf 'Protected restore staging directory: %s\n' "$staging"
