# Preserving existing OIDC sync on the team-server branch

Status: **open, needs a decision and a fix before `feat/team-server` merges.**
Investigated 2026-10-22 on branch `feat/team-server` (commit `cd60c1c9`, merge base with `main` is `1a3ce74a`).

This note records everything found while checking whether the team-server work breaks the OTLP sync that already
existed on `main`, so the next person doesn't have to repeat the investigation.

## Summary

Pushing still works for existing users of the OIDC/OTLP sync, but **automatic sync silently stops for every existing
user after upgrading**. The cause is the team-server commit (`cd60c1c9`), not the GitLab sign-in work, which never
touched `src/sync/`.

- **What still works:**
  - Existing OIDC configs still send the full span set: session ids, exact timestamps, tools and plugin attributes.
  - Discovery still requires `issuer` and `client_id` for OIDC servers.
  - Manual `codeburn sync push` works.
  - 246 of `main`'s 247 non-skipped sync tests pass against the branch. The one failure is unrelated (see
    [Test evidence](#test-evidence)).
- **What breaks:** the auto-sync consent fingerprint changes for every existing user, for two reasons:
  1. **A false alarm:** an older saved agreement has no detail level, so it is read as `summary`. OIDC users have
     always sent the `sessions` set, so the check wrongly reports "detail level" as raised.
  2. **A real change:** every push now carries two new attributes, `ai.category` (span) and
     `codeburn.detail_level` (resource). Asking for consent again for genuinely new data is what the consent design
     is for.

  Result: `codeburn sync auto run` records `acceptance-required` and pushes nothing until the user runs
  `codeburn sync auto enable --accept` again. The only place this shows is `codeburn sync auto status`.
- **What changes on the wire:** existing OIDC receivers now get `ai.category` and `codeburn.detail_level` on every push,
  manual pushes included. Adding attributes is normally harmless, but a strict receiver could reject or flag it.

## Background: the two sync modes

`codeburn sync setup <url>` reads `<url>/.well-known/codeburn-export.json` and branches on its `auth` field:

| | OIDC (existed on `main`) | Enrollment (new, team server) |
|---|---|---|
| Discovery | `issuer`, `client_id` required | `auth: "enrollment"`, `enroll_path` required |
| Credential | OIDC refresh token (browser PKCE) | device credential `cbd_...` from a one-time `cbe_...` token |
| Saved `authMode` | `'oidc'` on new setups, **absent on configs written by `main`** | `'enrollment'` |
| Default detail level | `sessions` (full span set, the same as `main`) | `summary` (privacy-reduced) |
| Detail levels if server doesn't advertise | `['summary', 'sessions']` | `['summary']` |

The "summary" level (`src/sync/otlp.ts`, `buildOtlpPayload`) rounds timestamps down to the hour, uses a per-device
per-day trace id (`deriveDayBucketTraceId`), and drops session context, tools, plugin attributes and plugin extra spans.

## Findings in detail

### 1. Payload: OIDC users still get the full span set (OK)

- `src/sync/cli.ts:47` `effectiveLevelFor(config)` picks `config.detailLevel ?? legacyDefault`. `legacyDefault` is
  `'sessions'` unless `config.authMode === 'enrollment'`, so configs from `main` (no `authMode`) resolve to `sessions`.
- `src/sync/discovery.ts:127` defaults the advertised levels for an OIDC server to `['summary', 'sessions']`, so the
  clamp in `effectiveDetailLevel` (`discovery.ts:176`) keeps `sessions`.
- `src/sync/otlp.ts:296`: `summary` is true only for `detailLevel === 'summary'`, so OIDC payloads keep session context,
  exact timestamps, tools and plugin data.

### 2. Payload: two attributes are added for everyone (behaviour change)

- **`ai.category`:** `src/sync/push.ts:279` now passes `category: turn.category` for every call, and
  `src/sync/otlp.ts:330` adds `ai.category` whenever `safeCategory()` accepts it (pattern `^[a-z][a-z/_-]{0,31}$`).
  Nothing gates this on the auth mode.
- **`codeburn.detail_level`:** `src/sync/otlp.ts:403` stamps the resource attribute whenever `opts.detailLevel` is set.
  - The `BuildOtlpOptions.detailLevel` doc comment says "When omitted the legacy full span set is built and no
    attribute is stamped". `push.ts:367` repeats the same intent.
  - But both push paths always pass a level: `src/sync/cli.ts:112` (`executePush`, called by `sync auto run` at `cli.ts:1101`) and the
    `sync push` action (`cli.ts:519`, passed to `sendBatches` at `cli.ts:696`). They pass `effectiveLevelFor(...)`,
    which is never undefined.
  - So the "legacy, no attribute" mode exists but is never used.
- Both keys were added to `CORE_SYNC_ATTRIBUTE_KEYS` (`src/sync/otlp.ts:262`) and described in
  `CORE_SYNC_FIELD_MEANINGS` (`src/sync/consent.ts`), which feeds the consent field list.

### 3. Consent: every existing auto-sync agreement stops matching (the breakage)

Auto-sync only pushes if a SHA-256 fingerprint of "what will be sent" equals the fingerprint the user accepted.

- `src/sync/consent.ts:56` `computeAcceptanceFingerprint` hashes a canonical JSON object. On `main` it contained
  `org, destination, contractVersion, outboundFields, workMatching, scopeSinceDays, cadence`.
  - The branch adds `detailLevel: input.detailLevel ?? 'summary'` and `shareFindings: input.shareFindings ?? false`.
  - The JSON shape always differs, so **no fingerprint stored by `main` can ever match**, even for a user whose data
    is unchanged.
  - `WIRE_CONTRACT_VERSION` is still `'v2'` on both, so that isn't what changes.
- `src/sync/cli.ts:154` `buildAcceptanceFingerprintInput` sets `detailLevel: effectiveLevelFor(config)`, which is
  `sessions` for OIDC. `outboundFields` comes from `CORE_SYNC_ATTRIBUTE_KEYS` plus plugin keys, so it now includes
  the two new keys.
- `src/sync/consent.ts:217` `isReductionOnly(stored, current)` is the escape hatch for "sending less". It returns
  false here because:
  - the stored input (from `main`) has no `detailLevel`, so it ranks as `summary` while current ranks `sessions`
    (looks like an increase);
  - the field set grew.
- `src/sync/cli.ts:1035–1050` (`sync auto run`) then appends a receipt
  `{ result: 'acceptance-required', changed }` and returns without pushing.
- `codeburn sync auto status` (`cli.ts:906`) is the only place that surfaces it, via `detectFingerprintChanges`
  (`consent.ts:169`).
- Manual `codeburn sync push` does **not** check consent, so it keeps working, and sends the two new attributes.

**Reproduced.** A small script (below) computed the fingerprint `main` would have stored for a typical OIDC user and
compared it with the branch:

```text
main fingerprint matches branch (same user, no new fields)? false
reduction-only? false
changes reported: [ 'detail level', 'field set (added: ai.category, codeburn.detail_level)' ]
```

The first line shows that even with the field set held constant, the canonical-JSON change alone breaks the match.

Reproduction script (run with `npx tsx fp-check.mts <file-URL of src/sync/consent.ts> <file-URL of src/sync/otlp.ts>`):

```ts
import { createHash } from 'node:crypto'
const branch = await import(process.argv[2])
const otlp = await import(process.argv[3])
// What main stored at `sync auto enable --accept`: main's canonical shape and main's field list.
const mainFields = [...otlp.CORE_SYNC_ATTRIBUTE_KEYS].filter((k: string) => k !== 'ai.category' && k !== 'codeburn.detail_level').sort()
const stored = { org: 'acme', destination: 'https://otel.example.com', outboundFields: mainFields, workMatching: false, scopeSinceDays: 7, cadence: 'daily' as const }
const mainCanonical = { org: stored.org, destination: stored.destination, contractVersion: branch.WIRE_CONTRACT_VERSION, outboundFields: stored.outboundFields, workMatching: false, scopeSinceDays: 7, cadence: 'daily' }
const mainFp = createHash('sha256').update(JSON.stringify(mainCanonical)).digest('hex')
// What the branch computes for the same OIDC user now (legacy default detail level is sessions).
const current = { ...stored, outboundFields: [...otlp.CORE_SYNC_ATTRIBUTE_KEYS].sort(), detailLevel: 'sessions' as const, shareFindings: false }
const sameFieldsOnly = { ...stored, detailLevel: 'sessions' as const, shareFindings: false }
console.log('main fingerprint matches branch (same user, no new fields)?', branch.computeAcceptanceFingerprint(sameFieldsOnly) === mainFp)
console.log('reduction-only?', branch.isReductionOnly(stored, current))
console.log('changes reported:', branch.detectFingerprintChanges(stored, current))
```

### 4. Things checked and found fine

- **Discovery** (`src/sync/discovery.ts:87`): `issuer`/`client_id` are still required and https-checked unless
  `auth === 'enrollment'`. `client_package` is only parsed for enrollment servers.
- **Saved config** (`src/sync/config.ts`): every new field is optional and parsed defensively, so configs from `main`
  load unchanged.
- **Token refresh and logout** branch on `authMode === 'enrollment'`, so missing `authMode` takes the OIDC path.
- **No resend risk:** the fingerprint is for consent only. The sent-ledger that prevents duplicate pushes is separate
  and unchanged.
- **The GitLab sign-in work** (uncommitted on this branch) changed only `src/team-server/*`, `dash/src/team/*`, docs,
  tests and `docker-compose.team.yml`. It doesn't touch the sync client.
  - The only shared code is the new `setupCommand()` helper in `src/team-server/client-package.ts`. It prints the
    same `codeburn sync setup <url> --token <token>` line as before.

## Test evidence

- `main`'s sync test files (`git show main:tests/<file>`, all files matching sync/otlp/cursor-sync) were copied
  temporarily into `tests/__main_*.test.ts` and run against the branch code:
  - 14 files: 11 passed, 2 skipped, 1 failed.
  - Tests: 246 passed, 5 skipped, 1 failed.
  - The temporary files were deleted afterwards.
- **The skipped tests** are `sync-headless-e2e` and `sync-infra-e2e`, which are `describe.skipIf(SKIP)` and need
  external infrastructure.
- **The single failure:**
  - It is `cursor-sync-background.test.ts` › "serve applies the import between requests and stops serving the
    answer it memoized", a 60-second timeout.
  - The branch's own copy of the test fails the same way.
  - Its imports (`src/cursor-import.ts`, `src/cursor-sync.ts`, `src/quota/cursor.ts`, `src/sqlite.ts`) are unchanged
    on the branch, so it is unrelated to sync.
  - Running it on a clean `main` worktree to prove it is pre-existing was attempted. It failed for tooling reasons: a
    junction to the main repo's `node_modules` makes vite-node resolve modules relative to the worktree. A real
    `npm ci` in the worktree would be needed.
- **Coverage gap:** none of the existing tests upgrade a consent agreement written by `main`, which is why this
  passed CI. `tests/sync-enrollment.test.ts:257` tests `isReductionOnly` only with inputs that already carry the new
  fields.

## Recommended fix

Keep the OIDC path identical to `main` on the wire and in consent:

1. **Upgrade-safe fingerprint (`src/sync/consent.ts`):**
   - When a stored `FingerprintInput` has no `detailLevel`, treat it as the legacy default for its mode (`sessions`
     for OIDC).
   - In `computeAcceptanceFingerprint`, include `detailLevel`/`shareFindings` in the canonical JSON only when they
     differ from the legacy defaults, so an unchanged OIDC user hashes exactly as on `main`.
   - The default depends on the auth mode, so the mode, or the resolved legacy default, has to reach these functions.
2. **Legacy wire for OIDC (`executePush` at `src/sync/cli.ts:112`, and the `sync push` action at `:519`/`:696`):**
   - Pass `detailLevel` to `sendBatches` only for enrollment configs, or when an OIDC user explicitly chose a level
     with `codeburn sync detail`. That uses the existing "omit = legacy full set, no attribute" path in
     `buildOtlpPayload`.
   - Send `ai.category` only to team servers: gate `category` in `collectUnsentCalls` (`push.ts:279`) or in
     `buildOtlpPayload` on an option.
   - Keep the consent field list in step: build `outboundFields` from what the mode actually sends, not from all of
     `CORE_SYNC_ATTRIBUTE_KEYS`.
3. **Regression tests:**
   - A consent fingerprint stored by `main` (hard-code the hash, or build `main`'s canonical JSON as in the script
     above) still matches for an unchanged OIDC config, and `sync auto run` pushes.
   - An OIDC push payload from a `main`-era config is identical to `main`'s: no `ai.category`, no
     `codeburn.detail_level`. A golden payload would do.
   - Enrollment configs still get `summary`, `ai.category` and the resource attribute.
4. **If a re-consent is ever needed on purpose:** make it visible. Print a one-line notice from `codeburn sync push`
   or `codeburn status` when `auto` is waiting for acceptance, rather than leaving it only in `sync auto status`.

The alternative is to do only step 1 and let OIDC receivers get `ai.category`. Existing users would then be asked once
to re-accept, because of the genuinely new field. Step 4 is required in that case.

## Open questions

1. Should existing OIDC receivers get `ai.category`?
   - If no, follow the recommended fix and keep OIDC byte-identical to `main`.
   - If yes, existing users must re-accept once, and the prompt has to be visible.
2. Should `codeburn.detail_level` be stamped for OIDC users who explicitly run `codeburn sync detail <level>`? It
   probably should, because that is a deliberate choice, and it changes their consent fingerprint in any case.
3. Are there known OIDC receivers in use (internal collectors, customers) that validate attributes strictly? That
   decides how cautious question 1 needs to be.
4. Should `cursor-sync-background.test.ts` be confirmed failing on a clean `main` (needs `npm ci` in a worktree),
   and tracked separately?

## Related

- Sync design notes: `docs/sync/DEVELOPER.md`, `docs/sync/README.md`.
- Team server and GitLab sign-in: `docs/team/server.md`, `docs/team/gitlab-sso.md`.
