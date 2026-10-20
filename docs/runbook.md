# Deployment and operations

## Production installation

Use a dedicated Docker VPS with Node 24+, Docker Compose, native restic, SSH, encrypted disks, and at least 4 GB available RAM for the application and document conversion; monitor actual usage on shared hosts. Open only ports 80/443 publicly; keep PostgreSQL, Garage, converter and service internals private. Do not enable request-body, cookie, query-string or destination logging in a CDN, host proxy, APM or provider integration.

The backend listens on 9550 and the frontend on 9551. Compose publishes these ports, and the case database on 9552, exclusively on `127.0.0.1`; PostgreSQL continues to listen on 5432 inside its isolated network. The private identity database has no host mapping. System nginx terminates public HTTPS on 443; Certbot manages certificate renewal. Use an SSH tunnel when accessing the backend or database remotely. Restore drills automatically include `deploy/compose.restore.yml` to remove published ports; keep that override included when operating a restored project. This requires Docker Compose 2.24.4 or later.

1. Check out the intended `main` revision; keep `main-mvp` unchanged. Record `git rev-parse HEAD`. This is a fresh-suite installation, not an MVP migration.
2. Generate protected file secrets:

   ```sh
   SUITE_CONFIG_DIR=.suite-config SUITE_DOMAIN=reports.example.com \
     node scripts/setup-suite.mjs --production
   ```

3. Edit `.suite-config/suite.env` for the hostname, HTTPS URL, staff/private SMTP host, port, user and sender, and Twilio sender. Write SMTP passwords, Twilio SID/token and optional MiniMax key into their generated secret files. Keep files mode 600, directories mode 700, and the host key store access restricted. Setup preserves existing files. Do not place secrets in command-line arguments, shell history, Git or support logs. Mailpit is for development only; production needs a configured email transport; see the Zoho section for HTTP delivery.
4. Review company/provider processing and retention terms before enabling SMS or AI. Keep AI disabled until approved. The assistant requires both a configured key and the company setting. Changing environment values needs a container recreation.
5. Build and launch:

   ```sh
   export SUITE_CONFIG_DIR="$PWD/.suite-config"
   bash scripts/setup-storage.sh --env-file .suite-config/suite.env
   docker compose --env-file .suite-config/suite.env up --build -d
   ```

   Install and validate native nginx and Certbot as described below before exposing this installation. nginx terminates TLS, suppresses access logs, blocks internal endpoints, and supplies browser security headers. Runtime services trust one proxy hop; do not add another proxy/CDN without revalidating forwarded-IP handling and all upstream logging.

6. Bootstrap the first administrator, reading the password from stdin:

   ```sh
   docker compose --env-file .suite-config/suite.env run --rm --no-deps case-migrate \
     node dist/cli/bootstrap.js admin@example.com
   ```

   Bootstrap refuses a non-empty staff table. Enroll MFA and save recovery codes. Use **Administration → Users → Create user** (`/staff/admin/users/new`) to invite and onboard four managers: two standard, two independent. Add analysts to their teams. Edit account name, role and active status from the Users table; account emails are read-only. Active accounts have a separate **Send password reset email** action on their edit page. The recipient chooses the new password through a one-time 30-minute link; MFA remains required. Configure both independent teams, bilingual policy/notice, categories, acknowledgment/follow-up deadlines and all six retention periods. Production intake rejects submissions while company setup is incomplete. Reporters need no employee-directory lookup or pre-submission email verification. Optional email verification after submission activates notifications only.

7. Create synthetic anonymous reports through chat and the manual form. Check pre-message evidence upload, continuation/resume, review and approval, post-submission publication, and optional case contact delivery, including expired/wrong/reused codes, provider outage/retry, notification opt-out, and generic message content. Use a synthetic conversation for optional AI verification. Confirm nobody can obtain contacts, masked hints, raw transcripts or original attachments through staff/admin routes.
8. Configure offsite backup, monitoring and scheduled restore drills before opening the public channel.

Build/test/scan exact release images in CI, record their digests with the revision, and deploy those digests in a production override. The supplied `:local` image tags are a local-build default, not an immutable release identity. Do not automatically overwrite production from every branch push. Before upgrading, take a verified offsite backup; apply migrations once through the separate migrate services, then recreate runtime services. Migrations are forward-only; roll back a release by restoring into a separate project, not by running older binaries against an incompatible schema.

## VPS with system nginx

The configured target is `lixsu@lixionary.com`, checkout `/app/lixionary-whistleblower`, public URL `https://whistle-blower.lixionary.com`. Use native nginx and Certbot on this host. Compose contains no public TLS proxy or production profile. The application environment must still set `SUITE_NODE_ENV=production` and the public HTTPS URL.

```sh
cd /app/lixionary-whistleblower
git checkout main
git pull --ff-only origin main
SUITE_CONFIG_DIR=.suite-config SUITE_DOMAIN=whistle-blower.lixionary.com \
  node scripts/setup-suite.mjs --production
COMPOSE_PARALLEL_LIMIT=1 docker compose -f docker-compose.yml -f deploy/compose.vps.yml \
  --env-file .suite-config/suite.env build
docker compose -f docker-compose.yml -f deploy/compose.vps.yml \
  --env-file .suite-config/suite.env up -d --no-build --wait --wait-timeout 600
```

When Node is unavailable on the host, run setup using `docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:$PWD" -w "$PWD" -e SUITE_CONFIG_DIR=.suite-config -e SUITE_DOMAIN=whistle-blower.lixionary.com node:24-slim node scripts/setup-suite.mjs --production`.

For the first certificate, install `deploy/nginx/whistle-blower.http.conf` as `/etc/nginx/sites-available/whistle-blower.lixionary.com.conf`, enable the matching symlink in `sites-enabled`, create `/var/lib/letsencrypt/.well-known/acme-challenge`, then run `sudo nginx -t` and reload nginx. Verify the challenge URL from outside the VPS. Issue the certificate using the existing Certbot account:

```sh
sudo certbot certonly --webroot -w /var/lib/letsencrypt \
  --cert-name whistle-blower.lixionary.com -d whistle-blower.lixionary.com \
  --non-interactive --account '<existing-production-account-id>'
sudo install -m 644 deploy/nginx/whistle-blower.lixionary.com.conf \
  /etc/nginx/sites-available/whistle-blower.lixionary.com.conf
sudo nginx -t && sudo systemctl reload nginx
sudo install -m 755 deploy/nginx/renew-whistle-blower.sh \
  /etc/letsencrypt/renewal-hooks/deploy/whistle-blower-nginx
sudo certbot renew --cert-name whistle-blower.lixionary.com --dry-run --no-random-sleep-on-renew
```

The configuration forwards `/api/` directly to backend 9550 and other requests to frontend 9551, including the private API rewrite. nginx overwrites incoming forwarding headers; Next preserves that single client address for the private service. It disables access logging, buffering and caching, blocks internal endpoints, and sets security headers. Keep Certbot's renewal timer enabled and a deploy hook that tests/reloads nginx after renewal. Back up an existing site configuration before replacing it. The shared VPS needs capacity monitoring, especially for concurrent document conversion.

Fresh production databases contain no test accounts, employee directory, or company setup. Bootstrap the administrator, enroll MFA, configure the teams/policy/retention, and supply real delivery and offsite-backup credentials before operational use.

Keep `deploy/compose.vps.yml` included for this host. It assigns seven `/28` networks within `10.245.95.0/24`, avoiding the exhausted default Docker address pool without modifying other projects. Recheck host routes and Docker subnets before reusing the override elsewhere. Do not prune unrelated networks to make space.

nginx proxy directives follow the [official proxy documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html); certificate issuance and renewal use [Certbot's webroot workflow](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot).

## Google staff login

Google is an additional staff login mechanism. It creates no staff accounts, activates no invitations, and grants no roles. Existing permissions and mandatory local MFA apply equally to password and Google login. Staff must complete password setup before their first Google login. The schema upgrade recognizes completed setup from existing successful onboarding/authentication audit events; accounts without this evidence can use their staff password or finish password setup first.

1. Create a Google OAuth client with application type **Web application** and configure its consent screen. Request only `openid email`; no Drive, Gmail, offline access, or profile enrichment is used. Choose a consent-screen audience that permits your intended staff and add test users while the Google project is in testing.
2. Register the exact authorized redirect URI for each environment:
   - Production: `https://whistle-blower.lixionary.com/api/staff/google/callback`
   - Local development: `http://localhost:9551/api/staff/google/callback`
   - Other hosts: `<PUBLIC_WEB_URL origin>/api/staff/google/callback`
3. Run `scripts/setup-suite.mjs` for the existing configuration directory to create the new empty `secrets/staff_google_client_secret` file. Setup preserves existing values. On the Node-free VPS, use the existing Node-container setup command above. This placeholder is required by Compose even when Google is disabled.
4. Set `STAFF_GOOGLE_CLIENT_ID` in that directory's `suite.env`. Enter the client secret into `secrets/staff_google_client_secret` using a secure editor; keep the file mode 600 and directory mode 700. Keep credentials out of chat, shell history, logs, and commits. Compose mounts the secret only into `case-api`.
5. Apply the case database migration using the normal release procedure and recreate the staff API. The button is controlled by server configuration at runtime, so credential changes do not require rebuilding the frontend. Direct API development also supports `STAFF_GOOGLE_CLIENT_SECRET_FILE`; the inline environment variable is server-only. Both credentials absent means disabled; configuring only one prevents startup.

On the first login, a verified Gmail or Google Workspace email (with the validated `hd` claim) must match the existing staff email. Other third-party Google-account email addresses are ineligible for automatic association. The stable Google account ID is saved only when local MFA succeeds. Later logins use that ID; changing Google's email does not change staff identity, staff email, or permissions. A different Google account cannot replace a binding by presenting the same email. There is no self-service linking, unlinking, or replacement UI in this release.

Check Google login with an enrolled staff member, an unenrolled staff member, and an unregistered account. Confirm that protected staff APIs reject the Google pre-MFA session, that unenrolled staff must save recovery codes, and that password login still works. Cancellation, expired transactions, and provider failures return to the login form. Disabling Google requires clearing both credentials and recreating the staff API; staff passwords and MFA remain usable.

The flow follows [Google's OpenID Connect server guidance](https://developers.google.com/identity/openid-connect/openid-connect) and [email ownership guidance](https://developers.google.com/identity/sign-in/web/backend-auth). A real-provider smoke test requires the configured OAuth client and a human completing Google sign-in and local MFA. Synthetic tests validate token claims/signatures, the database upgrade, account eligibility, sessions, and browser redirects independently of live credentials.

## Deploying from the development machine

Use `pnpm deploy:vps --check` for a preflight that does not update the checkout, copy images or restart services. To release a clean, committed `main`, run `pnpm deploy:vps --push`; omit `--push` when `origin/main` already matches. The deployment refuses uncommitted changes, remote checkout changes, diverging history and revisions that differ from `origin/main`.

The development machine needs Node 24+, pnpm, Python 3 with `cryptography` for snapshot tests, Docker with Buildx and Linux AMD64 emulation, Git, SSH/SCP, gzip and tar. Start the isolated integration-test database described in the README before deploying. SSH uses the existing key, strict known-host verification and batch authentication. VPS prerequisites are the completed initial installation above, sudo access for the nginx site/reload, Python `cryptography`, Docker Compose, `flock`, curl and at least 8 GiB free disk. The VPS does not need Node, pnpm or a registry login.

The script validates types, tests, snapshot authentication, production builds and dependencies locally. It builds three AMD64 images sequentially from `git archive` of the exact revision, so ignored local files cannot enter the build context. Images are transferred over SSH, checked for their architecture/revision labels and pinned by image ID. Production configuration/keyrings are not regenerated or copied from development.

The frontend compiler runs on the builder's native architecture. Its runtime dependencies are installed separately for the destination architecture before producing the AMD64 image, avoiding Next compiler crashes under ARM-to-x86 emulation while retaining the correct native image libraries. This uses Docker's [build and target platform separation](https://docs.docker.com/build/building/multi-platform/#cross-compilation).

A VPS lock covers snapshotting, migration and activation. The script stops application writers briefly, snapshots both PostgreSQL databases, the sealed filesystem vault, verified exports of S3 sealed objects with a checksum manifest, production keys/configuration, the prior image IDs and the current audit checkpoint, then encrypts the tar stream with AES-256-GCM. It copies the encrypted archive and separate key into `.suite-dev/deployments/<release-id>/` and verifies the authentication tag locally before acknowledging that migrations may proceed. Raw snapshot staging files are removed on the VPS. The same protected encrypted backup remains in `.suite-config/releases/<release-id>/`, alongside deployment logs and the image manifest. Protect both machines and keep the archive and key together. This release safety copy does not replace scheduled offsite restic backups, legal-hold retention or restore drills.

The portal is unavailable while the snapshot is created/copied and migrations run; allow a maintenance window based on data size and connection speed. Snapshots are limited to 60 GiB of plaintext per release. Allow disk space for the uploaded images, plaintext staging and encrypted snapshot in addition to the 8 GiB preflight minimum.

The runtime consists of `web`, `case-api`, `privacy-api`, `converter`, `case-db`, and `private-db`. Migrate services are temporary; Mailpit is development-only. The script updates only application/migration images and leaves existing databases and retained networks/volumes unchanged. The one-time simplification transition permits only removal of ClamAV, both Redis services, the old privacy worker and unused Caddy configuration. Other infrastructure upgrades require a separate procedure.

Before that transition, the script stops all old writers, exports live Redis counters with absolute expiry timestamps, and includes them in the authenticated encrypted snapshot. Each database migration imports only unexpired counters before APIs start. Subsequent releases preserve counters directly in database backups. The script removes only retired containers bearing this project's matching Compose labels after readiness/audit checks; legacy volumes remain available for recovery. Protected temporary counter files are deleted after successful import/activation. Native nginx receives the checked-in site and renewal hook, then reloads after configuration validation. Existing certificates are reused. The script checks the running image IDs, audit chain, public HTTPS and both APIs. If migrations might have started, failure leaves recovery to the operator rather than restarting older binaries against a changed schema.

After a successful scripted release, include its active image override for manual operations:

```sh
docker compose -f docker-compose.yml -f deploy/compose.vps.yml \
  -f .suite-config/active-release.json --env-file .suite-config/suite.env ps
```

For recovery, decrypt into a new protected path; the helper publishes a tar only after authenticating it:

```sh
umask 077
python3 scripts/deployment-backup.py decrypt \
  .suite-dev/deployments/<release-id>/snapshot.wbenc \
  .suite-dev/deployments/<release-id>/recovery.key /protected/recovery.tar
```

Use the tar's dumps, sealed vault, sealed S3 object export/manifest, configuration and prior revision to restore into a new isolated project following the restore section. Apply the newest verified deletion/hold manifest and revoke old sessions before public access. Do not replace a live database or automatically rewind migrations. Plaintext recovery tars contain private keys/configuration and must be removed securely after recovery. Release snapshots require the same retention and legal-hold review as other backups; the script does not delete snapshots automatically.

## Zoho transactional email

Both services support `smtp` (the backward-compatible default) and `zoho`. Set `STAFF_EMAIL_PROVIDER=zoho`, `PRIVACY_EMAIL_PROVIDER=zoho`, `STAFF_EMAIL_FROM=noreply@lixionary.com` and `PRIVACY_EMAIL_FROM=noreply@lixionary.com` for this VPS. SMTP settings remain available for other installations and local Mailpit development. Zoho sends existing plain-text email content through `https://cpaas.zoho.com/v1.1/email`; the request format and acceptance code follow [Zoho's email API](https://www.zoho.com/cpaas/help/api/email-sending.html). Open/click tracking is explicitly disabled. The selected provider must be configured before contact challenges are accepted; Operations availability indicates configuration, not inbox delivery.

Verify the sending domain and account approval in Zoho. Install the raw key directly in a VPS terminal, without pasting it into chat, Git or command-line arguments:

```bash
ssh lixsu@lixionary.com
umask 077
read -r -s -p 'Zoho API key: ' zoho_key
printf '%s' "$zoho_key" > /app/lixionary-whistleblower/.suite-config/secrets/zoho_api_key
unset zoho_key
chmod 600 /app/lixionary-whistleblower/.suite-config/secrets/zoho_api_key
```

The file must be owned by `lixsu`. Setup creates an empty placeholder for new installations and preserves existing values. Compose mounts this read-only secret only into the case API and private API; the converter, web, databases and migrate services do not receive it. Reporter addresses remain in the private service. Staff/admin interfaces expose no key or reporter address.

From the development machine:

```sh
pnpm email:configure:vps --check
pnpm email:configure:vps
pnpm deploy:vps --push
```

The configuration command verifies the protected key and production URL, saves an owner-only copy of the previous environment if changes are needed, and atomically updates only the four provider/sender settings. It does not restart containers. Commit the integration and deployment tooling on `main` before deploying. Provider failures leave existing jobs eligible for retry; expired OTPs are discarded. SMS remains unavailable until Twilio SID, token and sender are supplied.

After deployment, send synthetic checks from both production services in a VPS terminal:

```sh
cd /app/lixionary-whistleblower
export SUITE_CONFIG_DIR="$PWD/.suite-config"
docker compose -f docker-compose.yml -f deploy/compose.vps.yml \
  -f .suite-config/active-release.json --env-file .suite-config/suite.env \
  run -T --rm --no-deps case-api node dist/cli/email-test.js felix.soewito@lixionary.com
docker compose -f docker-compose.yml -f deploy/compose.vps.yml \
  -f .suite-config/active-release.json --env-file .suite-config/suite.env \
  run -T --rm --no-deps privacy-api node dist/cli/email-test.js felix.soewito@lixionary.com
```

The CLI sends no actual OTP, account token or report data, and only reports provider acceptance or a generic failure. Confirm receipt in the test inbox separately. These checks do not establish that every staff/reporter workflow has been exercised on production. Do not test using real reporter destinations or resend historical notifications.

## Access and secrets

`case-api` receives the case keyring and case database credential, but no private vault key, database credential or volume. `privacy-api` receives the private keyring/database/vault, but no case keyring or case database access. The converter receives neither database nor vault secrets, runs as UID 1000, and has only the internal conversion network and a disposable filesystem. Private operations require an Ed25519 capability and live reporter-session introspection; callbacks require time-bound HMAC signatures.

Migrate services use database owners. Runtime roles are `wb_case` and `wb_private`; they do not own schemas. The case role cannot rewrite audit events or anchors. A small root entrypoint has `DAC_READ_SEARCH` to read owner-only Linux secret binds, then starts the actual application process as UID/GID 1000 without those capabilities. The entrypoint has no HTTP surface. Web and converter containers do not receive this capability. Restrict operator access to Docker and key files; application-role isolation does not conceal data from an operator controlling the host and both key stores.

Disable departing staff in administration and remove team memberships. This revokes their sessions/tokens and case access. Review membership and MFA enrollment regularly. Preserve at least one active administrator and two managers in each configured team. A staff member who loses all MFA recovery factors needs an approved operator identity-verification procedure; there is no application bypass endpoint.

## Monitoring and delivery incidents

Poll public `/api/health` and `/privacy/health` for availability. Check Compose health, restarts, disk/inodes, PostgreSQL errors, rate-limit table cleanup, converter timeouts, backup age and restic integrity checks. Monitor administrator **Operations** for pending jobs, maximum attempts, private-service availability, evidence quarantine states and incomplete privacy deletions. Health alone does not prove delivery or fresh backups.

Jobs use durable database queues, leases, and bounded exponential backoff. A provider timeout may lead to duplicate generic delivery; it must not duplicate a message in the platform. OTP retries stop after expiry. Correct the provider/network configuration and let jobs resume. Never paste job payloads or destination values into tickets. Escalate jobs with increasing attempts or stale evidence/leases; check provider status and non-sensitive error codes. Rate limits use atomic, fixed-window PostgreSQL counters in each domain database and survive API restarts. Database failures fail abuse checks closed. Private delivery/conversion/retention jobs run inside the privacy API with durable leases and retry behavior; its shutdown drains active work before closing the database connection.

A suspected disclosure requires restricting public access, preserving relevant audit checkpoints/evidence under legal hold, revoking affected sessions and tokens, investigating host/provider logs safely, and rotating compromised keys. Obtain approved company incident contacts and notification rules before launch. Don't reveal reporter contact data to investigate a routine delivery failure.

## Retention and legal holds

Production settings require positive retention days for cases, contacts, transcripts, evidence, audit and backups; defaults leave deletion disabled. Cases become eligible after closure. Private records have their own creation-based periods. Jobs/tokens/sessions have short housekeeping expiry. Legal holds pause private and case deletion. Cross-service leases serialize destructive contact/evidence operations with a newly imposed hold; an active lease makes a conflicting hold request return a retryable conflict.

Case deletion creates a durable deletion manifest before removing the case and queues private erasure; operations expose incomplete erasures. Original and derivative files remain encrypted until deletion. Audit pruning is owner-only, bounded to an eligible prefix before any held event, and permitted only after a matching offsite checkpoint. Policy history and minimal deletion identifiers remain for accountability/restoration. Storage media secure erasure and backup lifetimes remain host/provider responsibilities.

## Evidence storage and migration

Compose defaults new evidence to the pinned Garage service on the private `evidence-storage` network. No S3, RPC, or admin port is published; the admin listener is loopback-only inside Garage. `pnpm storage:setup` (or `scripts/setup-storage.sh` with production Compose flags) creates the private `whistle-evidence` bucket and imports an application key with read/write permissions only. Setup preserves existing credentials. The privacy API receives only the application key; staff, web, case API, and converter receive no storage credentials. Garage's owner-only configuration includes its RPC/admin secrets and requires `DAC_READ_SEARCH` to read the Linux secret bind.

Both originals and derivatives are application-encrypted before the filesystem or S3 adapter writes them. The database records each file's backend; no public URLs or browser-direct uploads are used. Direct-service deployments can set `PRIVACY_EVIDENCE_BACKEND=filesystem` or `s3`, with `PRIVACY_S3_ENDPOINT`, `PRIVACY_S3_REGION`, `PRIVACY_S3_BUCKET` and protected `PRIVACY_S3_ACCESS_KEY_FILE` / `PRIVACY_S3_SECRET_KEY_FILE`. An unavailable S3 backend returns a retryable storage error rather than switching storage silently. Text reporting remains available.

This initial Garage topology has one node and one replica. It depends on host availability and verified offsite backups, and does not provide high availability. Monitor both Garage volumes, storage failures, and queued `evidence_deletions`. Workers retry deletion of originals and derivatives after expiry, discard, retention, or case erasure, including retained legacy copies. Unsubmitted drafts expire 24 hours after creation; active conversion leases delay physical cleanup safely.

Apply the privacy migration before starting updated services. To move legacy files, first take a verified backup, initialize Garage, and stop web/APIs/workers to quiesce writers. Use the same Compose project/environment/production overrides as the active release for each command below:

```sh
# Include the active release and VPS override when operating production.
docker compose --env-file .suite-dev/suite.env stop web case-api privacy-api
docker compose --env-file .suite-dev/suite.env run -T --rm --no-deps \
  --entrypoint node privacy-api dist/cli/evidence-storage.js migrate
```

Migration copies sealed originals and any derivative, checks plaintext hashes against the database and copied sealed checksums, then changes the recorded backend. It is idempotent and leaves filesystem copies intact. A failed file remains on its prior backend. Keep writers stopped until migration finishes. Restart the suite, take and verify a new backup and isolated restore, and then quiesce writers again before optional cleanup:

```sh
docker compose --env-file .suite-dev/suite.env run -T --rm --no-deps \
  --entrypoint node privacy-api dist/cli/evidence-storage.js purge-filesystem
```

Purge verifies the authoritative S3 data against database hashes before removing retained local copies. Keep the old keyring for old backups. The normal rekey command handles both recorded backends; stale filesystem migration copies are removed by verified purge or eventual deletion. Never delete Garage volumes or change the backend column manually as a migration shortcut.

## Offsite encrypted backup

Provision a dedicated SFTP account/directory on a separate host, pin its host key in SSH configuration, restrict the account and SSH key, and configure independent oversight of the backup/checkpoint store. Keep the recovery password and a protected key/config backup outside the application host. A backup containing data without its original keyrings is unusable.

```sh
export SUITE_CONFIG_DIR="$PWD/.suite-config"
export SUITE_ENV_FILE="$SUITE_CONFIG_DIR/suite.env"
export RESTIC_REPOSITORY='sftp:backup@backup.example.com:/whistle-suite'
export RESTIC_PASSWORD_FILE="$SUITE_CONFIG_DIR/secrets/restic_password"
restic init  # first installation only
bash scripts/backup-suite.sh
```

Schedule the script with the same environment and working directory, prevent overlapping executions, and alert on failure and backup age. It stops web/APIs/workers briefly, verifies and checkpoints the audit chain, dumps both databases, archives the encrypted filesystem vault, exports the sealed S3 objects with a checksum manifest, and archives protected configuration, restarts services, encrypts the snapshot offsite, runs `restic check`, writes the latest verified checkpoint, applies routine backup retention, and then prunes eligible audit prefixes. Backups are consistent application snapshots, not zero-downtime physical database backups.

Snapshots containing held cases get a `held` tag and are excluded from automated routine pruning. Release those snapshots only after an authorized hold review confirms no contained case remains held and the backup retention obligation is met. Never blindly prune all snapshots by age. Restic passwords/SSH private keys and offsite permissions must not be exposed to application administrators.

## Restore drill and recovery

Restore into a **new** isolated Compose project and configuration directory, leaving the source suite untouched. Use the newest independently verified checkpoint to apply later deletions/holds to an older snapshot. Fail closed if that checkpoint is unavailable. The latest local checkpoint is convenient but must not be the only trusted copy.

```sh
export RESTORE_SNAPSHOT='<verified-snapshot-id>'
export LATEST_MANIFEST='/protected/newest-verified-checkpoint.json'
export RESTORE_CONFIG_DIR="$PWD/.suite-config-restore"
export RESTORE_PROJECT=whistle-suite-restore-drill
bash scripts/restore-suite.sh
```

The script verifies the encrypted snapshot, restores both databases and the sealed filesystem vault into new volumes, initializes private Garage, verifies and imports any sealed S3 object export, reapplies runtime permissions/migrations, replays case deletions and holds, revokes all sessions and staff reset/invitation tokens, discards old OTP/notification deliveries, and verifies the audit chain. Older filesystem-only snapshots remain supported: missing storage configuration is generated, old files keep their filesystem backend, and Garage is initialized for future uploads. It leaves APIs/workers/web stopped. It reports a protected staging directory; after verification, securely remove that directory using the host's approved procedure. Add any alternate production config directory to Git/Docker ignore rules before local builds.

Before starting restored services, set a separate test hostname, closed ingress and test-only delivery transports. Start only APIs and workers on restricted ingress, drain pending `privacy_delete` jobs, confirm deletion manifests are complete, verify readable authorized cases and sanitized evidence, verify held originals remain sealed, and ensure old cookies/PIN rotations behave as expected. Open the web/proxy only after operator review. Restore checks do not permit sending historical notifications to real reporters. Record backup/restore times, revision, snapshot ID, checkpoint tip, and non-sensitive verification evidence. Repeat the drill regularly and after migration/key changes.

## Encryption key rotation

Take a verified backup and stop APIs/workers/web. Keep old keys for historical backups. Generate a new active key in each keyring without deleting earlier keys:

```sh
node scripts/rotate-keyring.mjs .suite-config/secrets/case_keyring k2
node scripts/rotate-keyring.mjs .suite-config/secrets/vault_keyring k2
```

Run the case rekey CLI using the migrate service with the new keyring mounted as a protected file:

```sh
docker compose --env-file .suite-config/suite.env run --rm --no-deps \
  -v "$PWD/.suite-config/secrets/case_keyring:/run/rekey:ro" \
  -e CASE_KEYRING_FILE=/run/rekey case-migrate node dist/cli/rekey.js
```

Run `node dist/rekey.js` through the stopped privacy-api service's `compose run --rm --no-deps` configuration; it already mounts the private database, vault and keyring. Recreate the original runtime containers so they load the new keyring, verify cases, MFA, contacts and evidence, and take another verified backup. A partially failed file rekey is retryable because the keyring retains both keys. Do not remove an old key until no retained data or backup references it. Rotate capability signing keys by replacing both halves together and recreating both APIs; existing minute-long capabilities fail closed. Shared callback keys need a coordinated service restart.

## Launch acceptance record

Record the real target's TLS/DNS/firewall/log review, image digests/security scan, provider delivery/outage checks, team/MFA configuration, approved retention/provider policies, encrypted disk/key access, backup schedule/age, restored DB/file/key readability, deletion/hold replay, and incident ownership. Local tests supply implementation evidence; this record supplies production evidence. The suite does not claim legal certification or guaranteed anonymity from identifying narrative or privileged infrastructure operators.

## Evidence without antivirus

ClamAV is no longer installed and new uploads have no malware-signature scan. Images, PDF, Word, Excel and PowerPoint retain magic-byte validation, size/page limits, isolated conversion, metadata removal, permanent redaction and reporter approval. The converter has no database credentials or vault keys. Originals remain sealed; staff only receive approved sanitized derivatives. Pending evidence is displayed as Processing; successful work emits `evidence_processed`. Historical `evidence_scanned` events and scan metadata remain intact, but new uploads do not populate antivirus fields.

## Jira development tracker

This optional integration uses the existing Jira service at `https://jira.lixionary.com` and project **LWB**. It adds no services or database migrations. Only active administrators with completed MFA can view the board or start reports. The board contains all LWB tickets; it is read-only here.

1. In Jira, create a dedicated non-human service account, such as **Lixionary Whistleblower**, with **Ticket creation** and **Discussion** grants on LWB. The LWB project grant also permits reading its board. Do not give it implementation or release capabilities.
2. On its **Integration** tab, set source `whistleblower`, enable **Allow the report popup**, and allow `https://whistle-blower.lixionary.com`. Enable **Review tickets on create** if desired; this does not approve implementation.
3. Issue a client ID and secret. Keep the secret out of chat, Git, command arguments, and logs. Install it in the existing protected configuration directory as `secrets/jira_client_secret`, mode `600`, owned by the application configuration owner. The case API alone receives this secret.
4. In `suite.env`, set `JIRA_URL=https://jira.lixionary.com`, `JIRA_PROJECT_KEY=LWB`, and `JIRA_CLIENT_ID` to the issued ID. The return origin is derived from `PUBLIC_WEB_URL`; no browser input controls it. Compose sets `JIRA_CLIENT_SECRET_FILE` to `/run/secrets/jira_client_secret`. Direct API development may supply a protected secret-file path instead.
5. Before the first deployment containing this feature, rerun the updated setup script against the existing configuration directory to create the empty secret placeholder. Setup preserves existing secrets and `suite.env`; append the Jira settings manually for an existing installation. The placeholder is required by Compose even with Jira disabled. Do not generate a new production configuration directory.
6. Restart/redeploy the case API with the intended release after configuration. Empty `JIRA_URL` disables the integration; enabled settings require a valid HTTPS origin, client ID, a secret of at least 32 characters, and project LWB. Development permits HTTP only for loopback origins. A development frontend origin must also be allowed by Jira; production Jira may reject HTTP localhost origins by policy.

Allow popups in the browser. Both applications and their proxies must preserve the opener relationship: do not add `Cross-Origin-Opener-Policy: same-origin` (none is needed with the current configuration). The browser only calls this app’s API; OAuth credentials and bearer tokens remain on the case API. Single-use launch URLs are short-lived and must never be logged or stored. Jira hosts attachments and assistant drafting in its popup.

Verification after configuration: sign in as an administrator, load the five-column board, submit a synthetic error and feature request, and confirm LWB attribution and board refresh. Use synthetic content only. A working board alone does not verify ticket submission. Check non-admin access is denied. Disable quickly by clearing `JIRA_URL` and restarting the case API, or disable popup intake in the Jira service-account settings (this stops reporting but does not revoke board access).

## Case assistant follow-up (0.7.0)

Apply both case and privacy migrations before starting updated services. The existing MiniMax key and company AI toggle continue to control availability. Registered-email admission now ends with form submission; case credentials authorize subsequent AI work. Initial consent is optional in the form and can be granted or renewed on the case page. Review company privacy notices to cover AI processing of the submitted report, not just the conversation.

Validate with synthetic reports: check that no AI work occurs before the credential receipt is acknowledged; confirm form details appear in the assistant context; verify sign-out/login and credential recovery restore history. Check that staff cannot read private chat and receive only reviewed updates. Verify provider failure preserves the reporter message and offers retry. Limits reset at UTC midnight: 30 message attempts (including initialization) and three update generations per case per day. Histories follow configured transcript retention; legal holds prevent erasure. Pre-submission AI routes return `form_first_required` for eligible older clients; direct them to reload and use the form. No production AI setting is enabled automatically by this release.
