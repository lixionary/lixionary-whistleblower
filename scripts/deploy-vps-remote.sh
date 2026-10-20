#!/usr/bin/env bash
set -euo pipefail
umask 077
mode="${1:?Mode required}"
revision="${2:?Revision required}"
release_id="${3:-}"
[[ "$mode" == check || "$mode" == deploy ]] || exit 1
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 1
root=/app/lixionary-whistleblower
config="$root/.suite-config"
cd "$root"
export SUITE_CONFIG_DIR="$config"
unset COMPOSE_PROFILES
base=(docker compose --project-name whistle-suite -f "$root/docker-compose.yml" -f "$root/deploy/compose.vps.yml" --env-file "$config/suite.env")
die(){ printf '%s\n' "$1" >&2; exit 1; }
for command in git docker python3 flock curl tar; do command -v "$command" >/dev/null || die "Missing VPS command: $command"; done
[[ "$(git branch --show-current)" == main ]] || die 'VPS checkout must be on main.'
[[ -z "$(git status --porcelain)" ]] || die 'VPS checkout has local changes; refusing to overwrite them.'
[[ -f "$config/suite.env" ]] || die 'Production configuration is missing; complete the initial runbook installation.'
python3 - "$config/suite.env" <<'PY'
import sys
import cryptography
from pathlib import Path
v={}
for line in Path(sys.argv[1]).read_text().splitlines():
 if line.strip() and not line.startswith('#') and '=' in line:
  k,val=line.split('=',1);v[k]=val.strip()
if v.get('SUITE_NODE_ENV')!='production' or v.get('PUBLIC_WEB_URL')!='https://whistle-blower.lixionary.com':
 raise SystemExit('Expected the existing production environment and HTTPS URL.')
PY
"${base[@]}" config --quiet
sudo -n nginx -t
python3 - "${base[@]}" config --format json <<'PY'
import json,subprocess,sys
configured=json.loads(subprocess.check_output(sys.argv[1:]))['services']
names=[n for n in ['case-api','privacy-api','privacy-worker','web','converter','case-db','private-db','case-redis','private-redis'] if n in configured]
for name in names:
 c=json.loads(subprocess.check_output(['docker','inspect',f'whistle-suite-{name}-1']))[0]
 if not c['State']['Running'] or c['State'].get('Health',{}).get('Status','healthy')!='healthy':
  raise SystemExit(f'Existing service is not ready: {name}')
PY
[[ "$(df -Pk "$root" | awk 'NR==2 {print $4}')" -ge 8388608 ]] || die 'VPS needs at least 8 GiB free disk space for a release and snapshot.'
if [[ "$mode" == check ]]; then
  printf 'VPS preflight passed: production configuration, services, Docker, backup encryption and nginx.\n'
  exit 0
fi
[[ "$release_id" =~ ^${revision}-[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || die 'Invalid release identifier.'
release="$config/releases/$release_id"
[[ -d "$release" && -f "$release/images.tar.gz" ]] || die 'Upload the release images first.'
exec 9>"$config/deploy.lock"
flock -n 9 || die 'Another deployment holds the VPS lock.'
git fetch --quiet origin main
[[ "$(git rev-parse origin/main)" == "$revision" ]] || die 'origin/main changed; restart deployment from the intended revision.'
git merge-base --is-ancestor HEAD "$revision" || die 'Deployment would rewind or diverge from the VPS checkout.'
[[ -z "$(git status --porcelain)" ]] || die 'VPS checkout changed during preflight.'
git show "$revision:docker-compose.yml" > "$release/requested-compose.yml"
git show "$revision:deploy/compose.vps.yml" > "$release/requested-vps.yml"
# Preserve existing values while preparing the new service's protected files.
if [[ -f "$release/setup-storage-config.py" ]]; then python3 "$release/setup-storage-config.py" "$config" >/dev/null; fi
"${base[@]}" config --format json > "$release/previous-config.json"
docker compose --project-name whistle-suite --project-directory "$root" \
  -f "$release/requested-compose.yml" -f "$release/requested-vps.yml" \
  --env-file "$config/suite.env" config --format json > "$release/requested-config.json"
python3 "$release/deployment-topology.py" validate "$release/previous-config.json" "$release/requested-config.json"
read -r -a old_writers <<< "$(python3 - "$release/previous-config.json" <<'PY'
import json,sys
services=json.load(open(sys.argv[1]))['services']
print(' '.join(n for n in ['web','case-api','privacy-api','privacy-worker'] if n in services))
PY
)"

stopped=0
migrating=0
cleanup(){
  status=$?
  trap - EXIT
  if [[ -d "$release/staging" ]]; then
    find "$release/staging" -depth -delete
  fi
  if [[ "$status" -ne 0 && "$stopped" -eq 1 && "$migrating" -eq 0 ]]; then
    "${old[@]}" start "${old_writers[@]}" >/dev/null 2>&1 || true
  fi
  if [[ "$status" -ne 0 ]]; then
    printf 'Deployment failed. Protected release logs and snapshot: %s\n' "$release" >&2
    if [[ "$migrating" -eq 1 ]]; then printf 'Migrations may have applied; use the runbook recovery procedure. Older binaries were not restarted.\n' >&2; fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# Preserve the actual running image identities for the snapshot/old audit CLI.
python3 - "$release" "$revision" <<'PY'
import json,subprocess,sys
from pathlib import Path
folder=Path(sys.argv[1]); revision=sys.argv[2]
services={}
configured=json.loads((folder/'previous-config.json').read_text())['services']
for name in ['case-api','privacy-api','privacy-worker','converter','web']:
 if name not in configured:continue
 c=json.loads(subprocess.check_output(['docker','inspect',f'whistle-suite-{name}-1']))[0]
 services[name]={'image':c['Image'],'pull_policy':'never'}
services['case-migrate']=services['case-api'];services['private-migrate']=services['privacy-api']
(folder/'previous-images.json').write_text(json.dumps({'services':services}))
manifest=json.loads((folder/'images.json').read_text())
if manifest.get('revision')!=revision or set(manifest.get('images',{}))!={'case','private','web'}:
 raise SystemExit('Invalid release image manifest')
PY
old=("${base[@]}" -f "$release/previous-images.json")
printf 'Loading revision-specific application images...\n'
docker load -i "$release/images.tar.gz" > "$release/image-load.log" 2>&1
python3 - "$release" "$revision" <<'PY'
import json,re,subprocess,sys
from pathlib import Path
folder=Path(sys.argv[1]);revision=sys.argv[2];images=json.loads((folder/'images.json').read_text())['images']
for image in images.values():
 if not re.fullmatch('sha256:[a-f0-9]{64}',image):raise SystemExit('Invalid image ID')
 c=json.loads(subprocess.check_output(['docker','image','inspect',image]))[0]
 if c['Architecture']!='amd64' or c['Os']!='linux' or c['Config'].get('Labels',{}).get('org.opencontainers.image.revision')!=revision:
  raise SystemExit('Image platform or revision mismatch')
mapping={'case-api':'case','case-migrate':'case','privacy-api':'private','private-migrate':'private','converter':'private','web':'web'}
(folder/'compose.images.json').write_text(json.dumps({'services':{k:{'image':images[v],'pull_policy':'never'} for k,v in mapping.items()}}))
PY

printf 'Taking a consistent encrypted snapshot before migrations...\n'
mkdir -m 700 "$release/staging"
stopped=1
"${old[@]}" stop "${old_writers[@]}" > "$release/backup.log" 2>&1
"${old[@]}" run -T --rm --no-deps case-migrate node dist/cli/audit.js checkpoint - > "$release/staging/checkpoint.json" 2>> "$release/backup.log"
for domain in case private; do
  if python3 - "$release/previous-config.json" "$domain-redis" <<'PY'
import json,sys
sys.exit(0 if sys.argv[2] in json.load(open(sys.argv[1]))['services'] else 1)
PY
  then
    python3 "$release/deployment-topology.py" export "$domain-redis" "$release/$domain-rate-limits.json"
  else
    printf '[]\n' > "$release/$domain-rate-limits.json"
  fi
  cp "$release/$domain-rate-limits.json" "$release/staging/$domain-rate-limits.json"
done
"${old[@]}" exec -T case-db pg_dump -U postgres -Fc suite_cases > "$release/staging/cases.dump"
"${old[@]}" exec -T private-db pg_dump -U postgres -Fc suite_privacy > "$release/staging/privacy.dump"
vault="$(docker inspect whistle-suite-privacy-api-1 --format '{{range .Mounts}}{{if eq .Destination "/data/privacy"}}{{.Name}}{{end}}{{end}}')"
[[ -n "$vault" ]] || die 'Private vault volume not found.'
backup_image="$(docker inspect whistle-suite-case-api-1 --format '{{.Image}}')"
docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint tar \
  -v "$vault:/vault:ro" -v "$release/staging:/snapshot" "$backup_image" -C /vault -cf /snapshot/vault.tar .
# Older images have only a filesystem vault; newer images also export sealed S3 objects.
private_image="$(docker inspect whistle-suite-privacy-api-1 --format '{{.Image}}')"
if docker run --rm --network none --entrypoint test "$private_image" -f /app/dist/cli/evidence-storage.js; then
  "${old[@]}" run -T --rm --no-deps --entrypoint node --user "$(id -u):$(id -g)" -v "$release/staging:/snapshot" privacy-api dist/cli/evidence-storage.js export /snapshot/objects >> "$release/backup.log" 2>&1
fi
tar -C "$config" -cf "$release/staging/config.tar" secrets suite.env
cp "$root/docker-compose.yml" "$release/staging/docker-compose.yml"
cp "$root/deploy/compose.vps.yml" "$release/staging/compose.vps.yml"
cp "$release/previous-images.json" "$release/staging/previous-images.json"
cp /etc/nginx/sites-available/whistle-blower.lixionary.com.conf "$release/staging/nginx.conf"
git rev-parse HEAD > "$release/staging/previous-revision"
python3 "$release/deployment-backup.py" encrypt "$release/staging" "$release/snapshot.wbenc" "$release/recovery.key" >> "$release/backup.log" 2>&1
find "$release/staging" -depth -delete
printf '__WB_BACKUP_READY__ %s\n' "$release_id"
IFS= read -r -t 1800 acknowledgement || die 'Local backup verification timed out.'
[[ "$acknowledgement" == "BACKUP_VERIFIED $release_id" ]] || die 'Local snapshot verification failed; migrations were not started.'

git merge --ff-only "$revision" > "$release/checkout.log" 2>&1
[[ "$(git rev-parse HEAD)" == "$revision" ]] || die 'VPS checkout does not match the validated revision.'
new=("${base[@]}" -f "$release/compose.images.json")
"${new[@]}" config --quiet
if [[ -f scripts/setup-storage.sh ]]; then bash scripts/setup-storage.sh "${new[@]:2}" > "$release/storage.log" 2>&1; fi
printf 'Applying migrations, then starting the verified image IDs...\n'
migrating=1
"${new[@]}" run -T --rm --no-deps -e RATE_LIMIT_IMPORT_STDIN=1 case-migrate < "$release/case-rate-limits.json" > "$release/migrations.log" 2>&1
"${new[@]}" run -T --rm --no-deps -e RATE_LIMIT_IMPORT_STDIN=1 private-migrate < "$release/private-rate-limits.json" >> "$release/migrations.log" 2>&1
"${new[@]}" up -d --no-build --no-deps --pull never --wait --wait-timeout 600 case-api privacy-api converter web > "$release/start.log" 2>&1
stopped=0

# nginx changes are limited to this site's files; failed validation restores it.
cp /etc/nginx/sites-available/whistle-blower.lixionary.com.conf "$release/previous-nginx.conf"
sudo -n install -m 644 deploy/nginx/whistle-blower.lixionary.com.conf /etc/nginx/sites-available/whistle-blower.lixionary.com.conf
if ! sudo -n nginx -t; then
  sudo -n install -m 644 "$release/previous-nginx.conf" /etc/nginx/sites-available/whistle-blower.lixionary.com.conf
  die 'New nginx configuration failed validation; the previous site was restored.'
fi
sudo -n install -m 755 deploy/nginx/renew-whistle-blower.sh /etc/letsencrypt/renewal-hooks/deploy/whistle-blower-nginx
sudo -n systemctl reload nginx
curl --fail --silent --show-error --max-time 20 http://127.0.0.1:9550/api/health > /dev/null
curl --fail --silent --show-error --max-time 20 http://127.0.0.1:9551/privacy/health > /dev/null
"${new[@]}" run -T --rm --no-deps case-migrate node dist/cli/audit.js verify > "$release/audit.log" 2>&1
# Verify the public proxy and frontend identity before retiring the old topology.
for endpoint in /api/health /privacy/health /; do
  file=public-home.html
  [[ "$endpoint" != /api/health ]] || file=public-case-health.json
  [[ "$endpoint" != /privacy/health ]] || file=public-private-health.json
  curl --fail --silent --show-error --retry 3 --retry-connrefused --max-time 20 "https://whistle-blower.lixionary.com$endpoint" > "$release/$file"
done
python3 - "$release" "$revision" <<'PY'
import json,sys
from pathlib import Path
folder=Path(sys.argv[1]);revision=sys.argv[2]
for name in ['public-case-health.json','public-private-health.json']:
 if json.loads((folder/name).read_text()).get('ok') is not True:raise SystemExit('Public API health failed')
html=(folder/'public-home.html').read_text()
version=json.loads(Path('package.json').read_text())['version']
if f'data-app-revision="{revision}"' not in html or f'data-app-version="{version}"' not in html:raise SystemExit('Public frontend revision mismatch')
PY
# Only retired containers in this Compose project may be removed; preserve volumes.
python3 - <<'PY'
import json,subprocess
for service in ['privacy-worker','case-redis','private-redis','scanner','caddy']:
 name=f'whistle-suite-{service}-1'
 result=subprocess.run(['docker','inspect',name],capture_output=True,text=True)
 if result.returncode:continue
 labels=json.loads(result.stdout)[0].get('Config',{}).get('Labels',{})
 if labels.get('com.docker.compose.project')!='whistle-suite' or labels.get('com.docker.compose.service')!=service:
  raise SystemExit('Refusing to remove an unrelated container')
 subprocess.run(['docker','rm','-f',name],check=True,stdout=subprocess.DEVNULL)
PY
rm "$release/case-rate-limits.json" "$release/private-rate-limits.json"
cp "$release/compose.images.json" "$config/active-release.json"
python3 - "$release" "$revision" <<'PY'
import datetime,json,subprocess,sys
from pathlib import Path
folder=Path(sys.argv[1]);revision=sys.argv[2];images=json.loads((folder/'images.json').read_text())['images']
mapping={'case-api':'case','privacy-api':'private','converter':'private','web':'web'}
for service,kind in mapping.items():
 c=json.loads(subprocess.check_output(['docker','inspect',f'whistle-suite-{service}-1']))[0]
 if c['Image']!=images[kind] or not c['State']['Running'] or c['State'].get('Health',{}).get('Status','healthy')!='healthy':raise SystemExit('Running image mismatch')
record={'revision':revision,'images':images,'activated_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'snapshot':'snapshot.wbenc','local_backup_authenticated':True}
(folder/'deployment.json').write_text(json.dumps(record,indent=2)+'\n')
PY
printf '__WB_DEPLOY_OK__ %s\n' "$revision"
