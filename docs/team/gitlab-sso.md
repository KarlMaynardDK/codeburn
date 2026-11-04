# GitLab sign-in and self-registration for the team server viewer

Status: implemented. User-facing setup is in [server.md](server.md#gitlab-sign-in); this is the design spec.

## Context
Today the report viewer at `/` only accepts a viewer key (`cbv_…`, made with `codeburn team admin add-viewer`). Keys are shared secrets with no per-person identity. We're adding an **optional** "Sign in with GitLab" (OAuth2 + OIDC userinfo, PKCE). Viewer-key login stays as it is.

Access rules:
- **Admin**: a member of a configured GitLab group (`admin_groups`). Sees everything, the same as a viewer key.
- **Member**: any user on the GitLab instance whose **verified** email matches a registered, non-revoked person in `people.email`. Sees **only their own data**.
- **Registrant** (optional, off by default): a GitLab user with a verified email who is **not yet** a person on the server, and who is in a configured `register_groups` group. They land on a registration page, type their team, and get a one-time enrollment token plus install instructions. Registering creates their person record, so they become a Member.
- Anyone else is denied.

The GitLab URL is configurable and defaults to `https://gitlab.com`.

## Design

### Config — `src/team-server/config.ts`
- Add an optional `gitlab` block to `TeamServerConfig`:
  `{ url: string; client_id: string; client_secret: string; admin_groups: string[]; register_groups: string[]; register_note?: string }`.
  - `register_groups`: GitLab group paths (subgroups match, as for `admin_groups`) whose members may self-register. Empty means registration is off. The single value `*` allows any user on the instance; the docs warn that on gitlab.com this means anyone with an account.
  - `register_note`: optional free text shown on the registration page after the install instructions (for example, "Questions? Ask in #codeburn"). Plain text only: blank lines split paragraphs and `http(s)://` URLs become links. It is never rendered as HTML.
  - `url` defaults to `https://gitlab.com` and is normalised by `normalizeGitlabUrl`: http(s) only, no credentials, query or fragment, trailing slash removed. A path is kept so instances installed under a subpath work.
- Env overrides go in `applyEnv`, the same way as the other settings: `CODEBURN_TEAM_GITLAB_URL`, `CODEBURN_TEAM_GITLAB_CLIENT_ID`, `CODEBURN_TEAM_GITLAB_CLIENT_SECRET`, `CODEBURN_TEAM_GITLAB_ADMIN_GROUPS`, `CODEBURN_TEAM_GITLAB_REGISTER_GROUPS` (both comma-separated), `CODEBURN_TEAM_GITLAB_REGISTER_NOTE`. The docs will recommend keeping the secret in an env var.
- SSO is enabled only when both `client_id` and `client_secret` are set.
- If SSO is enabled, `public_url` is **required**. The redirect URI is `${public_url}/auth/gitlab/callback` and is never built from the Host header. If `public_url` is missing, `assertServeConfig` (called by `createTeamServer`, after `--public-url` is applied) throws a clear error. It is not checked in `loadConfig`, so admin commands still work while the config is incomplete.

### OAuth module — new `src/team-server/gitlab.ts`
- `startLogin(cfg)` returns `{ location, stateCookie }`. It generates a random `state` and a PKCE `code_verifier` (S256 challenge via `node:crypto`) and builds the URL `${url}/oauth/authorize?client_id&redirect_uri&response_type=code&scope=openid profile email&state&code_challenge&code_challenge_method=S256`.
- `completeLogin(cfg, code, verifier)`:
  1. POSTs `${url}/oauth/token` (with `grant_type=authorization_code` and `code_verifier`).
  2. GETs `${url}/oauth/userinfo` with the bearer token. Both calls use global `fetch` with a timeout.
  3. Returns `{ sub, name, email, email_verified, groups }`.
- `decideAccess(store, cfg, info)` returns `{ role: 'admin', name } | { role: 'member', name, personId } | { role: 'registrant', name, email } | null`. It is a pure decision over the store, so it is easy to unit-test. Rules, in order:
  - **admin**: any `info.groups` entry equals an `admin_groups` path or starts with `path + '/'` (a subgroup). Admins never see the registration page.
  - **member**: `email_verified === true` and exactly one non-revoked person has `lower(email) = lower(info.email)`. More than one match means denied.
  - **registrant**: `email_verified === true`, no person (revoked **or** not) has that email, and the user is in a `register_groups` group (or that list is `*`). A revoked person with the same email is denied, so revoking someone can't be undone by them signing up again.
  - Otherwise denied.
- The state cookie is `cb_team_oauth=<state>.<verifier>; HttpOnly; SameSite=Lax; Path=/auth/gitlab; Max-Age=600` (plus `Secure` when applicable). It must be Lax, because the callback is a cross-site navigation from GitLab.
- Add cookie helpers to `src/team-server/auth.ts` next to `sessionCookie`, and reuse `readCookie`.

### Routes — `src/team-server/server.ts`
These go **outside** `/api/team/*`, because `isSameOriginRequest` would reject the cross-site callback:
- `GET /auth/gitlab/login`: returns a 302 to GitLab and sets the state cookie. Returns 404 when SSO is disabled.
- `GET /auth/gitlab/callback`:
  1. Validates `state` against the cookie with a timing-safe compare, then clears the cookie.
  2. Calls `completeLogin`, then `decideAccess`.
  3. On success, it creates a session, sets the existing `sessionCookie(...)` (Strict), and redirects 302 to `/` (admin, member) or `/register` (registrant).
  4. On failure, it redirects to `/?login_error=denied|failed` and records the failure in the existing `FailureLimiter`, keyed by IP.
- `/auth/` joins the reserved-prefix 404 list for non-static paths.

### Sessions — `src/team-server/store.ts`
- New table in `schemaStatements`, so `CREATE TABLE IF NOT EXISTS` migrates existing databases with no version bump:
  `sso_sessions (token_hash TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, person_id TEXT, subject TEXT NOT NULL, email TEXT, expires_at TEXT NOT NULL)`.
  `email` is set only for registrant sessions (the verified GitLab email the person record will get).
- `loginSso({ name, role, personId, subject, email })` uses a `cbs_` token and the same 12h TTL as `loginViewer`.
- `viewerForSession(token)` now returns `{ name, role: 'admin' | 'member' | 'registrant', personId?: string, email?: string }`.
  - It checks `viewer_sessions` first (role `admin`), then `sso_sessions`.
  - Member sessions JOIN `people` with `revoked_at IS NULL`, so revoking a person ends their SSO access immediately.
- `logoutViewer` deletes from both tables. `prune` also expires `sso_sessions`.
- `registerSelf(sessionToken, team)` runs in one transaction:
  1. Claims the registrant session with `UPDATE … SET role = 'member' … WHERE role = 'registrant' RETURNING name, email`. A second submit on the same session waits on that row and then finds nothing to claim. On PostgreSQL the transaction also takes an advisory lock, so two sessions for the same GitLab user can't race. Any failure rolls the claim back, so the user can fix the team name and retry.
  2. Re-checks that no person has `lower(email)`, so a double submit or two tabs can't create two people.
  3. Resolves the team with `canonicalTeam` (validation, plus reuse of an existing spelling), then does the same inserts as `addPerson({ name, email, team })` and `createEnrollment`.
  4. Upgrades the session in place to `role = 'member'`, `person_id = <new id>`, `email = NULL`.
  5. Returns `{ person, enrollmentToken, expiresAt }`.
- `distinctTeams()`: returns the `team` values of non-revoked people, used to suggest existing teams.

### Self-registration — `/register`
The page is the "Welcome, you're not set up yet" screen for a registrant. It is only reachable with a registrant session, or with a member session for "set up another machine" (below).

What the page shows:
1. A heading with the GitLab name and email, read-only. These come from GitLab and the user can't edit them, so a person can't enrol under someone else's identity.
2. A **Team** text box (required, trimmed, 1–64 characters, no control characters) and a "Create my install token" button.
   - The box is free text. Any new team name is accepted, because the first person from a team creates it. A team exists only as the `team` value on people, so nothing else needs to be set up.
   - Existing teams are offered as suggestions only, through a `<datalist>`, so people pick a consistent spelling. A suggestion never restricts what can be typed.
   - If the typed name matches an existing team except for letter case or surrounding spaces, the existing spelling is used. For example, "platform " becomes "Platform". This keeps one team from being split into two.
3. After submitting, the page replaces the form with:
   - The enrollment token, its expiry (7 days) and a note that it works once, on one machine.
   - Copyable install commands from `installerLines(public_url, token)`: the macOS/Linux `curl … | sh -s -- --token …` line and the Windows PowerShell line, plus "Already have this build installed: `codeburn sync setup <url> --token …`". This is the same text `codeburn team admin add-person` prints, so the CLI and the page can't drift.
   - A line showing what was registered: name, email and team, matching what an admin would have run as `codeburn team admin add-person --name "<name>" --email <email> --team "<team>"`.
   - The `register_note` paragraph(s), if set. The note sits at the bottom of the card, so it is also shown below the team form before submitting.
   - A "Go to my dashboard" link to `/`.
4. If the client package isn't configured (no `/install.sh`), only the `codeburn sync setup` line is shown.

**Set up another machine**: a member (whether self-registered or added by an admin) sees a link to `/register` in the Shell when registration is enabled. There the page skips the team form and offers "Create a new install token", which calls `rotateEnrollment(personId)`. That invalidates any unused token for them and issues a fresh one. This also covers a registrant who refreshed the page and lost the token.

Server side, `/register` is served the dashboard's `index.html`, the same way `/` is, and the React app picks the view.

### API scoping — `src/team-server/api.ts`
- New unauthenticated `GET /api/team/auth-methods` returns `{ key: true, gitlab: boolean, registration: boolean }`. It sits next to the `/login` branch, before the session check.
- **Registrant sessions** may call only `meta`, `logout` and the registration endpoints. Every other `/api/team/*` route returns 403 `registration_required`.
- `GET /api/team/registration` returns:
  - `{ state: 'new', name, email, teams: distinctTeams(), note }` for a registrant.
  - `{ state: 'member', name, email, team, note }` for a member.
  - 404 when registration is off, or for an admin.
- `POST /api/team/registration` with `{ team }`, registrant only:
  - Calls `registerSelf`.
  - Returns `{ token, expires_at, url: public_url, install: installerLines(...) | null, setup: 'codeburn sync setup …' , person: { name, email, team } }`.
  - 400 for an invalid team; 409 if the email was taken meanwhile.
  - Logs `registered <name> <email> team=<team> (<person id>)` to stderr, alongside the server's other log lines, for an audit trail.
  - A member who POSTs gets 409 `already_registered`; a session that is no longer a registrant gets 403 `not_registrant`.
- `POST /api/team/registration/token`, member only: calls `rotateEnrollment`, and returns the same shape as above.
- Both POSTs already get the same-origin check that `/api/team/*` has. They share a per-session `FailureLimiter` (10 per hour, invalid attempts included) so a session can't mint unlimited tokens.
- After `parseFilters`, if `viewer.role === 'member'`, set `filters.person = viewer.personId` and delete `filters.team`. Every rollup and insight query already honours `f.person` (`rollup.ts:29,116,173`, `insights.ts:42,126`), so this one override scopes overview, models, projects, sessions and insights.
- `/api/team/people/:id` returns 404 for a member unless `id === viewer.personId`.
- `/api/team/meta` for a member: `teams: []`, `people` holds only themselves, `person_id` is their id, and `viewer` becomes `{ name, role }`. Admin responses also gain `role: 'admin'`. Every role gets `registration: boolean`, so the UI knows whether to offer "Set up another machine".
- `/api/team/meta` for a registrant: `teams: []`, `people: []`.

### Viewer UI — `dash/src/team/`
- `lib/api.ts`:
  - Add `getAuthMethods()`.
  - Add `viewer.role` to `Meta`.
- `App.tsx`, `Login` component:
  - Fetch the auth methods. When `gitlab` is enabled, show a "Sign in with GitLab" button: a plain link to `/auth/gitlab/login`, with an "or" divider above the key form.
  - Show a message for `?login_error=denied` ("Your GitLab account isn't authorised for this team server") and for `failed`, then strip the query string with `history.replaceState`.
- `App.tsx`, `Shell` component, when `role === 'member'`:
  - Hide the team and person selectors.
  - Replace the People page with the member's own `PersonDetail`.
  - Show a "Set up another machine" link in the header when registration is enabled, and label the People tab "My usage".
- New `Register.tsx`, shown when `role === 'registrant'` or the path is `/register`:
  - The team form, then the result view described above.
  - Copy buttons on the token and each command.
  - The note is rendered with a small `noteToParagraphs` helper: split on blank lines, autolink URLs, and keep everything as React text nodes (no `dangerouslySetInnerHTML`).
- `lib/api.ts` gets `getRegistration()`, `register(team)` and `newInstallToken()`.

### Docs and tests
- `docs/team/server.md` gets a "GitLab sign-in" section:
  - Create a confidential OAuth application (user, group or instance level) with scopes `openid profile email` and redirect URI `<public_url>/auth/gitlab/callback`.
  - The config/env keys.
  - The access rules, including that member access requires the person's enrolled email to match their verified GitLab email.
  - Self-registration: `register_groups`, the `*` warning for gitlab.com, `register_note`, and that revoked people can't re-register.
- Add the `/auth/gitlab/*` routes, `/register`, and the `/api/team/registration*` endpoints to the endpoint list in the same doc.
- `tests/team-server/config.test.ts`: covers gitlab block parsing, env overrides, and the error when `public_url` is missing.
- `tests/team-server/store.test.ts`: covers `loginSso`/`viewerForSession` roles, that revoking a person kills a member session, prune, and logout.
- `tests/team-server/server.test.ts`: starts a local fake GitLab `http` server that serves `/oauth/token` and `/oauth/userinfo`, and points `gitlab.url` at it. Cases:
  - Login redirect contents (state and PKCE present).
  - State mismatch → failed.
  - Admin via group and via subgroup.
  - Member via email: their API calls return only their data; another person's detail returns 404; `meta` is scoped.
  - Unverified or unknown email → denied.
  - `auth-methods` reflects config.
  - Viewer-key login still works unchanged.
  - Registration:
    - With registration off, an unknown user is denied.
    - With registration on, an unknown user in a `register_groups` group is redirected to `/register`; one outside the group is denied.
    - A registrant gets 403 on overview and people.
    - `POST registration` creates a person with GitLab's name and email and the typed team. The returned token enrolls via `/v1/enroll`, and the session is now a member scoped to that person.
    - A second POST returns 409, and no duplicate person is created.
    - A revoked person's email is denied.
    - An invalid team returns 400.
    - A brand-new team name is accepted, and it then shows up in `teams` for the next registrant.
    - A name that differs from an existing team only in letter case or spaces is saved with the existing spelling.
    - The note is returned as given.
    - `registration/token` rotates the token: the old unused token fails and the new one works.
- `tests/team-server/config.test.ts` also covers `register_groups` and `register_note`, from both config and env.
- `tests/team-server/store.test.ts` also covers `registerSelf`: it is atomic, rejects a duplicate email, and upgrades the session.

## Verification
1. `npx vitest run tests/team-server` (or the repo's test script) passes, including the new tests.
2. `npm run build && npm run build:dash` succeeds and the TypeScript compile is clean.
3. Manual end-to-end against gitlab.com:
   - Create an OAuth app, set `public_url=http://localhost:<port>` plus the gitlab env vars, run `codeburn team serve`, and open `/`.
   - Sign in as a group member → full view.
   - Sign in as a user whose email is enrolled → only their data, and no team or person pickers.
   - Sign in as another user → "not authorised" message.
   - Set `register_groups` and `register_note`, then sign in as an unenrolled group member:
     - The registration page shows their GitLab name and email.
     - Entering a team gives a token and install commands, with the note below them.
     - Running the install line enrolls the machine, and `/` then shows their own data.
   - The viewer key still works.
