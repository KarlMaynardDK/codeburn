# CodeBurn team server

`codeburn team serve` is a self-hosted collector for the OTLP spans that `codeburn sync` pushes, plus a
read-only report viewer. People are enrolled by an admin with one-time tokens; no identity provider is needed.

## Quick start

```bash
codeburn team serve --port 8787 --data-dir /var/lib/codeburn-team
codeburn team admin add-person --name "Ada" --email ada@example.com --team platform \
  --url https://codeburn.example.com --data-dir /var/lib/codeburn-team
codeburn team admin add-viewer --name "Eng managers" --data-dir /var/lib/codeburn-team
```

`add-person` prints a ready-to-paste line for the person's machine:

```bash
codeburn sync setup https://codeburn.example.com --token cbe_...
```

`add-viewer` prints a viewer key (`cbv_...`, shown once). Managers paste it into the login page of the viewer at `/`.
The viewer is the `dist/team-dash` build (`npm run build:dash`); if it is missing, `/` shows a hint page and the
collector and `/api/team/*` still work.

## Command reference

| Command | Purpose |
| --- | --- |
| `codeburn team serve [--port 8787] [--host 127.0.0.1] [--data-dir] [--database-url] [--tls-cert --tls-key]` | Run the server. |
| `codeburn team admin add-person --name N [--email E] [--team T] [--url U]` | Create a person, print a 7-day single-use enrollment token. |
| `codeburn team admin list` | People, their devices, last-seen time and any team-admin teams. |
| `codeburn team admin grant-team-admin <person-id> --team T [--team T2]` | Let a person see and manage those teams. |
| `codeburn team admin revoke-team-admin <person-id> [--team T]` | Remove those teams, or the whole role without `--team`. |
| `codeburn team admin revoke <person-id\|device-id>` | Revoke a person (all devices) or one device. Its credential gets 401 immediately. |
| `codeburn team admin merge-person <from-id> <to-id>` | Move all usage, sessions, git attribution and devices from one person to another, then revoke the first. Use it when someone ends up with two accounts. |
| `codeburn team admin delete-person <id> [--force]` | Permanently delete a person and their devices. Refuses while they still own usage (merge first) unless `--force`. Frees their email for registration. |
| `codeburn team admin rotate-enrollment <person-id> [--url U]` | Invalidate unused tokens, print a new one (also how an extra device is enrolled). |
| `codeburn team admin add-viewer --name N` | Create a viewer login key. |

All `admin` commands take `--data-dir` and `--database-url` and write straight to the database, so run them on the
server host (or any host that can reach the database). The data dir defaults to `~/.codeburn-team`, or
`CODEBURN_TEAM_DATA_DIR`.

## Configuration: `team-server.json`

Created in the data dir with these defaults on first start (restart after editing):

```json
{
  "accept_session_detail": false,
  "accept_findings": false,
  "accept_coaching": false,
  "install_mode": "manual",
  "retention_days": 400,
  "org_name": ""
}
```

- `accept_session_detail`: when false, the discovery document advertises only `summary`, and session-level span
  attributes (`ai.work_unit_id`, `ai.session_role`, `ai.call_count`, `ai.session_duration_ms`) are dropped on ingest
  even if a client sent them. No session rows are stored and the Sessions and Repos & PRs pages return 404. Turn it
  on to store sessions from clients that push at the `sessions` detail level, and git attribution (repo, PR links and
  commits, sent with `codeburn sync push --attribution`).
- `accept_findings`: enables `POST /v1/findings` (the latest `codeburn optimize` snapshot per person) and the
  findings section of the Insights page.
- `accept_coaching`: enables `POST /v1/coaching` (see "Coaching snapshots" below), the coaching insights that need it
  and the extra columns of the "Who might need coaching" table. Env: `CODEBURN_TEAM_ACCEPT_COACHING`.
- `install_mode`: `manual` (default) or `all`. With `all`, the generated `/install.sh` and `/install.ps1` finish the
  setup without asking: `codeburn sync config all on` (everything this server accepts), `codeburn sync auto enable
  --accept` and `codeburn sync push --since all`. Use it for a rollout where the organisation has already decided; the
  script says what it is doing and how to undo it (`codeburn sync config all off`). With `manual` each person chooses
  what to send and accepts automatic sync themselves. Env: `CODEBURN_TEAM_INSTALL_MODE`.
- `retention_days`: raw spans, rollups and sessions older than this are pruned on startup and every 24 hours.
- `org_name`: shown in the viewer and in the discovery document.
- `database_url`: optional PostgreSQL URL (see below).
- `public_url`: the externally reachable base URL (`https://codeburn.example.com`, no path) written into the generated
  `/install.sh` and `/install.ps1`. When unset it is derived from the request's `Host` / `X-Forwarded-Proto` headers.

The server can also distribute the exact CLI build it ships with; see [Installing the client from your server](install.md).
`CODEBURN_TEAM_CLIENT_PACKAGE` (or `--client-package <path>`) points at the `npm pack` tarball; the Docker image sets it. The image stamps the package version as `<base>-team.<stamp>` (`TEAM_BUILD` build arg, default the
UTC build time); see the install page. Rolling out a new build is covered in [Client updates](#client-updates).

Each setting except `database_url` can also be set by an environment variable, which wins over the file:
`CODEBURN_TEAM_ACCEPT_SESSION_DETAIL`, `CODEBURN_TEAM_ACCEPT_FINDINGS` (`true`/`false`, `1`/`0`, `on`/`off`),
`CODEBURN_TEAM_RETENTION_DAYS`, `CODEBURN_TEAM_ORG_NAME` and `CODEBURN_TEAM_PUBLIC_URL`. This is the easiest way to configure a container.
The optional `gitlab` block has its own variables; see [GitLab sign-in](#gitlab-sign-in).

Identity always comes from the device credential, never from the payload. Credentials, enrollment tokens and viewer
keys are stored only as SHA-256 hashes. Spans older than 183 days (or more than a day in the future) are rejected.

## Client devices and automatic sync

### What each device needs

A device pushes with a device credential (`cbd_...`). The server issues it once, when the device enrolls with a
one-time enrollment token (`cbe_...`). The credential is saved on the device: in the OS keychain, or in a `0600` file
when there is no keychain.

| The device is... | What the person runs |
| --- | --- |
| New to codeburn sync | `codeburn sync setup <url> --token cbe_...`, then `codeburn sync auto enable --accept` for automatic sync |
| Already enrolled with this server | Nothing. No token and no setup. If automatic sync isn't on yet, only `codeburn sync auto enable --accept` |
| Set up against an OIDC endpoint (the sync that predates team servers) | Same as a new device: a token, then `auto enable --accept` |
| A second (or further) machine for the same person | Same as a new device, with a new token. Each machine gets its own credential |
| Enrolled, but its credential was revoked or lost (an admin revoked it, `codeburn sync logout`, a wiped home directory) | Same as a new device, with a new token |

- **A new client build doesn't need a token.** `codeburn update` replaces the CLI and keeps the saved credential,
  configuration and acceptance; see [Client updates](#client-updates).
- **Don't re-run setup on an enrolled device.** It enrolls the device again, which needs a fresh token, and drops the
  device's automatic sync acceptance. The server then lists a second device for that person. Usage isn't counted
  twice, since the server stores each span once by its id. But the old device record stays active until an admin
  runs `codeburn team admin revoke <device-id>`.
- **Getting a token.** An admin runs `codeburn team admin add-person` (new person) or
  `codeburn team admin rotate-enrollment <person-id>`. With [GitLab sign-in](#gitlab-sign-in) and self-registration
  on, members can create their own from the viewer's **Set up another machine** link; see
  [Self-registration](#self-registration). A token works once, on one machine, for 7 days. Issuing a new one cancels
  any earlier token the person hasn't used yet, so set up machines one at a time.
- **An OIDC refresh token doesn't carry over.** The server only accepts device credentials it issued itself.
  [GitLab sign-in](#gitlab-sign-in) is for the report viewer only; the sync client doesn't use it.
- `codeburn sync status` shows which kind of setup a device has: `Auth: enrollment (team server: ...)` or an `Issuer:`
  line for OIDC.

### Automatic sync acceptance

`codeburn sync auto enable` prints exactly what will be sent and stores a fingerprint of it. It only stores that once
the person runs it with `--accept`. A scheduled `codeburn sync auto run` pushes only while what it would send still
matches that fingerprint. Otherwise it records `acceptance-required`, sends nothing, and waits for
`codeburn sync auto enable --accept` again.

- **Moving to this server always needs a new acceptance.** The destination is part of the fingerprint, and
  `sync setup` replaces the old configuration. Setup prints a reminder when it drops an acceptance.
- **Everything a team server device sends is covered**, including `ai.category` (task category) on every span,
  `codeburn.detail_level` on every batch, and the per-call counts and names listed in
  [What Gets Sent](../sync/README.md#what-gets-sent).
- **Updating the client can add fields**, which pauses automatic sync until the person accepts again. The update that
  added turn outcomes, line counts, MCP tool, skill and subagent names and the other per-call counts is one of these.
  Only calls pushed after the update carry the new fields; data already on the server is not re-sent.
- **While a device is waiting for acceptance**, `codeburn sync push` and `codeburn sync status` print
  "Automatic sync is paused" with the command to run. `codeburn sync auto status` lists what changed. Manual
  `codeburn sync push` keeps working throughout.

### Changing server settings

Devices read the discovery document before every automatic run, so a change takes effect at the next run:

| Change | Effect on devices with automatic sync on |
| --- | --- |
| `accept_session_detail` off → on | Devices that asked for `sessions` (`--detail sessions` or `codeburn sync config detail sessions`) would send more, so they pause until the person accepts again. Other devices are unaffected. |
| `accept_session_detail` on → off | Devices drop to `summary` and keep pushing; sending less needs no new acceptance. |
| `accept_findings` off → on | Devices with findings sharing turned on pause until the person accepts again. Other devices are unaffected. |
| `accept_findings` on → off | Devices stop uploading findings and keep pushing. |
| `accept_coaching` off → on | Devices with coaching sharing turned on pause until the person accepts again. Other devices are unaffected. |
| `accept_coaching` on → off | Devices stop uploading coaching stats and keep pushing. |
| `org_name`, `retention_days`, `public_url`, `gitlab` | No effect on acceptance. |

## Client updates

With a client package configured (the Docker image always has one), the server is the source of the CLI build for
every enrolled device. Members never take the public `codeburn` release. Installing that build in the first place is
covered in [Installing the client from your server](install.md).

**Rolling out a new build (admin)**

1. Rebuild the image with a new `TEAM_BUILD`, so the build gets a new version:
   `TEAM_BUILD=$(date -u +%Y%m%d%H%M) docker compose -f docker-compose.team.yml up -d --build`.
   Outside Docker, point `CODEBURN_TEAM_CLIENT_PACKAGE` at the new `npm pack` tarball and restart.
2. Check the startup log line `client package: codeburn <version> (sha256 ...)`, or the `client_package` field of
   `/.well-known/codeburn-export.json`.
3. Optionally tell members. Each device learns the new version at its next push (manual or automatic), and from
   then on `codeburn sync push` and `codeburn sync status` print
   `Your team server has CodeBurn <version> (this is <installed>). Install it with: codeburn update`.
   A device with [automatic sync](#automatic-sync-acceptance) installs the new build itself before its next
   scheduled push (see [Automatic updates](#automatic-updates)); other devices wait for the member to run the command.

**Updating a device (member)**

```sh
codeburn update --check   # reports the server's build version; changes nothing
codeburn update           # installs it
```

What `codeburn update` does on a device enrolled with a team server:

- It reads `client_package` (version and sha256) from the server's discovery document.
- If the installed version differs, it installs the server's build. **Any difference counts**, so rolling the server
  back to an older build also rolls devices back. An equal version is reported as up to date.
- It downloads `/install/codeburn-team-<version>.tgz`, checks the sha256 the server advertised, and only then runs
  `npm install -g` on the verified file. On a mismatch it reports `verify_fail` and installs nothing.
- The device credential, `sync.json`, the automatic sync schedule and its acceptance all stay as they are. No token,
  setup or re-enrollment is needed.

When it can't update:

| Situation | Result |
| --- | --- |
| The server can't be reached, or isn't https (plain http only works on loopback) | An error. It never falls back to the public release |
| The server advertises no client package | Skipped. A `codeburn-team` build never installs the public `codeburn@latest` |
| A `codeburn-team` build on a device that isn't enrolled | Skipped. Enroll it first (`codeburn sync setup <url> --token ...`) |
| The CLI was installed with Homebrew, pnpm, bun or volta | Reported as managed. Reinstall with the server's `install.sh` / `install.ps1` (no token needed for that) to switch it to npm |

**Which version each device runs**

Every push (traces and findings) carries an `X-Codeburn-Client-Version` header with the CLI version. The server stores
the latest one per device, and `codeburn team admin list` prints it next to each device (`client 0.9.7-team.202610`;
`client unknown` for a device that hasn't pushed since the server was upgraded). Compare it with the
`client package:` line the server prints at startup to see who is behind.

<a id="automatic-updates"></a>
**Automatic updates**

On a team-server enrollment, each scheduled `codeburn sync auto run` checks the build the server advertises before it
pushes. If it differs from the installed version (any difference, so rollbacks apply too), the run:

1. runs `codeburn update --cli`, which downloads the build, verifies its sha256 and installs it with npm, exactly
   like the manual command;
2. restarts itself on the new files (`sync auto run --no-update`) and syncs with the new build;
3. writes an `updated` receipt (`from`, `to`) to `codeburn sync auto status`.

If the update fails (no permission, server unreachable, a managed install, a checksum mismatch), the run writes an
`update-failed` receipt with the reason and **still syncs with the installed build**, so a stuck update never stops
usage reaching the server. If the new build changes what is sent, the acceptance fingerprint changes and the pushes
pause until the member accepts again, as described below.

Turn it off per device with `codeburn sync auto updates off` (`on` to restore; no argument shows the state), or with
`CODEBURN_NO_AUTO_UPDATE=1` in the scheduler's environment. `codeburn sync status` shows the setting. It never applies
to OIDC setups, and a manual `codeburn sync push` doesn't update; it only prints the notice.

**Updates and automatic sync**

A new build usually sends exactly the same fields, and automatic sync carries on. When a build changes what is
sent (new span attributes, or a new wire contract version), the acceptance fingerprint no longer matches. Automatic
sync on that device then pauses until the person runs `codeburn sync auto enable --accept` again; see
[Automatic sync acceptance](#automatic-sync-acceptance). Mention it in the rollout note when a release changes what
sync sends.

## GitLab sign-in

The viewer can optionally offer **Sign in with GitLab** (OAuth2 with PKCE, OIDC userinfo) next to viewer keys.
Viewer-key login keeps working unchanged. The design notes are in [gitlab-sso.md](gitlab-sso.md).

### Before you start

- **A fixed public URL.** GitLab redirects the browser back to `<public_url>/auth/gitlab/callback`, so the server
  needs `public_url` and the server refuses to start without it. In production this is your https address behind the
  reverse proxy (see [TLS and reverse proxy](#tls-and-reverse-proxy)); the proxy needs no extra routes, since
  `/auth/gitlab/*` is served by the same server. For a local trial, `http://localhost:8787` works.
- **Outbound access to GitLab.** The server itself calls GitLab's `/oauth/token` and `/oauth/userinfo` (10 second
  timeout), so the host or container must reach the GitLab URL. If a self-managed GitLab uses a private CA, give Node
  the CA with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.
- **The group paths you'll use.** A group's full path is what appears in its URL: for
  `https://gitlab.example.com/acme/platform-leads` it is `acme/platform-leads`. Membership inherited from a parent
  group counts.
- **Matching emails for existing people.** People an admin already added are recognised by email: their enrolled
  email must equal the email GitLab reports for them (their primary email, which must be verified). Matching ignores
  letter case. Check `codeburn team admin list` (or the People page) and fix any that differ before people sign in.
  Otherwise they'll be refused, or offered registration and create a duplicate person.
- **Optional: the client package.** With a client package configured, the registration page shows the full
  one-line installers; without one it only shows `codeburn sync setup <url> --token <token>`, which needs
  CodeBurn already installed. See [Installing the client from your server](install.md).

### 1. Create the OAuth application in GitLab

Create it at whichever level you administer. All three work the same way:

- **Your user:** avatar > **Edit profile** > **Access** > **Applications** > **Add new application**.
- **A group:** the group > **Settings** > **Applications** (needs the Owner role).
- **The whole instance** (self-managed, administrators only): **Admin** > **Applications** > **New application**.
  You can mark it **Trusted** to skip GitLab's "Authorize" screen.

Fill in:

- **Name:** for example `CodeBurn team`. Users see it on GitLab's consent screen.
- **Redirect URI:** exactly `<public_url>/auth/gitlab/callback`, for example
  `https://codeburn.example.com/auth/gitlab/callback`. The scheme, host and port must match `public_url`
  character for character, with no trailing slash.
- **Confidential:** leave it checked. The server keeps the secret.
- **Scopes:** `openid`, `profile` and `email`. Nothing else is needed.

Save, then copy the **Application ID** and the **Secret**. GitLab shows the secret only once; if you lose it, use
**Renew secret** and update the server.

### 2. Configure the server

Set `public_url` and the application's ID and secret. Keep the secret in an environment variable rather than in the
file:

```json
{
  "public_url": "https://codeburn.example.com",
  "gitlab": {
    "url": "https://gitlab.example.com",
    "admin_groups": ["acme/platform-leads"],
    "register_groups": ["acme"],
    "register_note": "Questions? Ask in #codeburn on Slack."
  }
}
```

```bash
CODEBURN_TEAM_GITLAB_CLIENT_ID=...
CODEBURN_TEAM_GITLAB_CLIENT_SECRET=...
```

- `url`: the GitLab instance, default `https://gitlab.com`. A subpath install (`https://example.com/gitlab`) works.
- `client_id`, `client_secret`: sign-in is enabled only when both are set.
- `admin_groups`: group full paths whose members (subgroups included) see everything, like a viewer key.
- `register_groups`: group full paths whose members may register themselves (see below). Empty, the default, turns
  self-registration off. `"*"` allows any user of the GitLab instance; **on gitlab.com that means anyone with an
  account**, so only use it on a private instance.
- `register_note`: optional plain text shown on the registration page below the install instructions. Blank lines
  start new paragraphs and `http(s)://` URLs become links. HTML is shown as text, never rendered.

Each key has an environment variable that wins over the file: `CODEBURN_TEAM_GITLAB_URL`,
`CODEBURN_TEAM_GITLAB_CLIENT_ID`, `CODEBURN_TEAM_GITLAB_CLIENT_SECRET`, `CODEBURN_TEAM_GITLAB_ADMIN_GROUPS`,
`CODEBURN_TEAM_GITLAB_REGISTER_GROUPS` (both comma-separated) and `CODEBURN_TEAM_GITLAB_REGISTER_NOTE`. A note with
several paragraphs is easier to write in `team-server.json` (use `\n\n` between paragraphs) than in an environment
variable. With Docker Compose, put these in `.env`; see [Docker](#docker).

### 3. Restart and check

Restart the server (`codeburn team serve`, or `docker compose ... up -d`). The startup log confirms the settings:

```text
  GitLab sign-in: https://gitlab.example.com, self-registration on
```

Open `public_url` in a browser. The login card now has a **Sign in with GitLab** button above the viewer-key form.
Try three accounts: one in an `admin_groups` group (should see everything), one already enrolled as a person
(should see only their own usage), and one in a `register_groups` group who isn't enrolled (should land on the
registration page).

### Who gets in

Rules are checked in this order:

- **Admin**: a member of an `admin_groups` group. Sees everything.
- **Member**: a user whose **verified** GitLab email matches exactly one active person's enrolled email
  (case-insensitive). Sees only their own data: no team or person pickers, and the People tab shows just them.
  Revoking the person ends their GitLab session immediately.
- **Team admin**: a member who an admin has also made administrator of one or more teams. Sees every person in those
  teams (plus themselves) across overview, people, models, projects, sessions, work and insights, and can add people to
  those teams and issue install tokens for their members. The scope is set by the server from the `team_admins` table on
  every request, so granting or revoking takes effect at once; a `team` or `person` outside it is ignored or 404. They
  cannot revoke, merge or delete people, create new teams, or grant the role. Hidden project names stay private to their
  owner. Team admins sign in with GitLab like any member, so the person must have a verified GitLab email.
  Grant with `codeburn team admin grant-team-admin <person-id> --team <t> [--team <t2>]` (or the **Team admin** button on
  the People page) and remove with `revoke-team-admin <person-id> [--team <t>]`.
- **Registrant**: a user with a verified email that no person has (active **or** revoked), who is in a
  `register_groups` group. See below.
- Anyone else is told their account isn't authorised.

### Self-registration

A registrant lands on `/register`. The page shows their GitLab name and email (they can't change these) and asks
for their **team**. The team box suggests the teams already in use, but any name is accepted, so the first person
from a new team simply types it. A name that differs from an existing team only in letter case or surrounding
spaces is saved with the existing spelling (`" platform"` becomes `Platform`).

Submitting creates the person exactly as `codeburn team admin add-person --name <GitLab name> --email <GitLab email>
--team <team>` would, and shows a one-time enrollment token (valid 7 days, one machine) with the same install
commands the CLI prints, then the `register_note`. The session becomes a member session.

Members (self-registered or added by an admin) get a **Set up another machine** link in the viewer's header. It
opens `/register`, which skips the team form and offers **Create a new install token**. The page then shows the
token with the same install commands. Use it for:

- **A second machine.** Each machine enrolls with its own token and gets its own device credential.
- **A machine whose credential was revoked or lost.**
- **A registrant who reloaded the page** before copying their first token.

It isn't needed to update a machine that already syncs: `codeburn update` installs the server's current build and
keeps the device's credential (see [Client updates](#client-updates)).

Details:

- The link appears only while self-registration is on (`register_groups` is not empty). With GitLab sign-in but no
  self-registration, members ask an admin for `codeburn team admin rotate-enrollment <person-id>`.
- A new token cancels any earlier token the person hasn't used yet. Set up one machine before creating the next
  token.
- Each session can create at most 10 tokens an hour, and each one is logged to stderr.
- Members can't see other devices in the viewer. A member retires a machine by running `codeburn sync logout` on
  it, which revokes that device on the server. For a machine they no longer have, an admin uses
  `codeburn team admin list` and `codeburn team admin revoke <device-id>`.

Registrations are logged to stderr. A revoked person can't register again with the same email.

GitLab sign-in sessions last 12 hours, the same as viewer-key sessions; after that, users sign in again.

### Member profile and hidden projects

A signed-in member (not an admin viewer key) gets a **My profile** tab in the viewer. It edits only their own record:

- **Name.** Free text, 1-100 characters. The header and the people lists show the new name at once.
- **Team.** Pick an existing team or type a new one, with the same rules as registration (a name that differs from an
  existing team only in case or spacing takes the existing spelling).
- **Email.** Read only. It is what links the GitLab login to the person.
- **Hidden projects.** The tab lists every project the member has sent usage for. A hidden project's usage still counts
  in their totals, but every other view (admins included) shows it as `unknown`: the daily totals, models and tools,
  sessions, and the repo and pull-request list on **Repos & PRs** (the repo reads `unknown` and PR links are dropped).
  Hiding applies to usage already stored and to anything that arrives later, even if it is sent after a re-sync.
  Unhiding restores the real names. Only the member sees the real names, in their own profile.

Who can see what: the real project names are kept in the database so unhiding can restore them, and are exposed only by
the member's own profile endpoint. A server operator with direct database access can still read them (`spans.real_project`
and the `hidden_projects` table); hiding is a privacy control inside the viewer, not encryption.

`codeburn team admin merge-person` moves a person's hidden projects along with their usage, and `delete-person` removes
them. Admins have no profile page (`/api/team/profile` is 404 for a viewer key and 403 for a not-yet-registered GitLab
user).

### Troubleshooting

The server logs the reason for every failed GitLab sign-in to stderr. The browser only sees one of two messages:

- **"Your GitLab account isn't authorised"** (`?login_error=denied`): sign-in worked, but the rules above gave no
  access. The log shows `GitLab sign-in denied for <email>`. Common causes:
  - the email isn't verified in GitLab;
  - the enrolled email differs from the GitLab one;
  - the email belongs to a revoked person;
  - two active people share the email;
  - the user isn't in any `admin_groups` or `register_groups` group (check the spelling of the full path).
- **"GitLab sign-in failed"** (`?login_error=failed`): the round trip broke. The log shows
  `GitLab sign-in failed: <reason>`. Common causes:
  - a wrong client ID or secret, or a renewed secret not yet copied to the server (token endpoint returns 401);
  - a redirect URI in GitLab that doesn't match `public_url` (GitLab shows its own error page before coming back);
  - the server can't reach GitLab, or doesn't trust its certificate;
  - the sign-in took longer than 10 minutes, or was started in another browser.
- **GitLab says "The redirect URI included is not valid"**: the application's Redirect URI must be exactly
  `<public_url>/auth/gitlab/callback`.
- **No GitLab button:** both `client_id` and `client_secret` must be set; check the startup log line.
- **Too many failures:** after 10 failed sign-ins (GitLab or viewer key) in a minute, an IP address is paused for
  the rest of that minute.

## Storage: SQLite or PostgreSQL

| | SQLite (default) | PostgreSQL |
| --- | --- | --- |
| Setup | none; `<data-dir>/team.db` | `--database-url postgres://user:pw@host:5432/db` |
| Fits | up to a few dozen people, one server | larger teams, managed backups, several admin hosts |
| Needs | Node 22.13+ (`node:sqlite`) | the `pg` driver (bundled dependency) |

Select PostgreSQL with `--database-url`, the `CODEBURN_TEAM_DATABASE_URL` environment variable, or `database_url` in
`team-server.json` (in that order of precedence). Tables are created automatically (`schema_version` tracks the
schema). Back up the data dir (SQLite) or the database (PostgreSQL); `team-server.json` lives in the data dir either
way.

The server upgrades the schema in place on startup. Schema v2 adds columns to the stored spans and rebuilds the daily
rollup from them, so existing data stays. Usage stored before v2 shows zero for the new counts, and as `unknown` speed.
A server refuses to start on a database written by a newer version.

## TLS and reverse proxy

The sync client only accepts `https://` URLs off loopback. Either terminate TLS in a reverse proxy (recommended) or
pass `--tls-cert` and `--tls-key`. The server speaks plain HTTP behind the proxy and must be bound to a private
interface. The viewer session cookie is `HttpOnly; SameSite=Strict`, and the API rejects requests whose `Origin`
differs from `Host`, so the proxy must forward the original `Host` header.

Caddy:

```caddyfile
codeburn.example.com {
  encode gzip
  reverse_proxy 127.0.0.1:8787
}
```

nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name codeburn.example.com;
  ssl_certificate     /etc/letsencrypt/live/codeburn.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/codeburn.example.com/privkey.pem;
  client_max_body_size 12m;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

The session cookie gets the `Secure` attribute when the server terminates TLS or the proxy sends `X-Forwarded-Proto: https` (Caddy does; the nginx example above does).

## Docker

The image builds the CLI and the viewer from source, so no local build is needed first. Its build context is limited
by `Dockerfile.team.dockerignore` (an allowlist), so host `node_modules` and `dist` never reach the image.

Server plus PostgreSQL 17, from the repo root:

```bash
docker compose -f docker-compose.team.yml up -d --build
docker compose -f docker-compose.team.yml exec server \
  node dist/cli.js team admin add-person --name "Ada" --team platform --url https://codeburn.example.com
docker compose -f docker-compose.team.yml exec server node dist/cli.js team admin add-viewer --name "Manager"
```

Settings come from the environment or a `.env` file next to the compose file:

```dotenv
POSTGRES_PASSWORD=change-me
CODEBURN_TEAM_PORT=8787                 # host port, bound to 127.0.0.1 only
CODEBURN_TEAM_ORG_NAME=Example Ltd
CODEBURN_TEAM_PUBLIC_URL=https://codeburn.example.com   # used in /install.sh and /install.ps1
CODEBURN_TEAM_ACCEPT_SESSION_DETAIL=false
CODEBURN_TEAM_ACCEPT_FINDINGS=false
CODEBURN_TEAM_RETENTION_DAYS=400
# Optional GitLab sign-in; see "GitLab sign-in" above.
CODEBURN_TEAM_GITLAB_URL=https://gitlab.example.com
CODEBURN_TEAM_GITLAB_CLIENT_ID=
CODEBURN_TEAM_GITLAB_CLIENT_SECRET=
CODEBURN_TEAM_GITLAB_ADMIN_GROUPS=acme/platform-leads
CODEBURN_TEAM_GITLAB_REGISTER_GROUPS=acme
CODEBURN_TEAM_GITLAB_REGISTER_NOTE="Questions? Ask in #codeburn on Slack."   # quoted: an unquoted " #" starts a comment
```

Change a setting by editing `.env` and running `up -d` again; the server container is recreated and the data stays in
the `team-data` and `pg-data` volumes. `POSTGRES_PASSWORD` is applied only when the database volume is first
created; changing it later needs `ALTER USER` in PostgreSQL as well. The server is published on loopback only, so put
the reverse proxy in front. `docker compose ... down` keeps the data, and `down -v` deletes it.

SQLite only, without compose:

```bash
docker build -f Dockerfile.team -t codeburn-team .
docker run -d --name codeburn-team -p 127.0.0.1:8787:8787 -v codeburn-team:/data codeburn-team
docker exec codeburn-team node dist/cli.js team admin add-viewer --name "Manager"
```

## Endpoints

- `GET /.well-known/codeburn-export.json`: discovery (`auth: "enrollment"`, `enroll_path`, `revoke_path`, `traces_path`,
  `detail_levels`, `findings_path` when enabled, `client_package` when a client package is configured).
- `GET /install.sh`, `GET /install.ps1`, `GET /install/codeburn-team.tgz` (alias `/install/codeburn.tgz`), `GET /install/codeburn-team-<version>.tgz`: client
  distribution, only when a client package is configured (404 otherwise). No authentication.
- `POST /v1/enroll`: `{token, label?, device_id?}` returns `{credential, device_id, person}`; 401 for unknown, used,
  expired or revoked tokens.
- `POST /v1/revoke`: `Authorization: Bearer cbd_...`. Revokes the calling device only (used by `codeburn sync logout`);
  200 `{ok: true}`, 401 when the credential is unknown or already revoked.
- `POST /v1/traces`: OTLP/HTTP JSON, `Authorization: Bearer cbd_...`. Max 1000 spans and 10 MB per request.
  Re-sending a span id overwrites it, so pushes are idempotent. A span id owned by another person is never
  reassigned.
- `POST /v1/findings`: `{captured_at, findings}`, only when `accept_findings` is on.
- `POST /v1/coaching`: `{captured_at, coaching}`, only when `accept_coaching` is on (404 `coaching_disabled` otherwise,
  400 `coaching_required` when `coaching` is not an object). The latest snapshot per person is kept.
- `GET /auth/gitlab/login`, `GET /auth/gitlab/callback`: GitLab sign-in, only when it is configured (404 otherwise).
- `/register`: the self-registration page (part of the viewer). Once a token exists it also lists what to run after
  setup (choose what to send, `sync auto enable --accept`, `sync status`, `sync push --since all`), limited to the
  options this server accepts (`accept_session_detail`, `accept_findings`, `accept_coaching`). `codeburn team admin
  add-person` and `rotate-enrollment` print the same steps.
- `POST /api/team/admin/people` (admin viewers only, 404 for anyone else): body `{ name, email, team }`. Creates the person
  exactly as `add-person` does, for people who cannot sign in with GitLab, and returns the same install object as
  registration. Errors: `invalid_name`, `invalid_email`, `invalid_team` (400), `email_taken` (409). The viewer's
  **People** page has an **Add user** button that calls it and shows the token and install steps in a dialog.
- `POST /api/team/admin/people` also works for team admins, limited to their teams (`403 team_not_allowed` otherwise).
  `POST /api/team/admin/people/:id/token` issues a fresh install token for a person (full admins: anyone; team admins:
  people in their teams; 404 otherwise) and returns the same install object. `POST /api/team/admin/people/:id/team-admin`
  with `{ teams: [...] }` sets the teams a person administers (full admins only; an empty list revokes).
- `GET /help`: a public, server-rendered help page for members: install and connect, finish setup, what is sent, changing
  it, checking it, upgrading, another machine, logging out, uninstalling and troubleshooting. It shows the install
  one-liners only when a client package is served and only the options this server accepts. It uses `public_url` (or
  the validated Host header) for the server address, like the installers, and is linked from the dashboard header,
  the install-token page and the installer scripts.
- `/api/team/*`: viewer API (auth-methods, login, logout, meta, overview, people, models, tools, projects, sessions,
  work, insights, `coaching` (the per-person table behind the Insights page), `registration` / `registration/token` for self-registration, and `profile` for a member's own details:
  `GET` reads them and `POST {name?, team?, hidden_projects?}` changes them, with identity taken from the session). "Tokens" in these
  responses are input + output + cache read + cache write; `cache_read_ratio` is cache reads / (input + cache reads).
  `calls` counts requests: accounting-only records add cost but no call. `one_shot_rate` is edit prompts that needed
  no retry / edit prompts, and is null until a client sends turn outcomes. `tools` returns MCP tools, skills and
  subagent types with the spend of the calls that used each one (a call that used two counts toward both). `work`
  returns repos and PRs from git attribution, with each session's total spend, and is 404 without
  `accept_session_detail`.

## Insights

The Insights page has three parts: a "Who might need coaching" table (one row per person next to the team median,
people with the most flags first), insight cards grouped into coaching opportunities, spend to watch, and setup or
missing data, and the recurring `optimize` findings (with the names of the people who have each). Every card names the
person (linking to their page), shows the numbers behind it as small tables, and says what to try. The tables and cards
come from `GET /api/team/coaching` and `GET /api/team/insights`.

Rules that compare a person with the team use the median of the people who have enough data for that measure, and need
at least 2 such people (`MIN_PEERS`). A person is never compared with only themselves. Rules marked "absolute" use the
same thresholds as the coaching notes of the local `codeburn report` and work for a single person.

| Insight | Kind | Fires when | Evidence shown |
| --- | --- | --- | --- |
| `low-cache-read` | training | Cache-read ratio below half the team median (at least $1 spend). | Ratio against median, session count and average length. |
| `premium-on-simple` | training | Premium models (name contains `opus`, `gpt-5`, `o3` or `pro`) are over 50% of a person's spend (at least $1) on conversation, exploration, general or unknown work. | Model by task type with spend and share, and the projects. |
| `spend-spike` | cost | Last 7 days above 2x the 7 days before and more than $5 higher. | The projects and models that grew most. |
| `low-one-shot` | training | One-shot rate more than 20 points below the team median (at least 10 edit prompts). | Rate, retries per edit prompt, and one-shot rate by task type against the team's. |
| `weak-task-type` (absolute) | training | A task type with at least 5 edit prompts and a one-shot rate under 60%, for people `low-one-shot` did not already flag. | One-shot rate by task type. |
| `no-plan-mode` (absolute) | training | One-shot rate under 60% (at least 10 edit prompts) and no call used plan mode. | Plan-mode calls and share against the team's. |
| `tool-errors` | setup | At least 5 failed tool calls per 100 and above 2x the team median (at least 50 calls). | Errors and rate, and the person's most used MCP tools. |
| `frequent-interrupts` | training | At least 5% of calls interrupted and above 2x the team median (at least 50 calls). | Interrupted calls and share. |
| `fast-mode-share` | cost | Fast mode is 25% or more of the period's spend. | Fast spend by person. |
| `frequent-corrections` (absolute) | training | At least 15% of prompts, and at least 3, told the assistant it was wrong. Needs a coaching snapshot. | Prompts, corrections and share. |
| `slow-first-edit` (absolute) | training | Median time to first edit of 5 minutes or more over at least 3 sessions. Needs a coaching snapshot. | Sessions and median time. |
| `file-churn` (absolute) | training | At least one file edited in 3 or more sessions. Needs a coaching snapshot. | File count and the busiest file's sessions and edits (no names). |
| `coaching-not-shared` | setup | Someone with usage in the period has no coaching snapshot (only when `accept_coaching` is on). | The people, their team and spend. |

Insights are computed over the period and filters of the page. The coaching snapshot insights are the exception: a
snapshot covers the 30 days before it was taken, so they ignore the date range and the project filter, and each card
says which window it covers.

The constants live in `src/team-server/insights.ts`.

## Coaching snapshots

Some of the coaching signals in `codeburn report` (how often the person corrected the assistant, time to first edit,
files reworked across sessions) are worked out from prompt text and file edits, so they can only be computed on the
person's machine. With `accept_coaching` on, a client that has coaching sharing on uploads one small snapshot a day
after a successful push:

```json
{"captured_at": "...", "coaching": {
  "period": {"label": "Last 30 days", "start": "2026-10-02", "end": "2026-11-01"},
  "user_turns": 40, "corrections": 10, "sessions_with_edits": 6, "median_time_to_first_edit_ms": 480000,
  "reworked_files": {"files_in_3plus_sessions": 2, "max_sessions": 5, "max_edits": 17}
}}
```

Counts only. Prompt text, file names and paths never leave the machine, and the server re-validates every field with
an allow-list and clamps the numbers, so a modified client can't store anything else. Sharing is off by default. A
person turns it on with `codeburn sync setup ... --share-coaching` or `codeburn sync config coaching on`, which, like
findings, needs them to accept the changed consent before automatic sync continues. The local `codeburn report` is
unchanged. Merging people moves the snapshot to the target when it has none, and deleting a person removes it.
