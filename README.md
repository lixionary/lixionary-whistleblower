# Speak Up — company whistleblowing suite

An internal employee reporting portal with email OTP admission, anonymous submission, a private case mailbox, optional private case contacts, assigned investigators, independent closure approval, and company administration. English and Indonesian interfaces are included.

Reporter contacts, raw assistant conversations, and private report drafts live in a separate service, database, encryption keyring, and file vault. Reporters need no account or employee-directory verification. Analysts, managers, and system administrators have no contact-reveal endpoint. OTP proves control of an optional notification destination; it does not prove identity. Only reporter-reviewed reports, updates, and sanitized evidence enter the staff workspace.

Creating a report opens a private AI conversation directly, with a greeting and question in the selected English or Indonesian language. Policy acknowledgment and AI consent appear inline before the first message. The reporter receives a private continuation code when starting, then reviews an editable generated report before explicit submission. The report number and access/recovery secrets appear only after submission. An optional manual form works without AI consent or availability.

`main` contains the new suite, including ISO 37002:2021 (_Whistleblowing management systems — Guidelines_) alignment for broader stakeholder admission, anti-retaliation detriment assessment and reporting, procedural fairness and subject right-to-be-heard checks, root-cause and systemic action tracking, anonymous post-closure reporter surveys, and effectiveness analytics. `main-mvp` preserves the original MVP without the gap assessment. This implementation starts with **new suite databases and volumes**; it does not migrate or import MVP reports.

## Run locally

Requirements: Node 24+, pnpm 11.9, Docker Compose, and enough Docker memory for PostgreSQL and document conversion (allow at least 4 GB for local Docker).

```sh
pnpm install --frozen-lockfile
pnpm suite:setup
pnpm suite:dev
```

Open the portal at <http://localhost:9551> and the development mailbox at <http://localhost:6403>. The backend is available at `127.0.0.1:9550`; the case database at `127.0.0.1:9552` maps to PostgreSQL's container port 5432. These host ports bind only to localhost. The separate identity database has no published port. Production runs six containers: two databases, two APIs, the frontend, and an isolated converter. Private jobs run inside the privacy API; rate limits are durable PostgreSQL counters. Mailpit is development-only, and migration containers exit after provisioning.

Create the first administrator only on an empty staff table:

```sh
docker compose --env-file .suite-dev/suite.env run --rm --no-deps case-migrate \
  node dist/cli/bootstrap.js you@example.com
```

Enter a password of at least 15 characters through stdin. Log in at `/staff/login` and scan the enrollment QR code with your authenticator app, or use the manual setup key or app link. Enter the app's six-digit code to complete enrollment and save the single-use recovery codes. Invite two managers for the standard team and two different managers for the independent team, create those teams, and configure the company policy, categories, deadlines, and all six retention periods. Production submissions are unavailable until this setup is complete.

Staff can also use **Sign in with Google** when configured. Google login is limited to existing, active staff who have completed password setup; it cannot register staff or accept an invitation. MFA remains mandatory for both login methods. First Google login matches a verified Gmail or Google Workspace email to the staff email and saves Google's account ID only after local MFA succeeds. Subsequent logins use that account ID, even if the Google email changes. Password login and password reset remain available. See [Google credential setup](docs/runbook.md#google-staff-login).

The continuation code restores an unfinished private conversation and saved review edits across devices for **24 hours from creation**, without extension. It is a bearer credential: anyone holding it can read the draft. Save or download it before leaving. Only its hash is stored; browser state stays in memory. Expired unsubmitted drafts are deleted. After submission, continuation access ends and the reporter uses the case code, access secret, and recovery secret. Optional email can activate private notifications after verification; it does not provide case recovery.

The assistant helps gather facts without inventing missing information. **Review report** opens editable submission fields; **Use a form instead** preserves any saved draft. Chat content stays private. In the submitted case portal, **Review update** creates an editable follow-up; only updates explicitly reviewed and shared enter the investigator mailbox. Evidence is uploaded and reviewed after submission.

AI allows 30 message attempts and three draft-generation attempts per intake per UTC day, carrying usage into the case on submission. Failed provider attempts consume allowance; replayed requests do not. A failed message stays saved and can be retried without duplication. AI outages or disabled configuration do not prevent manual reporting or case access. Submitted conversation history follows configured transcript retention and legal holds. Consent withdrawal erases private conversation content unless held; previously shared case updates remain. Existing cases keep their current credentials and follow-up behavior.

Administrators manage staff accounts at `/staff/admin/users`: a table-only list links to separate creation and prefilled edit pages. Creation sends an invitation; editing supports name, role and active status with a read-only account email, plus password reset emails for active accounts. Reset links expire after 30 minutes and preserve MFA. The former `/staff/admin/staff` page redirects to Users. Workspace and Administration menu groups retain existing role permissions on desktop and mobile.

Development SMTP goes to Mailpit. SMS requires Twilio credentials. AI requires a MiniMax key **and** the company AI setting; it is off by default. Generated secrets are file based, ignored by Git, and never printed by setup.

Production email supports Zoho CPaaS HTTP delivery for both staff and reporters. Install the API key directly on the VPS in `.suite-config/secrets/zoho_api_key` (owner `lixsu`, mode 600), then run `pnpm email:configure:vps --check` and `pnpm email:configure:vps` here before deployment. These commands never copy or print the key. See the [Zoho setup and email checks](docs/runbook.md#zoho-transactional-email) for details. Local development continues to use Mailpit; phone verification remains unavailable until Twilio is configured.

## Workspace

| Path               | Responsibility                                                                         |
| ------------------ | -------------------------------------------------------------------------------------- |
| `apps/server`      | Case API, staff MFA, authorization, workflow, audit, retention, durable case jobs      |
| `apps/privacy`     | Private contacts and OTP, consented intake, sealed originals, delivery/conversion jobs |
| `apps/web`         | Next.js reporting, private mailbox, staff and administration screens                   |
| `packages/shared`  | Shared schemas, roles, states, company settings                                        |
| `packages/runtime` | Encryption, capabilities, hashing, rate limits, assistant adapter                      |
| `deploy`           | Container entrypoint, nginx proxy policy                                               |
| `scripts`          | Secret setup, synthetic tests, key rotation, offsite backup and isolated restore       |

## Administrator development tracker

Administrators can open **Administration → Development Tracker** at `/staff/admin/development-tracker` to report software errors, request features, and view the LWB board. Reports open Jira’s own form in a popup; an administrator does not need a Jira account. Jira records the submitting administrator’s staff ID and name under the application’s service account. The app sends no case data or employee directory information automatically. Exclude confidential information from manually written reports and attachments.

The tracker is disabled until configured. See [Jira configuration](docs/runbook.md#jira-development-tracker) for service-account grants, credentials, and allowed origins.

## Versioning

The root `package.json` is the release-version source of truth. All workspace packages share version `1.0.0`. The footer on reporter and staff screens shows the version; its tooltip includes the build revision. Build metadata is embedded in the frontend assets and changes only after rebuilding.

```sh
pnpm version:check          # Validate every workspace package
pnpm version:bump patch     # 0.4.0 → 0.4.1
pnpm version:bump minor     # Advance the minor version and reset patch
pnpm version:bump major     # Advance the major version and reset minor/patch
pnpm version:bump 1.2.3     # Set an explicit, newer release version
pnpm version:sync           # Repair package drift using the root version
```

Use patch versions for fixes and minor versions for features; while the project is below 1.0, advance the minor version for breaking changes. Bump the version with the intended changes, validate, then commit all updated manifests together. The commands do not create commits or Git tags. Workspace builds, type checks and CI validate version alignment.

Local builds display the version with a `Local build` tooltip. To identify a particular committed build, set `APP_REVISION` to its full 40-character Git SHA when running `pnpm build` or `pnpm suite:dev`; direct Docker builds accept `--build-arg APP_REVISION=<full-sha>`. CI supplies its revision automatically, and the VPS deployment script embeds the exact archived revision.

## Verify

```sh
node scripts/test-db.mjs
docker run -d --name whistle-suite-test-db --env-file .suite-dev/postgres.env \
  -p 127.0.0.1:6412:5432 postgres:17-alpine
pnpm typecheck
pnpm test
pnpm build
```

Integration tests recreate only `whistle_suite_test` and `whistle_privacy_test` on this test database. Run one full integration test process at a time.

For browser and real evidence-pipeline checks, start the development suite first:

```sh
node scripts/seed-browser.mjs
pnpm --filter @whistle/web exec playwright install chromium
pnpm test:browser
node scripts/evidence-smoke.mjs
```

Before each complete browser run, reseed the synthetic accounts: the real staff tests enroll MFA. The development seed also resets admission send budgets only for its three synthetic reporter mailboxes and submission budgets only for the current development frontend addresses, after checking that all staff are synthetic accounts. Direct reporter reruns without reseeding still respect the admission resend/hour/day limits.

The browser seed refuses non-test staff accounts and production configuration. These scripts create synthetic reports and Mailpit messages. Do not run them against real company data.

## Deploy from this machine

```sh
pnpm deploy:vps --check   # Inspect the existing VPS without restarting services
pnpm deploy:vps --push    # Validate committed main, push it, build and deploy
```

Commit the intended changes on `main` first. If already pushed, use `pnpm deploy:vps`. The script builds `linux/amd64` images locally, transfers them over SSH to `lixsu@lixionary.com:/app/lixionary-whistleblower`, copies and authenticates an encrypted pre-deployment snapshot here, then migrates and starts the exact image IDs. Existing secrets, port configuration and TLS certificates are preserved. Protected backup files live in `.suite-dev/deployments/` and must be kept together for recovery. See the runbook for prerequisites and failure recovery.

See [implementation and validation](docs/implementation.md), [deployment and operations](docs/runbook.md), and the [historical MVP gap assessment](docs/gaps.md).
