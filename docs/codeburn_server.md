# Team usage collection + central report viewer

## Context
You want to collect token/cost usage from every staff machine into one place and give managers a report viewer, so the team can see where tokens go and improve usage.

Most of the client side already exists. `codeburn sync` (src/sync/) pushes per-call usage as OTLP/HTTP JSON spans. It has a sent-ledger, retry/429 handling, consent receipts, OS credential storage and privacy sanitizers. What it lacks:
- **No server.** The only backend is an external AWS/Cognito test fixture.
- **OIDC only.** Every deployment needs an identity provider.
- **No detail-level control** on either the client or the server.
- **Auto-push scheduling is macOS-only** (`schedule-installer.ts`).

Decisions you made:
- self-hosted server
- named people, enrolled with per-person tokens
- automatic push
- a client setting for whether session-level detail is sent, plus a server setting for whether it is accepted and stored

The plan is to build the server to the existing sync contract and extend the client in place, not invent a second protocol.

## Design

### 1. Self-hosted collector: `codeburn team serve` (new `src/team-server/`)
- **Runtime:** a single Node process using `node:http` and writable `node:sqlite`. The lazy-load pattern comes from `src/sqlite.ts`, which is read-only, so the server needs its own small writable opener. No new native dependencies.
- **Command:** registered as `registerTeamCommands(program)` in `src/team-server/cli.ts`, following the `registerSyncCommands` pattern in `src/main.ts:3358`.
- **Flags:** `--port`, `--data-dir`, `--tls-cert/--tls-key`. Without TLS flags it expects a reverse proxy, because the client only allows https off loopback (`assertHttps` in `src/sync/discovery.ts`).
- **Server config:** `team-server.json` in the data dir:
  - `accept_session_detail: boolean` (default false)
  - `accept_findings: boolean`
  - `retention_days`
  - `org_name`
- **Endpoints:**
  - `GET /.well-known/codeburn-export.json`: the existing doc plus new optional fields:
    - `auth: "enrollment"`
    - `enroll_path`
    - `revoke_path` (added later: `POST` with the device credential revokes that device; used by `sync logout`)
    - `detail_levels: ["summary"] | ["summary","sessions"]`
    - `findings_path?`
  - `POST /v1/enroll`: exchanges a one-time enrollment token for a long-lived device credential. The server stores only its hash. One person can enroll several devices.
  - `POST /v1/traces`: OTLP ingest using Bearer device credential auth.
    - Identity comes only from the credential, never from the payload (same rule as the existing contract).
    - Spans are upserted by span id, and spans up to 6 months old are accepted.
    - If the server does not accept session detail, it drops session-level attributes on ingest regardless of what the client sent (defense in depth).
  - `POST /v1/findings` (when `accept_findings` is on): the latest `optimize` findings snapshot per person.
  - `/api/team/*`: read API for the viewer (see section 4), authenticated by admin/viewer login.
- **Storage (SQLite):**
  - `people(id, name, email, team, revoked_at)`
  - `devices(id, person_id, cred_hash, label, last_seen)`
  - `enrollments(token_hash, person_id, expires_at, used_at)`
  - `daily_usage(person_id, day, provider, model, project, category, input, output, cache_read, cache_write, cost_usd, calls)`: the rollup the viewer reads. It is always populated.
  - `spans(span_id PK, person_id, device_id, ts, …)`: raw spans for idempotent upsert. The rollup is recomputed for the affected (person, day) after each ingest.
  - `sessions(trace_id, person_id, project, started, duration_ms, calls, cost, …)`: written only when session detail is accepted.
  - `findings(person_id, captured_at, json)`
  - Retention pruning runs daily.
- **Admin CLI** (run on the server host, writing straight to the DB):
  - `codeburn team admin add-person --name --email --team`: prints an enrollment token and a ready-to-paste `codeburn sync setup` line.
  - `list`, `revoke <person|device>`, `rotate-enrollment`, `add-viewer --name` (prints a viewer login key).
- **Docker:** a Dockerfile plus `docs/team/server.md` covering the reverse-proxy and TLS setup.

### 2. Client: extend `codeburn sync` (src/sync/)
- **`discovery.ts`:** `parseDiscoveryDoc` makes `issuer`/`client_id` required only when `auth !== "enrollment"`. It also parses the new optional fields. The version stays 1 because the changes are additive.
- **`cli.ts` setup:** `codeburn sync setup <url> --token <enrollment> [--detail summary|sessions] [--share-findings]`.
  - With `auth: "enrollment"` it skips the OIDC browser flow in `auth.ts`, calls `/v1/enroll`, and stores the device credential through the existing `credentials.ts`.
  - The OIDC path stays unchanged for orgs that already have an IdP.
- **New `codeburn sync config detail <summary|sessions>`** and **`sync config findings <on|off>`**. They persist in `SyncConfig` (`src/sync/config.ts`).
  - The effective level is the client setting clamped to what the server advertises.
  - `sync status` shows both values.
- **`push.ts`/`cli.ts` push:**
  - With enrollment auth, use the stored credential as Bearer directly. There is no refresh grant.
  - A 401 means revoked: tell the user to re-enroll.
- **`otlp.ts`:**
  - Add the resource attribute `codeburn.detail_level`.
  - Add the span attribute `ai.category` (task category). Aggregates are needed per category, and the category is already computed in `ClassifiedTurn`.
  - Both are sent only when a detail level is in effect. OIDC configs with no explicit level keep the legacy wire without them, so existing receivers and auto-sync acceptances are unaffected (see `docs/sync/DEVELOPER.md`).
  - At `summary` level:
    - Replace `traceId` with a per-device per-day hash, so sessions can't be reconstructed.
    - Omit `ai.work_unit_id`, `ai.session_role`, `ai.lineage_evidence`, `ai.session_duration_ms`, `ai.call_count` and `ai.tools`.
    - Keep provider, model, tokens, cost, project basename, category and timestamp, rounded to the hour.
  - At `sessions` level: today's full span set.
  - Reuse the existing sanitizers (`sanitizeModelIdentifier`, `projectBasenameFromWorkingDirectory`). Prompts, file paths and turn content are never sent at any level, exactly as today.
- **Findings:** when enabled, push the output of the existing optimize engine (same data as `codeburn optimize --format json`) to `findings_path` after a successful usage push, at most once a day.
- **`consent.ts`:** the disclosure text and acceptance fingerprint include the detail level and the findings flag. Raising the level re-prompts for consent.

### 3. Auto-push on every OS
`src/sync/schedule-installer.ts` currently installs a macOS LaunchAgent only. Add:
- Windows: Task Scheduler via `schtasks /Create … /SC HOURLY|DAILY` running `codeburn sync auto run`.
- Linux: a systemd user timer, falling back to the current crontab hint.

`sync auto enable/disable/status` already route through this module.

### 4. Team report viewer
- A second Vite entry in `dash/` (`dash/team.html` → `dash/src/team/`) that reuses the existing components: `UsageChart`, `DataTable`, `BarList`, `MetricCard`, `Punchcard`. It is built into `dist/team-dash` and served by `codeburn team serve`.
- **Login:** a viewer key exchanged for an HttpOnly session cookie. The read API rejects cross-origin requests, borrowing the Origin/Host checks from `src/web-dashboard.ts`.
- **Pages:**
  - **Overview:** org spend and tokens over time, month-to-date pace, active people, and spend by tool/model/team.
  - **People:** per-person table (cost, tokens, cache-read ratio, top model, trend). Drill-down shows that person's tool/model/project/category split.
  - **Models & tools:** who uses which model for which task category. This shows where premium models go to low-value categories.
  - **Projects:** cost per project across people.
  - **Sessions:** only when session detail is stored. Session list with duration, calls and cost, filterable by person and project.
  - **Insights:** rule-based callouts from the rollups:
    - low cache-read ratio relative to peers
    - premium-model share on simple categories
    - spend spikes week over week
    - top recurring optimize findings across the team, with total estimated savings (when findings are enabled)
  - CSV export of any table.
- Period picker and compare-periods (this month vs last), reusing the shapes from `src/day-aggregator.ts` where practical.

## Phasing
1. Server core: storage, enrollment, `/v1/traces` ingest, admin CLI, plus client enrollment auth and discovery changes. A real `sync push` lands in SQLite.
2. Detail levels on client and server, `ai.category`, consent update.
3. Viewer: Overview, People, Models, Projects, Insights.
4. Windows and Linux scheduling.
5. Sessions page, findings upload and Insights integration, Docker, docs (`docs/team/`, plus an update to `docs/sync/DEVELOPER.md` describing the enrollment auth and detail-level contract).

## Critical files
- **New:** `src/team-server/{cli,server,db,ingest,rollup,auth,api}.ts`, `dash/team.html`, `dash/src/team/*`, `docs/team/*`, `Dockerfile.team`
- **Modified:** `src/main.ts` (register), `src/sync/{discovery,cli,push,otlp,config,consent,schedule-installer}.ts`, `dash/vite.config.ts`, `package.json` (build script), `tsup.config.ts`

## Verification
- **Unit tests** (vitest, `tests/team-server/*.test.ts`, using `mkdtemp` data dirs and loopback servers as in `tests/sync-e2e.test.ts`):
  - enrollment lifecycle: one-time use, expiry, revoke → 401
  - OTLP ingest is idempotent: re-sending the same spans doesn't change the rollup
  - when `accept_session_detail=false`, a sessions-level payload stores no session rows or lineage attributes
  - viewer API rejects unauthenticated and cross-origin requests
- **Client tests:** extend `tests/sync.test.ts` (enrollment discovery parsing, level clamping) and `tests/sync-wire-privacy.test.ts` (the summary level omits session attributes and uses a day-bucket traceId).
- **End-to-end on this machine:**
  1. `codeburn team serve --port 8787 --data-dir <tmp>`
  2. `codeburn team admin add-person --name Karl`
  3. `codeburn sync setup http://127.0.0.1:8787 --token <t>`
  4. `codeburn sync push --since 30d`
  5. Open the viewer and check that its totals match `codeburn report --period 30d`.
  6. Repeat with `--detail sessions` and the server flag both off and on.
- **Scheduling:** run `codeburn sync auto enable` on Windows, then check `schtasks /Query /TN codeburn-sync` and that a push happens on the next run.
- Run `npm test` and `npm run build:dash` before declaring done.
