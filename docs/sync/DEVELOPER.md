# Sync — Developer Documentation

Architecture, protocol, server contract, and testing for `codeburn sync`.

## Architecture

```
Developer machine                          Remote backend
──────────────────                         ──────────────
~/.config/codeburn/sync.json  (config)
~/.config/codeburn/.sync-token (credential)
~/.cache/codeburn/sync-ledger.json (sent-ledger)

codeburn sync push
  │
  ├─ Read config → baseUrl, clientId, issuer, tracesPath
  ├─ Read refresh token from OS store
  ├─ POST {issuer}/oauth2/token (refresh_token grant) → access_token
  ├─ Collect ParsedProviderCall[] for window
  ├─ Filter against sent-ledger (only unsent calls)
  ├─ Build OTLP/HTTP JSON payload
  ├─ POST {baseUrl}{tracesPath} with Bearer token
  ├─ On success → append deduplicationKeys to ledger
  └─ Update lastSync in config
```

## Discovery Protocol

### Server discovery document

```
GET {baseUrl}/.well-known/codeburn-export.json
```

```json
{
  "version": 1,
  "issuer": "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_XXXX",
  "client_id": "70e6sgst2ju6ff9dnrmv4l1tcb",
  "scopes": ["openid", "email"],
  "traces_path": "/v1/traces",
  "max_batch_size": 1000
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `version` | No | `1` | Client rejects `version > 1` |
| `issuer` | Yes | — | OIDC issuer URL. Client fetches `{issuer}/.well-known/openid-configuration` |
| `client_id` | Yes | — | OAuth client ID for this deployment |
| `scopes` | No | `["openid"]` | Scopes to request. `offline_access` added dynamically if IdP supports it |
| `traces_path` | No | `/v1/traces` | Path for OTLP POST |
| `max_batch_size` | No | `1000` | Max spans per HTTP request |

### Why not proxy `.well-known/openid-configuration`?

OIDC requires the `issuer` claim inside the discovery doc to match the URL it was fetched from. Serving Cognito's doc from a different domain violates this constraint. The `codeburn-export.json` doc decouples the metrics endpoint from the identity provider.

## OIDC Authentication

### Flow: Authorization Code + PKCE

1. Client generates `code_verifier` (32 random bytes, base64url) and `code_challenge` (SHA-256 of verifier, base64url)
2. Client starts callback server on `127.0.0.1:19876` (fallback: 19877, 19878)
3. Browser opens `{authorization_endpoint}?response_type=code&client_id=...&redirect_uri=http://127.0.0.1:{port}/callback&code_challenge=...&code_challenge_method=S256&state=...&scope=...`
4. User logs in at IdP → IdP redirects to `http://127.0.0.1:{port}/callback?code=...&state=...`
5. Callback server validates `state`, extracts `code`
6. Client POSTs to `{token_endpoint}` with `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, `client_id`
7. IdP returns `access_token` + `refresh_token`

### Fixed ports

Cognito (and Okta) do exact string comparison on callback URLs. Ephemeral ports fail. We register three fixed ports: `19876`, `19877`, `19878`. The client tries in order, falling back if a port is in use.

RFC 8252 recommends `127.0.0.1` (IP literal) over `localhost` to avoid IPv6 `::1` resolution.

### Token refresh

On every `sync push`:
1. Read refresh token from OS store
2. POST `{token_endpoint}` with `grant_type=refresh_token`
3. Store whatever refresh token the server returns (handles rotation transparently)
4. On `invalid_grant` → stop, prompt user to re-run `sync setup`

### Scope resolution

- Request scopes from `codeburn-export.json`
- Add `offline_access` only if `scopes_supported` in OIDC discovery includes it
- Cognito rejects `offline_access` as `invalid_scope` — it issues refresh tokens without it

## Credential Storage

| Platform | Method | Implementation |
|---|---|---|
| macOS | Keychain | `security add-generic-password` / `find-generic-password` |
| Linux | libsecret | `secret-tool store` / `secret-tool lookup` |
| Windows | DPAPI | PowerShell `ConvertTo-SecureString` / `ConvertFrom-SecureString` |
| Fallback | File | `~/.config/codeburn/.sync-token` with `0600` permissions |

No native modules (`keytar` is archived). Shell out to OS CLIs. Fallback reported honestly in `sync status`.

## OTLP Encoding

Strict protobuf-JSON mapping of `ExportTraceServiceRequest`. lowerCamelCase fields, hex-encoded IDs, integer enums.

### Span identity (deterministic)

```
span_id   = first 8 bytes of SHA-256(deduplicationKey) → hex (16 chars)
trace_id  = first 16 bytes of SHA-256(sessionId)       → hex (32 chars)
```

Re-sends are byte-identical. Server-side dedup is defense-in-depth.

### Resource attributes

```json
{
  "resource": {
    "attributes": [
      { "key": "codeburn.device_id", "value": { "stringValue": "<SHA-256(hostname+username)[:16]>" } },
      { "key": "codeburn.coverage_through", "value": { "stringValue": "2026-08-24" } }
    ]
  }
}
```

`codeburn.coverage_through` is optional. It is the ISO date the local corpus is
complete through, taken from the daily-cache watermark, and is stamped only
when a complete local parse finalized that watermark (`complete` and
`watermarkTrusted` both set). Receivers should treat its absence as "coverage
unknown", never as "no history".

### Span attributes

```json
{
  "attributes": [
    { "key": "ai.provider", "value": { "stringValue": "kiro" } },
    { "key": "ai.model", "value": { "stringValue": "claude-sonnet-4-6" } },
    { "key": "ai.input_tokens", "value": { "intValue": "12500" } },
    { "key": "ai.output_tokens", "value": { "intValue": "3200" } },
    { "key": "ai.cost_usd", "value": { "doubleValue": 0.085 } },
    { "key": "ai.project", "value": { "stringValue": "my-app" } },
    { "key": "ai.tools", "value": { "arrayValue": { "values": [{ "stringValue": "Edit" }] } } },
    { "key": "ai.speed", "value": { "stringValue": "standard" } },
    { "key": "ai.cost_estimated", "value": { "boolValue": true } },
    { "key": "ai.work_unit_id", "value": { "stringValue": "ff1b1358ef64c52f80e50e7ae47ca176" } },
    { "key": "ai.session_role", "value": { "stringValue": "child" } },
    { "key": "ai.lineage_evidence", "value": { "stringValue": "provider-recorded" } },
    { "key": "ai.cache_read_tokens", "value": { "intValue": "800" } },
    { "key": "ai.cache_write_tokens", "value": { "intValue": "200" } },
    { "key": "ai.call_count", "value": { "intValue": "3" } },
    { "key": "ai.session_duration_ms", "value": { "intValue": "61000" } },
    { "key": "ai.subscription_covered", "value": { "boolValue": true } }
  ]
}
```

Every attribute from `ai.work_unit_id` down is optional and sent only when its
value is proven; an old receiver ignoring unknown attributes loses nothing:

- `ai.work_unit_id`, `ai.session_role`, `ai.lineage_evidence` are emitted
  together or not at all, and only for sessions whose provider durably
  recorded lineage (#1140). `ai.work_unit_id` is `deriveTraceId` of the root
  session id resolved by the #1145 work-unit resolver: the exact trace-id
  derivation above, so a unit's identity matches the root trace already on the
  wire. Lineage is never inferred: a session without recorded lineage carries
  none of the three, and a child whose parent is out of range (or whose link
  is ambiguous or cyclic) fails closed and carries none either.
- `ai.cache_read_tokens` / `ai.cache_write_tokens` are the provider-recorded
  cache token counts, billable-consistent with `ai.input_tokens` (cache read
  takes the display layer's `max(cacheReadInputTokens, cachedInputTokens)`
  convention across the Anthropic and OpenAI vocabularies). Each is sent only
  when non-zero.
- `ai.call_count` is the number of usage spans the span's session contributes
  in the synced window. `ai.session_duration_ms` is the last-minus-first
  provider-recorded event time of that session, omitted when either timestamp
  is missing or out of order.
- `ai.subscription_covered` is the plan/proxy-path machinery's decision: true
  when a configured plan covers the call's provider or the session's
  provider-recorded cwd sits under a configured proxy path, false when both
  are ruled out, and omitted when the machinery cannot decide (no plan match
  and no cwd to check).

`ai.project` is optional. Usage spans include it only when CodeBurn can derive
one safe basename from a provider-recorded absolute working directory.
Attribution spans derive it only from the normalized `git.repo`; PR-only
evidence omits it. Receivers must group a missing project as unattributed and
must not require the field. When usage and attribution spans for one trace carry
different safe basenames (for example, a fork checkout whose directory name
differs from the upstream repository), the attribution span's normalized
`git.repo` basename is authoritative for project aggregation. The usage cwd
basename is provisional; receivers must not count both as separate projects.

`ai.output_tokens` is the billable output total. For providers that meter
reasoning separately from response tokens, CodeBurn includes that reasoning in
this field; providers whose response count already includes reasoning are left
unchanged.

## Sent-Ledger

Client-side deduplication source of truth at `~/.cache/codeburn/sync-ledger.json`.

Format: JSON array of `{ key: string, ts: string }` objects.

**Push logic**: collect all calls in window → subtract ledger entries → send remainder → append to ledger on success.

**Pruning**: entries older than 6 months removed on every push.

**Why not a watermark?** Timestamp watermarks silently skip late-arriving calls (long sessions, providers that update rows). The ledger is exact.

### Partial success

OTLP returns `partial_success.rejected_spans` in the response body. Because OTLP does not identify *which* spans were rejected, the client ledgers nothing for a partially-rejected batch — the entire batch retries on the next push. This is safe: span IDs are deterministic (derived from the deduplication key), so servers that store by span ID treat re-sent spans as idempotent upserts.

### Rate limiting (429)

A push runs to completion — there is no routine per-push cap (only a 50,000-call safety valve). Server rate limits are the intended brake:

- On HTTP 429 the client honors `Retry-After` (delta-seconds or HTTP-date), capped at 120 seconds per wait, defaulting to 5 seconds when the header is absent
- The same batch is retried up to 3 consecutive times; if the server is still rate-limiting after that, the push stops and the remaining (unledgered) calls are sent on the next push
- On 401 or 5xx the push stops immediately with the same resume-on-next-push behavior

### Server contract

The backend must implement:

1. `GET {baseUrl}/.well-known/codeburn-export.json` — returns the discovery doc (public, no auth)
2. `POST {baseUrl}{traces_path}` — accepts OTLP/HTTP JSON with Bearer token
   - Validate JWT (issued by the configured IdP)
   - Derive developer identity from token's `sub` claim
   - Accept `startTimeUnixNano` up to 6 months in the past
   - Return standard OTLP response body

No PII is included in the payload. The server derives identity solely from the authenticated token.

## Testing

### Unit tests (`tests/sync.test.ts`)

26 tests covering pure functions: discovery parsing, PKCE generation, auth URL construction, scope resolution, callback server, config read/write. No network, no browser.

### Mock IdP e2e (`tests/sync-e2e.test.ts`)

6 tests with a localhost mock IdP server. Exercises the full auth round-trip, token refresh, rotation, revocation — fully offline, runs in CI.

### Headless browser e2e (`tests/sync-headless-e2e.test.ts`)

1 test with Playwright headless Chromium against real Cognito. Proves the actual browser PKCE flow works including Cognito Hosted UI form submission and localhost redirect.

**Developer-only** — requires:
- Deployed test backend (CDK stack at `../codeburn-sync-backend/`)
- Cognito user with confirmed password
- Environment variables: `CODEBURN_SYNC_URL`, `CODEBURN_SYNC_EMAIL`, `CODEBURN_SYNC_PASSWORD`
- Playwright Chromium installed (`PLAYWRIGHT_BROWSERS_PATH`)

Skipped by default when env vars are not set. Never runs in CI.

### Test CDK stack (`codeburn-sync-backend/`)

Minimal AWS backend for the headless e2e test:
- Cognito User Pool (PKCE, fixed callback ports)
- HTTP API with JWT authorizer
- Discovery Lambda (serves `codeburn-export.json`)
- Ingest Lambda (logs OTLP spans to CloudWatch)

Deploy: `npx cdk deploy --profile andklee-dev`
Cost: ~$0/mo idle (pay-per-request)

This is a **test fixture**, not a production reference. Any OIDC provider + OTLP-accepting endpoint satisfies the server contract.

## Enrollment auth (team server)

A discovery doc with `"auth": "enrollment"` selects the self-hosted team server flow instead of OIDC.
`issuer` / `client_id` / `scopes` are then absent; `enroll_path` is required. Optional fields (all additive, version stays 1):
`detail_levels` (`["summary"]` or `["summary","sessions"]`, default `["summary"]` for enrollment servers),
`findings_path` (present only when the server accepts findings), `org_name`, `revoke_path`, `client_package`.
Legacy OIDC docs that omit `detail_levels` are treated as `["summary","sessions"]`, so existing deployments keep receiving the full span set.

`codeburn sync setup <url> --token <enrollment> [--detail summary|sessions] [--share-findings]`:

1. Fetch discovery. If `auth !== "enrollment"` the OIDC browser flow runs unchanged (`--token` is ignored).
2. `POST {enroll_path}` with `{ token, label: <hostname>, device_id: <codeburn device id> }`.
   200 returns `{ credential, device_id, person }`; 401 means the token is invalid, expired or used.
3. The `cbd_...` credential is stored through `credentials.ts` (OS credential storage) and the discovery fields
   (`authMode`, `enrollPath`, `detailLevels`, `findingsPath`, `orgName`) are persisted in `sync.json`.

`sync push` / `sync auto run` use the stored credential directly as `Authorization: Bearer`. There is no refresh grant.
A 401 means the device or person was revoked: the CLI tells the user to run `codeburn sync setup <url> --token <new token>`.

`sync logout` on an enrollment config re-fetches discovery and, when `revoke_path` is advertised, sends
`POST {revoke_path}` with the credential as Bearer; the server revokes that device only. Older servers without
`revoke_path`, or an unreachable server, get a message to ask an admin; the local credential and `sync.json` are
removed either way.

Every discovery refresh stores `client_package` in `sync.json` (`clientPackage`). `sync push` and `sync status`
compare its version with the running CLI (`teamBuildNotice`) and point at `codeburn update` on any difference,
matching update's rule that the server's version wins, including rollbacks.

## Detail levels

Client settings (in `sync.json`): `detailLevel` (`summary` | `sessions`) and `shareFindings`. Change them with
`codeburn sync config detail <summary|sessions>` and `codeburn sync config findings <on|off>`.
The effective level is the client setting clamped to the server's `detail_levels` (`effectiveDetailLevel` in `discovery.ts`).
Enrollment configs default to `summary`; OIDC configs with no explicit choice keep the legacy wire (below).
`sync status` prints the client setting, server-allowed levels, effective level and findings flag.

When a detail level is in effect, every batch carries the resource attribute `codeburn.detail_level` and every usage
span carries `ai.category` (the `ClassifiedTurn.category` of the turn the call belongs to).

**Legacy wire.** An OIDC config with no explicit `detailLevel` whose effective level is `sessions` sends no detail level
at all (`wireDetailLevelFor` in `cli.ts`): the full span set with neither `codeburn.detail_level` nor `ai.category`,
byte for byte what it sent before detail levels existed. Running `codeburn sync config detail <level>` opts the config
into the stamped wire. `tests/sync-oidc-upgrade.test.ts` pins this.

| | `summary` | `sessions` |
|---|---|---|
| `traceId` | first 32 hex of `sha256("<deviceId>:<YYYY-MM-DD>")` (UTC day of the call) | `sha256(sessionId)` as before |
| span start / end | rounded down to the hour | exact (end = start + 1 ms) |
| `ai.work_unit_id`, `ai.session_role`, `ai.lineage_evidence`, `ai.session_duration_ms`, `ai.call_count`, `ai.tools` | omitted | sent when proven |
| plugin attributes / extra spans, attribution spans (`--attribution`) | not sent | sent |
| provider, model, tokens, cost, project basename, `ai.category` | sent | sent |

`spanId` is unchanged (still derived from the deduplication key), so the sent-ledger and server upserts behave identically at both levels.
Prompts, file paths and turn content are never sent at any level. Strings still go through `sanitizeModelIdentifier`,
`sanitizeProviderIdentifier` and `projectBasenameFromWorkingDirectory`.

## Findings upload

When `shareFindings` is on and discovery advertises `findings_path`, after a successful usage push the client
POSTs `{ captured_at, findings }` (`findings` is the same object as `codeburn optimize --format json`, built in-process
by `buildFindingsReport` in `findings.ts`) with the same Bearer. At most once per UTC day (`lastFindingsSent` in `sync.json`).
A failed upload is non-fatal and retried on the next push.

## Consent

The acceptance fingerprint and the disclosure text (`consent.ts`) include the effective detail level and the findings flag.
Raising the level or turning findings on changes the fingerprint, so `sync auto run` records `acceptance-required` until
the user re-runs `codeburn sync auto enable --accept`. `sync auto run` fetches the discovery document and saves the
server's capabilities before it computes the fingerprint, so a server that starts allowing `sessions` or findings
pauses the run instead of getting one push at the higher level. `sync push` and `sync status` print a one-line notice while
automatic sync is paused this way.

On the legacy wire with findings off, the fingerprint input has no `detailLevel` and the canonical JSON leaves both
fields out, so it hashes exactly as acceptances stored before these fields existed and those keep matching. The
outbound field list is what the config actually sends (`coreSyncAttributeKeys` in `otlp.ts`), so it leaves out
`ai.category` and `codeburn.detail_level` on the legacy wire.
