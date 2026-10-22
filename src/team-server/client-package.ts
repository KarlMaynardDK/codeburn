import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

/** The CLI build this server distributes to team members (an `npm pack` tarball). */
export interface ClientPackage {
  file: string
  version: string
  sha256: string
  size: number
  /** Immutable URL path, /install/codeburn-team-<version>.tgz */
  path: string
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256_RE = /^[0-9a-f]{64}$/

export const isPackageVersion = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && VERSION_RE.test(v)
export const isSha256 = (v: unknown): v is string => typeof v === 'string' && SHA256_RE.test(v)

/** Reads package/package.json out of a gzipped npm tarball. */
export function readTarballVersion(tgz: Buffer): string {
  const tar = gunzipSync(tgz)
  let off = 0
  while (off + 512 <= tar.length) {
    const name = tar.toString('utf-8', off, off + 100).replace(/\0.*$/s, '')
    if (!name) break
    const size = parseInt(tar.toString('utf-8', off + 124, off + 136).replace(/\0.*$/s, '').trim() || '0', 8)
    if (name === 'package/package.json') {
      const pkg = JSON.parse(tar.toString('utf-8', off + 512, off + 512 + size)) as { version?: unknown }
      if (isPackageVersion(pkg.version)) return pkg.version
      throw new Error('package.json in the client package has no valid version')
    }
    off += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('package/package.json not found in the client package')
}

/**
 * Loads the client tarball. A sidecar `<file minus .tgz>.json` ({version, sha256}) written at build
 * time wins when valid and consistent in shape; otherwise both are computed from the tarball.
 * Returns null when the file does not exist; throws when it exists but is unusable.
 */
export function loadClientPackage(file: string): ClientPackage | null {
  if (!existsSync(file) || !statSync(file).isFile()) return null
  const buf = readFileSync(file)
  const computed = createHash('sha256').update(buf).digest('hex')
  let version: string | undefined
  const sidecar = file.replace(/\.tgz$/, '') + '.json'
  if (sidecar !== file && existsSync(sidecar)) {
    try {
      const side = JSON.parse(readFileSync(sidecar, 'utf-8')) as { version?: unknown; sha256?: unknown }
      // The sidecar's hash must match the actual bytes; otherwise it is stale and ignored.
      if (isPackageVersion(side.version) && side.sha256 === computed) version = side.version
    } catch { /* fall back to the tarball */ }
  }
  version ??= readTarballVersion(buf)
  return { file, version, sha256: computed, size: buf.length, path: `/install/codeburn-team-${version}.tgz` }
}

// ---- public URL / Host validation (the result is interpolated into scripts) ----

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/

export function isSafeHost(host: string): boolean {
  if (!HOST_RE.test(host)) return false
  const port = /:(\d{1,5})$/.exec(host.startsWith('[') ? host.slice(host.indexOf(']') + 1) : host)
  return !port || Number(port[1]) <= 65535
}

/** Origin for generated scripts from a request, or null when the Host header is not a plain host[:port]. */
export function originFromRequest(host: string | undefined, forwardedProto: string | undefined, tls: boolean): string | null {
  if (!host || !isSafeHost(host)) return null
  const first = (forwardedProto ?? '').split(',')[0]!.trim().toLowerCase()
  const scheme = first === 'https' || first === 'http' ? first : tls ? 'https' : 'http'
  return `${scheme}://${host}`
}

// ---- installer scripts ----

const MIN_NODE = '22.13'

/** `origin` must already be validated (scheme://safe-host[:port]); nothing else is interpolated. */
export function installShScript(origin: string, pkg: ClientPackage): string {
  const pkgUrl = `${origin}${pkg.path}`
  return `#!/bin/sh
# CodeBurn team client installer, served by ${origin}
# Usage: curl -fsSL ${origin}/install.sh | sh -s -- [--token cbe_...] [--detail summary|sessions]
set -eu

BASE_URL='${origin}'
PKG_URL='${pkgUrl}'
PKG_VERSION='${pkg.version}'

die() { printf 'codeburn install: %s\\n' "$1" >&2; exit 1; }

main() {
  TOKEN=''
  DETAIL=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --token) [ $# -ge 2 ] || die '--token needs a value'; TOKEN="$2"; shift 2 ;;
      --token=*) TOKEN="\${1#--token=}"; shift ;;
      --detail) [ $# -ge 2 ] || die '--detail needs a value'; DETAIL="$2"; shift 2 ;;
      --detail=*) DETAIL="\${1#--detail=}"; shift ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  case "$DETAIL" in ''|summary|sessions) ;; *) die '--detail must be summary or sessions' ;; esac

  command -v node >/dev/null 2>&1 || die 'Node.js ${MIN_NODE}+ is required but node was not found. Install it from https://nodejs.org/ and re-run.'
  command -v npm >/dev/null 2>&1 || die 'npm is required but was not found. Install Node.js from https://nodejs.org/ and re-run.'
  node -e 'var v=process.versions.node.split(".").map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=13)?0:1)' \\
    || die "Node.js ${MIN_NODE}+ is required (found $(node -v)). Update it from https://nodejs.org/ and re-run."

  if npm ls -g codeburn --depth=0 >/dev/null 2>&1; then
    printf 'Replacing the public codeburn package with your team'"'"'s build\\n'
    npm uninstall -g codeburn
  fi

  printf 'Installing CodeBurn %s from %s\\n' "$PKG_VERSION" "$BASE_URL"
  npm install -g "$PKG_URL"

  CB=codeburn
  if ! command -v codeburn >/dev/null 2>&1; then
    CB="$(npm prefix -g)/bin/codeburn"
    [ -x "$CB" ] || die 'installed, but the codeburn command is not on PATH. Add the npm global bin directory to PATH and re-run.'
    printf 'Note: add %s to your PATH to run codeburn directly.\\n' "$(npm prefix -g)/bin"
  fi
  "$CB" --version

  if [ -n "$TOKEN" ]; then
    if [ -n "$DETAIL" ]; then
      "$CB" sync setup "$BASE_URL" --token "$TOKEN" --detail "$DETAIL" </dev/null
    else
      "$CB" sync setup "$BASE_URL" --token "$TOKEN" </dev/null
    fi
    # No accept flag here: automatic sync needs the person's own consent.
    if ! "$CB" sync auto enable </dev/null; then
      printf '\\nAutomatic sync is NOT enabled yet. Read the disclosure above and, if you agree, run:\\n  codeburn sync auto enable --accept\\n'
    fi
  else
    printf '\\nInstalled. To connect this machine, ask your admin for an enrollment token and run:\\n  codeburn sync setup %s --token <token>\\n' "$BASE_URL"
  fi
}

main "$@"
`
}

export function installPs1Script(origin: string, pkg: ClientPackage): string {
  const pkgUrl = `${origin}${pkg.path}`
  return `# CodeBurn team client installer, served by ${origin}
# Usage: & ([scriptblock]::Create((irm ${origin}/install.ps1))) [-Token cbe_...] [-Detail summary|sessions]
[CmdletBinding()]
param(
  [string]$Token = '',
  [ValidateSet('', 'summary', 'sessions')][string]$Detail = ''
)
$ErrorActionPreference = 'Stop'

$BaseUrl = '${origin}'
$PkgUrl = '${pkgUrl}'
$PkgVersion = '${pkg.version}'

function Fail([string]$Message) { throw "codeburn install: $Message" }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js ${MIN_NODE}+ is required but node was not found. Install it from https://nodejs.org/ and re-run.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm is required but was not found. Install Node.js from https://nodejs.org/ and re-run.' }
# Compared in PowerShell rather than in an inline node script: Windows PowerShell 5.1 strips embedded double quotes from native arguments.
$NodeVersion = (& node -v).Trim()
if ($LASTEXITCODE -ne 0 -or [version]$NodeVersion.TrimStart('v') -lt [version]'${MIN_NODE}') { Fail "Node.js ${MIN_NODE}+ is required (found $NodeVersion). Update it from https://nodejs.org/ and re-run." }

$ErrorActionPreference = 'Continue'
& npm ls -g codeburn --depth=0 *> $null
$HasPublic = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = 'Stop'
if ($HasPublic) {
  Write-Host "Replacing the public codeburn package with your team's build"
  & npm uninstall -g codeburn
  if ($LASTEXITCODE -ne 0) { Fail 'npm uninstall -g codeburn failed.' }
}

Write-Host "Installing CodeBurn $PkgVersion from $BaseUrl"
& npm install -g $PkgUrl
if ($LASTEXITCODE -ne 0) { Fail 'npm install failed.' }

$Cb = 'codeburn'
if (-not (Get-Command codeburn -ErrorAction SilentlyContinue)) {
  $prefix = (& npm prefix -g).Trim()
  $shim = Join-Path $prefix 'codeburn.cmd'
  if (-not (Test-Path -LiteralPath $shim)) { Fail 'installed, but the codeburn command is not on PATH. Open a new terminal and re-run.' }
  $Cb = $shim
  Write-Host "Note: add $prefix to your PATH to run codeburn directly."
}
& $Cb --version
if ($LASTEXITCODE -ne 0) { Fail 'codeburn --version failed.' }

if ($Token -ne '') {
  $setupArgs = @('sync', 'setup', $BaseUrl, '--token', $Token)
  if ($Detail -ne '') { $setupArgs += @('--detail', $Detail) }
  & $Cb @setupArgs
  if ($LASTEXITCODE -ne 0) { Fail 'codeburn sync setup failed.' }
  # No accept flag here: automatic sync needs the person's own consent.
  & $Cb sync auto enable
  if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'Automatic sync is NOT enabled yet. Read the disclosure above and, if you agree, run:'
    Write-Host '  codeburn sync auto enable --accept'
  }
} else {
  Write-Host ''
  Write-Host 'Installed. To connect this machine, ask your admin for an enrollment token and run:'
  Write-Host "  codeburn sync setup $BaseUrl --token <token>"
}
`
}

/** Connects an already-installed client; the same line the installers print. */
export function setupCommand(url: string, token: string): string {
  return `codeburn sync setup ${url.replace(/\/$/, '')} --token ${token}`
}

export function installerLines(url: string, token: string): { unix: string; windows: string } {
  const u = url.replace(/\/$/, '')
  return {
    unix: `curl -fsSL ${u}/install.sh | sh -s -- --token ${token}`,
    windows: `& ([scriptblock]::Create((irm ${u}/install.ps1))) -Token ${token}`,
  }
}
