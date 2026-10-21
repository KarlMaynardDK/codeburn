# Installing the client from your team server

The team server can hand out the exact CodeBurn build it was built from, so members never install the upstream
release by accident and everyone stays on the same version. The Docker image does this out of the box: its build stage
runs `npm pack`, and the server serves that tarball.

## Member install

Your admin runs `codeburn team admin add-person` (or `rotate-enrollment`) and sends you the lines it prints.

macOS / Linux:

```sh
curl -fsSL https://codeburn.example.com/install.sh | sh -s -- --token cbe_...
```

Windows PowerShell:

```powershell
& ([scriptblock]::Create((irm https://codeburn.example.com/install.ps1))) -Token cbe_...
```

The script checks for Node.js 22.13+ and npm. Both the public `codeburn` package and `codeburn-team` provide the `codeburn`
command, so if the public package is installed globally it prints "Replacing the public codeburn package with your team's
build" and runs `npm uninstall -g codeburn` first. It then runs `npm install -g https://codeburn.example.com/install/codeburn-team-<version>.tgz`,
then `codeburn sync setup <server> --token <token>` (this shows what will be sent) and `codeburn sync auto enable`.
The installer never passes an accept flag: `auto enable` prints its disclosure and stops until you run
`codeburn sync auto enable --accept` yourself. Without `--token` it only installs the CLI. Add `--detail sessions`
(`-Detail sessions`) to request session-level detail, if the server allows it.

Prefer to read before running? Download the script (`curl -fsSL .../install.sh -o install.sh`), inspect it, then
`sh install.sh --token cbe_...`. The script contains only the server URL and package version; the token is read from
its arguments and is never embedded server-side.

If you already have this build installed, `codeburn sync setup <server> --token <token>` is enough.

## Endpoints

All are unauthenticated `GET`s and return 404 when no client package is configured.

| Path | Content |
| --- | --- |
| `/install.sh`, `/install.ps1` | Generated installers |
| `/install/codeburn-team.tgz` | The latest tarball (`ETag` = sha256, `Cache-Control: no-cache`); `/install/codeburn.tgz` is an alias |
| `/install/codeburn-team-<version>.tgz` | Same file at an immutable URL |

The discovery document also advertises `client_package: {version, sha256, path}`.

## Configuration

- `CODEBURN_TEAM_CLIENT_PACKAGE` / `--client-package <path>`: the tarball. The Docker image sets
  `/app/client/codeburn-team.tgz` and writes a `codeburn-team.json` sidecar (`{version, sha256}`) beside it. Without a valid
  sidecar the server hashes the file and reads the version from the tarball itself.
- `CODEBURN_TEAM_PUBLIC_URL` / `--public-url` / `public_url` in `team-server.json`: the base URL placed in the scripts.
  Set it to your https URL. If unset, the URL is derived from `X-Forwarded-Proto` and `Host`; a `Host` that is not a
  plain hostname or IP with an optional port is rejected with 400, since it ends up in a shell script.

## Package name and versions

The build is published as the npm package `codeburn-team` (the command is still `codeburn`; config directories are
unchanged). The Docker build stamps the version as `<base>-team.<stamp>`, where `<base>` is `package.json`'s version
without any prerelease and `<stamp>` is the `TEAM_BUILD` build argument, or the UTC time `YYYYMMDDHHmm` when it is empty.
`codeburn --version`, the `codeburn-team.json` sidecar and the discovery `client_package.version` all report it.

```sh
TEAM_BUILD=$(date -u +%Y%m%d%H%M) docker compose -f docker-compose.team.yml up -d --build
```

An unchanged `TEAM_BUILD` with unchanged sources reuses the Docker cache and yields the same version, which is correct.
Leaving `TEAM_BUILD` empty on an otherwise cached build also reuses the cached stamp, so set it per release (as above) to
force a new version.

## Updates

1. Pull or change the source and rebuild with a new `TEAM_BUILD` (see above).
2. Members run `codeburn update`.

The server is the source of truth: for a member enrolled with a team server, `codeburn update` reads `client_package`
from the discovery document whenever the advertised version differs from the installed one (so rolling the server back
to an older build also rolls members back); an equal version is reported as up to date. It downloads
`<server>/install/codeburn-team-<version>.tgz` to a temporary file, checks its sha256 against the advertised `sha256`,
and only then runs `npm install -g` on that verified file. On a mismatch it reports `verify_fail` and installs nothing. A `codeburn-team` install that is not enrolled, or whose server advertises no
client package, never installs the public `codeburn@latest`; `update` reports it as skipped. If the server cannot be
reached it reports an error and does not fall back to the public release. Installs made with
Homebrew, pnpm, bun or volta are reported as managed; reinstall with the install script to switch them to npm.
