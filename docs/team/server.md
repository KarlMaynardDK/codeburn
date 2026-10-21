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
| `codeburn team admin list` | People, their devices and last-seen time. |
| `codeburn team admin revoke <person-id\|device-id>` | Revoke a person (all devices) or one device. Its credential gets 401 immediately. |
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
  "retention_days": 400,
  "org_name": ""
}
```

- `accept_session_detail`: when false, the discovery document advertises only `summary`, and session-level span
  attributes (`ai.work_unit_id`, `ai.session_role`, `ai.call_count`, `ai.session_duration_ms`) are dropped on ingest
  even if a client sent them. No session rows are stored and the Sessions page returns 404. Turn it on to store
  sessions from clients that push at the `sessions` detail level.
- `accept_findings`: enables `POST /v1/findings` (the latest `codeburn optimize` snapshot per person) and the
  findings section of the Insights page.
- `retention_days`: raw spans, rollups and sessions older than this are pruned on startup and every 24 hours.
- `org_name`: shown in the viewer and in the discovery document.
- `database_url`: optional PostgreSQL URL (see below).
- `public_url`: the externally reachable base URL (`https://codeburn.example.com`, no path) written into the generated
  `/install.sh` and `/install.ps1`. When unset it is derived from the request's `Host` / `X-Forwarded-Proto` headers.

The server can also distribute the exact CLI build it ships with; see [Installing the client from your server](install.md).
`CODEBURN_TEAM_CLIENT_PACKAGE` (or `--client-package <path>`) points at the `npm pack` tarball; the Docker image sets it. The image stamps the package version as `<base>-team.<stamp>` (`TEAM_BUILD` build arg, default the
UTC build time); see the install page.

Each setting except `database_url` can also be set by an environment variable, which wins over the file:
`CODEBURN_TEAM_ACCEPT_SESSION_DETAIL`, `CODEBURN_TEAM_ACCEPT_FINDINGS` (`true`/`false`, `1`/`0`, `on`/`off`),
`CODEBURN_TEAM_RETENTION_DAYS`, `CODEBURN_TEAM_ORG_NAME` and `CODEBURN_TEAM_PUBLIC_URL`. This is the easiest way to configure a container.

Identity always comes from the device credential, never from the payload. Credentials, enrollment tokens and viewer
keys are stored only as SHA-256 hashes. Spans older than 183 days (or more than a day in the future) are rejected.

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

- `GET /.well-known/codeburn-export.json`: discovery (`auth: "enrollment"`, `enroll_path`, `traces_path`,
  `detail_levels`, `findings_path` when enabled, `client_package` when a client package is configured).
- `GET /install.sh`, `GET /install.ps1`, `GET /install/codeburn-team.tgz` (alias `/install/codeburn.tgz`), `GET /install/codeburn-team-<version>.tgz`: client
  distribution, only when a client package is configured (404 otherwise). No authentication.
- `POST /v1/enroll`: `{token, label?, device_id?}` returns `{credential, device_id, person}`; 401 for unknown, used,
  expired or revoked tokens.
- `POST /v1/traces`: OTLP/HTTP JSON, `Authorization: Bearer cbd_...`. Max 1000 spans and 10 MB per request.
  Re-sending a span id overwrites it, so pushes are idempotent. A span id owned by another person is never
  reassigned.
- `POST /v1/findings`: `{captured_at, findings}`, only when `accept_findings` is on.
- `/api/team/*`: viewer API (login, meta, overview, people, models, projects, sessions, insights). "Tokens" in these
  responses are input + output + cache read + cache write; `cache_read_ratio` is cache reads / (input + cache reads).

## Insights rules

- Cache-read ratio below half the team median (people with at least $1 spend, at least 3 such people).
- Premium models (name contains `opus`, `gpt-5`, `o3` or `pro`) above 50% of a person's spend on
  conversation/exploration/general/unknown work.
- A person's last 7 days of spend above 2x the previous 7 days and more than $5 higher.
- Recurring `optimize` findings across the team with total estimated savings (when findings are enabled).

The constants live in `src/team-server/insights.ts`.
