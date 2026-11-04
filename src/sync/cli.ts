/**
 * codeburn sync — CLI commands.
 *
 * Registers: sync setup | push | status | logout | reset
 */

import type { Command } from 'commander'
import { randomBytes } from 'crypto'

import { fetchDiscoveryDoc, DiscoveryError, effectiveDetailLevel, type CodeburnDiscoveryDoc, type DetailLevel } from './discovery.js'
import { enrollDevice, EnrollError, revokeDevice } from './enroll.js'
import { maybeSendFindings } from './findings.js'
import { maybeSendCoaching } from './coaching.js'
import {
  AuthError,
  fetchOidcConfig,
  generatePkce,
  buildAuthUrl,
  resolveScopes,
  startCallbackServer,
  exchangeCode,
  refreshToken,
  revokeToken,
  CALLBACK_PORTS,
} from './auth.js'
import { createCredentialStore } from './credentials.js'
import { readSyncConfig, type SyncConfig, writeSyncConfig, deleteSyncConfig, updateLastSync, receiptsPath, readReceipts, appendReceipt } from './config.js'
import { collectUnsentCalls, collectUnsentAttribution, sendBatches, sendAttributionBatches, batchCalls, MAX_PER_PUSH, MAX_ATTRIBUTION_PER_PUSH, type PushResult } from './push.js'
import { batchAttributionItems, wireProjectName, coreSyncAttributeKeys } from './otlp.js'
import { loadPlugins, declaredSyncAttributes, currentCliVersion, type PluginLoad } from '../plugins/loader.js'
import { collectPluginEnrichment } from '../plugins/exporter.js'
import {
  computeAcceptanceFingerprint,
  buildDisclosure,
  CORE_SYNC_FIELD_MEANINGS,
  detectFingerprintChanges,
  isReductionOnly,
  type FingerprintInput,
  type DisclosureInput,
  type Receipt,
  buildReceipt,
} from './consent.js'
import { autoUpdateBeforeSync, runSelf } from './auto-update.js'
import { installSchedule, removeSchedule, getScheduleStatus } from './schedule-installer.js'

type Config = NonNullable<Awaited<ReturnType<typeof readSyncConfig>>>

/** Detail level that will actually go on the wire for this config. */
function effectiveLevelFor(config: Config, serverLevels: readonly DetailLevel[] | undefined = config.detailLevels): DetailLevel {
  // Legacy OIDC configs (no explicit choice) keep sending the full span set;
  // enrollment configs default to summary.
  const legacyDefault: DetailLevel = config.authMode === 'enrollment' ? 'summary' : 'sessions'
  const allowed = serverLevels ?? (config.authMode === 'enrollment' ? ['summary'] : ['summary', 'sessions'])
  return effectiveDetailLevel(config.detailLevel ?? legacyDefault, allowed)
}

/**
 * Detail level to stamp on the wire, or undefined for the legacy wire. An OIDC
 * config with no explicit level that resolves to sessions sends exactly what it
 * sent before detail levels existed (no codeburn.detail_level, no ai.category),
 * so its receiver and its stored auto-sync acceptance are unaffected.
 */
function wireDetailLevelFor(config: Config, serverLevels: readonly DetailLevel[] | undefined = config.detailLevels): DetailLevel | undefined {
  const level = effectiveLevelFor(config, serverLevels)
  const legacy = config.authMode !== 'enrollment' && config.detailLevel === undefined && level === 'sessions'
  return legacy ? undefined : level
}

/** Every key an automatic push would send for this config, core and plugin, sorted. */
function outboundKeysFor(config: Config, pluginKeys: ReadonlyMap<string, unknown>): string[] {
  return coreSyncAttributeKeys(wireDetailLevelFor(config) !== undefined)
    .concat(Array.from(pluginKeys.keys()))
    .sort()
}

function manualScheduleHint(): string {
  if (process.platform === 'win32') return 'schtasks /Query /TN codeburn-sync (create it with schtasks /Create, running `codeburn sync auto run`)'
  if (process.platform === 'darwin') return 'launchctl load ~/Library/LaunchAgents/com.codeburn.sync-auto.plist'
  return 'systemctl --user enable --now codeburn-sync.timer (or add `codeburn sync auto run` to your crontab)'
}

function reauthMessage(config: Config, context = ''): string {
  return config.authMode === 'enrollment'
    ? `Credential rejected by server${context} (revoked or expired). Re-enroll with: codeburn sync setup ${config.baseUrl} --token <new token>`
    : `Auth rejected by server${context}. Run \`codeburn sync setup\` to re-authenticate.`
}

/** Bearer for the push: the stored device credential (enrollment) or a refreshed OIDC access token. */
async function resolveAccessToken(config: Config, store: ReturnType<typeof createCredentialStore>, stored: string): Promise<{ access_token: string }> {
  if (config.authMode === 'enrollment') return { access_token: stored }
  const oidc = await fetchOidcConfig(config.issuer)
  const tokens = await refreshToken(oidc.token_endpoint, stored, config.clientId)
  if (tokens.refresh_token && tokens.refresh_token !== stored) {
    store.store(tokens.refresh_token)
  }
  return tokens
}

/** Persist server-advertised capabilities when they changed since the last push. */
function refreshServerCapabilities(config: Config, discovery: CodeburnDiscoveryDoc): void {
  const same = JSON.stringify(config.detailLevels ?? null) === JSON.stringify(discovery.detail_levels)
    && config.findingsPath === discovery.findings_path
    && config.coachingPath === discovery.coaching_path
    && JSON.stringify(config.clientPackage ?? null) === JSON.stringify(discovery.client_package ?? null)
  if (same) return
  if (discovery.client_package) config.clientPackage = discovery.client_package
  else delete config.clientPackage
  config.detailLevels = discovery.detail_levels
  if (discovery.findings_path) config.findingsPath = discovery.findings_path
  else delete config.findingsPath
  if (discovery.coaching_path) config.coachingPath = discovery.coaching_path
  else delete config.coachingPath
  writeSyncConfig(config)
}

// Helper for executing the push after data collection
interface ExecutePushInput {
  config: NonNullable<Awaited<ReturnType<typeof readSyncConfig>>>
  unsent: Awaited<ReturnType<typeof collectUnsentCalls>>['unsent']
  attributionUnsent: Awaited<ReturnType<typeof collectUnsentAttribution>>['unsent']
  pluginAttributeKeys: ReadonlySet<string>
  coverageThrough?: string
  tokens: { access_token: string }
  silent?: boolean
  /** Already-fetched discovery doc, when the caller has one. */
  discoveryDoc?: CodeburnDiscoveryDoc
}

async function executePush(input: ExecutePushInput): Promise<{ result: PushResult; attrResult: PushResult | null; attrFacts: number }> {
  const { config, unsent, attributionUnsent, pluginAttributeKeys, coverageThrough, tokens, silent } = input
  const log = silent ? () => {} : (msg: string) => process.stderr.write(`${msg}\n`)

  const discoveryDoc = input.discoveryDoc ?? await fetchDiscoveryDoc(config.baseUrl)
  refreshServerCapabilities(config, discoveryDoc)
  const endpoint = `${config.baseUrl}${config.tracesPath}`
  const detailLevel = effectiveLevelFor(config, discoveryDoc.detail_levels)
  const wireDetailLevel = wireDetailLevelFor(config, discoveryDoc.detail_levels)

  let result: PushResult = { outcome: 'complete', totalSent: 0, totalRejected: 0, totalCostSent: 0 }
  if (unsent.length > 0) {
    const toPush = unsent.slice(0, MAX_PER_PUSH)
    const batches = batchCalls(toPush, discoveryDoc.max_batch_size)
    result = await sendBatches({
      endpoint,
      accessToken: tokens.access_token,
      batches,
      ...(wireDetailLevel ? { detailLevel: wireDetailLevel } : {}),
      ...(coverageThrough ? { coverageThrough } : {}),
      pluginAttributes: { keys: pluginAttributeKeys, values: [] },
      log,
    })
  }

  let attrResult: PushResult | null = null
  let attrFacts = 0
  // Attribution spans carry session ids and commit shas: they are session-level
  // detail and never ship at summary level.
  if (attributionUnsent.length > 0 && result.outcome === 'complete' && detailLevel === 'sessions') {
    const attrToPush = attributionUnsent.slice(0, MAX_ATTRIBUTION_PER_PUSH)
    const attrBatches = batchAttributionItems(attrToPush, discoveryDoc.max_batch_size)
    attrResult = await sendAttributionBatches({
      endpoint,
      accessToken: tokens.access_token,
      batches: attrBatches,
      log,
    })
    attrFacts = attrResult.outcome === 'complete' ? attrResult.totalSent : 0
  }

  if (result.outcome === 'complete') {
    updateLastSync()
    await maybeSendFindings({ config, findingsPath: discoveryDoc.findings_path, bearer: tokens.access_token, log })
    await maybeSendCoaching({ config, coachingPath: discoveryDoc.coaching_path, bearer: tokens.access_token, log })
  }

  return { result, attrResult, attrFacts }
}

// Helper to build FingerprintInput for acceptance checking
function buildAcceptanceFingerprintInput(
  config: NonNullable<Awaited<ReturnType<typeof readSyncConfig>>>,
  allKeys: string[],
  workMatching: boolean,
  cadence: 'daily' | 'hourly',
): FingerprintInput {
  const detailLevel = wireDetailLevelFor(config)
  return {
    org: config.clientId,
    destination: config.baseUrl,
    outboundFields: allKeys,
    workMatching,
    scopeSinceDays: 7,
    cadence,
    ...(detailLevel ? { detailLevel } : {}),
    shareFindings: config.shareFindings === true && !!config.findingsPath,
    ...(config.shareCoaching === true && !!config.coachingPath ? { shareCoaching: true } : {}),
  }
}

/**
 * What changed since the user accepted automatic sync, when that change means
 * `sync auto run` is skipping pushes until they accept again. Null when auto
 * sync is off or still matches.
 */
function pendingAutoAcceptance(config: Config, pluginKeys: ReadonlyMap<string, unknown>): string[] | null {
  const accepted = config.auto?.accepted
  if (!accepted || config.auto?.killed) return null
  const current = buildAcceptanceFingerprintInput(config, outboundKeysFor(config, pluginKeys), accepted.attribution, accepted.cadence)
  if (computeAcceptanceFingerprint(current) === accepted.fingerprint) return null
  if (isReductionOnly(accepted.input, current)) return null
  return detectFingerprintChanges(accepted.input, current)
}

function autoAcceptanceNotice(changed: string[]): string {
  return `Automatic sync is paused: what it would send changed (${changed.join(', ')}). Review and accept with: codeburn sync auto enable --accept\n`
}

/**
 * Points at `codeburn update` when the team server's advertised CLI build
 * differs from this one (as of the last discovery). Any difference counts,
 * matching update's rollback rule. Null otherwise.
 */
export function teamBuildNotice(config: Pick<Config, 'authMode' | 'clientPackage'>, installed = currentCliVersion()): string | null {
  const pkg = config.authMode === 'enrollment' ? config.clientPackage : undefined
  if (!pkg || pkg.version === installed) return null
  return `Your team server has CodeBurn ${pkg.version} (this is ${installed}). Install it with: codeburn update\n`
}

export function registerSyncCommands(program: Command): void {
  const sync = program
    .command('sync')
    .description('Sync AI usage telemetry to a remote OTLP endpoint')

  // --- setup ---
  sync
    .command('setup <url>')
    .description('Configure sync with a remote endpoint (one-time)')
    .option('--token <token>', 'One-time enrollment token (team servers)')
    .option('--detail <level>', 'Detail level to send: summary (default) or sessions')
    .option('--share-findings', 'Upload a daily snapshot of `codeburn optimize` findings (when the server accepts them)')
    .option('--share-coaching', 'Upload a daily snapshot of workflow counts (prompts, corrections, time to first edit, reworked files; no text or paths) when the server accepts them')
    .action(async (url: string, opts: { token?: string; detail?: string; shareFindings?: boolean; shareCoaching?: boolean }) => {
      try {
        const baseUrl = url.replace(/\/$/, '')
        if (opts.detail !== undefined && opts.detail !== 'summary' && opts.detail !== 'sessions') {
          process.stderr.write('Invalid --detail. Use: summary or sessions\n')
          process.exit(1)
        }
        const clientPrefs = {
          ...(opts.detail ? { detailLevel: opts.detail as DetailLevel } : {}),
          shareFindings: opts.shareFindings === true,
          shareCoaching: opts.shareCoaching === true,
        }
        // Setup writes a fresh config, which drops any auto-sync acceptance.
        const previous = readSyncConfig()
        const hadAutoSync = !!previous?.auto?.accepted && !previous.auto.killed
        const autoSyncReminder = 'Automatic sync was on and needs your acceptance again for this endpoint. Until then scheduled runs push nothing: codeburn sync auto enable --accept\n'
        process.stderr.write(`Fetching discovery doc from ${baseUrl}...\n`)

        // 1. Fetch codeburn discovery doc
        const discovery = await fetchDiscoveryDoc(baseUrl)

        if (discovery.auth === 'enrollment') {
          if (!opts.token) {
            process.stderr.write(`\nError: this server uses enrollment. Re-run with --token <enrollment token> from your admin.\n`)
            process.exit(1)
          }
          const enrolled = await enrollDevice(baseUrl, discovery.enroll_path!, opts.token)
          const store = createCredentialStore()
          store.store(enrolled.credential)
          writeSyncConfig({
            baseUrl,
            clientId: discovery.org_name ?? 'codeburn-team',
            tracesPath: discovery.traces_path,
            issuer: '',
            authMode: 'enrollment',
            enrollPath: discovery.enroll_path,
            detailLevels: discovery.detail_levels,
            ...(discovery.findings_path ? { findingsPath: discovery.findings_path } : {}),
            ...(discovery.coaching_path ? { coachingPath: discovery.coaching_path } : {}),
            ...(discovery.org_name ? { orgName: discovery.org_name } : {}),
            ...(discovery.client_package ? { clientPackage: discovery.client_package } : {}),
            ...clientPrefs,
          })
          const cfg = readSyncConfig()!
          process.stderr.write(`\n✓ Device enrolled${enrolled.person?.name ? ` as ${enrolled.person.name}` : ''}.\n`)
          process.stderr.write(`  Endpoint: ${baseUrl}\n`)
          process.stderr.write(`  Credential stored in: ${store.method()}\n`)
          process.stderr.write(`  Detail level: ${cfg.detailLevel ?? 'summary'} (server allows: ${discovery.detail_levels.join(', ')}; effective: ${effectiveLevelFor(cfg)})\n`)
          if (clientPrefs.shareFindings) {
            process.stderr.write(discovery.findings_path
              ? `  Findings sharing: on\n`
              : `  Findings sharing: requested, but this server does not accept findings\n`)
          }
          if (clientPrefs.shareCoaching) {
            process.stderr.write(discovery.coaching_path
              ? `  Coaching stats sharing: on\n`
              : `  Coaching stats sharing: requested, but this server does not accept coaching stats\n`)
          }
          process.stderr.write(`\nRun \`codeburn sync push\` to send telemetry data.\n`)
          if (hadAutoSync) process.stderr.write(autoSyncReminder)
          return
        }
        if (opts.token) {
          process.stderr.write(`Note: --token ignored; this server uses OIDC login.\n`)
        }
        process.stderr.write(`  Issuer: ${discovery.issuer}\n`)
        process.stderr.write(`  Client: ${discovery.client_id}\n`)

        // 2. Fetch OIDC configuration from the issuer
        const oidc = await fetchOidcConfig(discovery.issuer)
        process.stderr.write(`  Auth endpoint: ${oidc.authorization_endpoint}\n`)

        // 3. Resolve scopes
        const scopes = resolveScopes(discovery.scopes, oidc.scopes_supported)

        // 4. Generate PKCE
        const pkce = generatePkce()
        const state = randomBytes(16).toString('hex')

        // 5. Start callback server — await the actually-bound port (port
        // fallback means it may not be the first in CALLBACK_PORTS)
        const { promise: callbackPromise, ready } = startCallbackServer(state)
        // If all ports are in use, BOTH `ready` and `callbackPromise` reject.
        // Mark callbackPromise as handled so the second rejection can't crash
        // the process as an unhandled rejection while we're throwing from
        // `await ready`. The later `await callbackPromise` still throws.
        callbackPromise.catch(() => {})
        const port = await ready
        const redirectUri = `http://127.0.0.1:${port}/callback`

        // 6. Build auth URL and open browser
        const authUrl = buildAuthUrl({
          authorization_endpoint: oidc.authorization_endpoint,
          client_id: discovery.client_id,
          redirect_uri: redirectUri,
          scopes,
          state,
          pkce,
        })

        process.stderr.write(`\nOpening browser for login...\n`)
        process.stderr.write(`If the browser doesn't open, visit:\n  ${authUrl}\n\n`)

        // Open browser (best-effort, platform-specific).
        // execFileSync with args array — authUrl comes from the remote discovery
        // doc so it must never be shell-interpolated. Scheme is also validated.
        try {
          if (!/^https:\/\//.test(authUrl)) {
            throw new Error('auth URL must be https')
          }
          const { execFileSync } = await import('child_process')
          if (process.platform === 'darwin') {
            execFileSync('open', [authUrl], { stdio: 'ignore' })
          } else if (process.platform === 'win32') {
            // Do NOT use `cmd /c start` here: cmd.exe treats `&` as a command
            // separator, so the auth URL's query string gets truncated at the
            // first parameter and the IdP sees a bare /authorize request.
            // rundll32's FileProtocolHandler receives the URL as a plain
            // process argument with no shell parsing, so `&` survives intact.
            execFileSync('rundll32', ['url.dll,FileProtocolHandler', authUrl], { stdio: 'ignore' })
          } else {
            execFileSync('xdg-open', [authUrl], { stdio: 'ignore' })
          }
        } catch {
          // Browser open failed — user sees the URL above
        }

        // 7. Wait for callback
        process.stderr.write(`Waiting for login (5 min timeout)...\n`)
        const callback = await callbackPromise

        // 8. Exchange code for tokens
        const tokenRedirectUri = `http://127.0.0.1:${callback.port}/callback`
        const tokens = await exchangeCode(
          oidc.token_endpoint,
          callback.code,
          pkce.code_verifier,
          tokenRedirectUri,
          discovery.client_id,
        )

        if (!tokens.refresh_token) {
          process.stderr.write(`Warning: IdP did not return a refresh token. You may need to re-authenticate frequently.\n`)
        }

        // 9. Store credentials
        const store = createCredentialStore()
        if (tokens.refresh_token) {
          store.store(tokens.refresh_token)
        }

        // 10. Write config
        writeSyncConfig({
          baseUrl,
          clientId: discovery.client_id,
          tracesPath: discovery.traces_path,
          issuer: discovery.issuer,
          authMode: 'oidc',
          detailLevels: discovery.detail_levels,
          ...(discovery.findings_path ? { findingsPath: discovery.findings_path } : {}),
          ...(discovery.coaching_path ? { coachingPath: discovery.coaching_path } : {}),
          ...clientPrefs,
        })

        process.stderr.write(`\n✓ Sync configured successfully.\n`)
        process.stderr.write(`  Endpoint: ${baseUrl}\n`)
        process.stderr.write(`  Token stored in: ${store.method()}\n`)
        process.stderr.write(`\nRun \`codeburn sync push\` to send telemetry data.\n`)
        if (hadAutoSync) process.stderr.write(autoSyncReminder)
      } catch (err) {
        // Known errors (login timeout, port exhaustion, discovery failures)
        // get a clean one-line message instead of a raw Node crash dump.
        if (err instanceof AuthError || err instanceof DiscoveryError || err instanceof EnrollError) {
          process.stderr.write(`\nError: ${err.message}\n`)
        } else {
          process.stderr.write(`\nError: ${(err as Error).stack ?? (err as Error).message}\n`)
        }
        process.exit(1)
      }
    })

  // --- status ---
  sync
    .command('status')
    .description('Show sync configuration and auth status')
    .action(async () => {
      const config = readSyncConfig()
      if (!config) {
        process.stderr.write('Sync not configured. Run `codeburn sync setup <url>` first.\n')
        process.exit(1)
      }

      const store = createCredentialStore()
      const token = store.retrieve()

      process.stdout.write(`Endpoint: ${config.baseUrl}\n`)
      process.stdout.write(`Traces path: ${config.tracesPath}\n`)
      if (config.authMode === 'enrollment') {
        process.stdout.write(`Auth: enrollment (team server${config.orgName ? `: ${config.orgName}` : ''})\n`)
        process.stdout.write(`Client: ${currentCliVersion()}; automatic CLI updates ${config.autoUpdate === false ? 'off' : 'on'}\n`)
      } else {
        process.stdout.write(`Issuer: ${config.issuer}\n`)
      }
      process.stdout.write(`Credential: ${token ? 'configured' : 'missing (run sync setup)'}\n`)
      process.stdout.write(`Detail level (client setting): ${config.detailLevel ?? (config.authMode === 'enrollment' ? 'summary' : 'sessions (default for OIDC endpoints)')}\n`)
      process.stdout.write(`Detail levels (server allows): ${(config.detailLevels ?? (config.authMode === 'enrollment' ? ['summary'] : ['summary', 'sessions'])).join(', ')}\n`)
      process.stdout.write(`Detail level (effective): ${effectiveLevelFor(config)}\n`)
      process.stdout.write(`Share findings: ${config.shareFindings ? 'on' : 'off'}${config.shareFindings && !config.findingsPath ? ' (server does not accept findings)' : ''}${config.lastFindingsSent ? `, last sent ${config.lastFindingsSent}` : ''}\n`)
      process.stdout.write(`Share coaching: ${config.shareCoaching ? 'on' : 'off'}${config.shareCoaching && !config.coachingPath ? ' (server does not accept coaching stats)' : ''}${config.lastCoachingSent ? `, last sent ${config.lastCoachingSent}` : ''}\n`)
      process.stdout.write(`Token storage: ${store.method()}\n`)
      process.stdout.write(`Last sync: ${config.lastSync ?? 'never'}\n`)
      const buildNotice = teamBuildNotice(config)
      if (buildNotice) process.stderr.write(buildNotice)
      try {
        const pendingAcceptance = pendingAutoAcceptance(config, declaredSyncAttributes(await loadPlugins()))
        if (pendingAcceptance) process.stderr.write(autoAcceptanceNotice(pendingAcceptance))
      } catch { /* plugin load failures are reported by push */ }
    })

  // --- config ---
  const configCmd = sync
    .command('config')
    .description('Change what sync sends (detail level, findings, coaching stats)')

  configCmd
    .command('detail <level>')
    .description('Set the detail level: summary or sessions (clamped to what the server allows)')
    .action((level: string) => {
      const config = readSyncConfig()
      if (!config) {
        process.stderr.write('Sync not configured. Run `codeburn sync setup <url>` first.\n')
        process.exit(1)
      }
      if (level !== 'summary' && level !== 'sessions') {
        process.stderr.write('Invalid level. Use: summary or sessions\n')
        process.exit(1)
      }
      const before = effectiveLevelFor(config)
      config.detailLevel = level
      writeSyncConfig(config)
      const effective = effectiveLevelFor(config)
      process.stdout.write(`Detail level set to ${level}; effective level: ${effective}\n`)
      if (effective !== level) {
        process.stderr.write(`Note: the server only accepts ${(config.detailLevels ?? (config.authMode === 'enrollment' ? ['summary'] : ['summary', 'sessions'])).join(', ')}, so ${effective} is what is sent.\n`)
      }
      if (config.auto?.accepted) {
        process.stderr.write('Automatic sync will pause until you accept the changed disclosure: codeburn sync auto enable --accept\n')
      }
    })

  configCmd
    .command('findings <state>')
    .description('Turn optimize findings sharing on or off')
    .action((state: string) => {
      const config = readSyncConfig()
      if (!config) {
        process.stderr.write('Sync not configured. Run `codeburn sync setup <url>` first.\n')
        process.exit(1)
      }
      if (state !== 'on' && state !== 'off') {
        process.stderr.write('Invalid value. Use: on or off\n')
        process.exit(1)
      }
      const wasOn = config.shareFindings === true
      config.shareFindings = state === 'on'
      writeSyncConfig(config)
      process.stdout.write(`Findings sharing ${state}.\n`)
      if (state === 'on' && !config.findingsPath) {
        process.stderr.write('Note: this server does not currently accept findings; nothing will be uploaded.\n')
      }
      if (config.auto?.accepted) {
        process.stderr.write('Automatic sync will pause until you accept the changed disclosure: codeburn sync auto enable --accept\n')
      }
    })

  configCmd
    .command('coaching <state>')
    .description('Turn coaching stats sharing (counts only) on or off')
    .action((state: string) => {
      const config = readSyncConfig()
      if (!config) {
        process.stderr.write('Sync not configured. Run `codeburn sync setup <url>` first.\n')
        process.exit(1)
      }
      if (state !== 'on' && state !== 'off') {
        process.stderr.write('Invalid value. Use: on or off\n')
        process.exit(1)
      }
      config.shareCoaching = state === 'on'
      writeSyncConfig(config)
      process.stdout.write(`Coaching stats sharing ${state}.\n`)
      if (state === 'on' && !config.coachingPath) {
        process.stderr.write('Note: this server does not currently accept coaching stats; nothing will be uploaded.\n')
      }
      if (config.auto?.accepted) {
        process.stderr.write('Automatic sync will pause until you accept the changed disclosure: codeburn sync auto enable --accept\n')
      }
    })

  configCmd
    .command('all <state>')
    .description('Turn everything the server accepts on (session detail, findings, coaching stats) or off (summary only)')
    .action((state: string) => {
      const config = readSyncConfig()
      if (!config) {
        process.stderr.write('Sync not configured. Run `codeburn sync setup <url>` first.\n')
        process.exit(1)
      }
      if (state !== 'on' && state !== 'off') {
        process.stderr.write('Invalid value. Use: on or off\n')
        process.exit(1)
      }
      const on = state === 'on'
      config.detailLevel = on ? 'sessions' : 'summary'
      config.shareFindings = on
      config.shareCoaching = on
      writeSyncConfig(config)
      process.stdout.write(`Detail level: ${effectiveLevelFor(config)}. Findings sharing ${state}. Coaching stats sharing ${state}.\n`)
      if (on) {
        const skipped = [
          effectiveLevelFor(config) !== 'sessions' ? 'session detail' : '',
          !config.findingsPath ? 'findings' : '',
          !config.coachingPath ? 'coaching stats' : '',
        ].filter(Boolean)
        if (skipped.length) process.stderr.write(`Note: this server does not accept ${skipped.join(', ')}, so those are not sent.\n`)
      }
      if (config.auto?.accepted) {
        process.stderr.write('Automatic sync will pause until you accept the changed disclosure: codeburn sync auto enable --accept\n')
      }
    })

  // --- logout ---
  sync
    .command('logout')
    .description('Remove stored credentials and revoke token')
    .action(async () => {
      const config = readSyncConfig()
      const store = createCredentialStore()
      const token = store.retrieve()

      // A team server device revokes its own credential, so it stops being listed as active.
      if (token && config?.authMode === 'enrollment') {
        const askAdmin = 'Ask your admin to revoke it (`codeburn team admin list` shows it by hostname).'
        try {
          const outcome = await revokeDevice(config.baseUrl, token)
          process.stderr.write(outcome === 'revoked'
            ? 'Device revoked on the team server.\n'
            : outcome === 'unknown'
              ? 'The team server no longer accepts this device; it was already revoked.\n'
              : `This team server can't revoke devices from the client. ${askAdmin}\n`)
        } catch (err) {
          process.stderr.write(`Could not revoke this device on the team server (${(err as Error).message}). ${askAdmin}\n`)
        }
      }

      // Revoke if we have a token and know the revocation endpoint
      if (token && config && config.authMode !== 'enrollment') {
        try {
          const oidc = await fetchOidcConfig(config.issuer)
          if (oidc.revocation_endpoint) {
            await revokeToken(oidc.revocation_endpoint, token, config.clientId)
            process.stderr.write('Token revoked at IdP.\n')
          }
        } catch {
          // Best-effort revocation
        }
      }

      store.delete()
      deleteSyncConfig()
      process.stderr.write('Sync credentials and config removed.\n')
    })

  // --- reset ---
  sync
    .command('reset')
    .description('Clear the sent-ledger (next push re-sends all calls in window)')
    .option('--confirm', 'Required to confirm reset')
    .action(async (opts: { confirm?: boolean }) => {
      if (!opts.confirm) {
        process.stderr.write('This will clear the sent-ledger, causing the next push to re-send all data.\n')
        process.stderr.write('Run with --confirm to proceed.\n')
        process.exit(1)
      }

      const { clearLedger } = await import('./ledger.js')
      const removed = clearLedger()
      if (removed > 0) {
        process.stderr.write(`Ledger cleared (${removed} entries). Next push will re-send all calls in window.\n`)
      } else {
        process.stderr.write('No ledger entries found (nothing to reset).\n')
      }
    })

  // --- push (placeholder for Step 2) ---
  sync
    .command('push')
    .description('Push unsent telemetry data to the configured endpoint')
    .option('--since <period>', 'Time window: today, 7d, 30d, month, all (max 6 months)', '7d')
    .option('--dry-run', 'Show what would be sent without sending')
    .option('--attribution', 'Also push git attribution spans (session→commit correlation from `codeburn yield`, plus PR links). Sends normalized repo remotes and commit SHAs to the endpoint.')
    .action(async (opts: { since: string; dryRun?: boolean; attribution?: boolean }) => {
      const config = readSyncConfig()
      if (!config) {
        process.stderr.write('Sync not configured. Run `codeburn sync setup <url>` first.\n')
        process.exit(1)
      }

      const store = createCredentialStore()
      const rt = store.retrieve()
      if (!rt) {
        process.stderr.write(config.authMode === 'enrollment'
          ? `No device credential found. Enroll with: codeburn sync setup ${config.baseUrl} --token <token>\n`
          : 'No auth token found. Run `codeburn sync setup` to authenticate.\n')
        process.exit(1)
      }

      // Enrollment: the stored credential is the Bearer. OIDC: refresh grant.
      try {
        const tokens = await resolveAccessToken(config, store, rt)

        // Server capabilities (detail levels, findings). Tolerate an unreachable
        // discovery doc here; the send path below surfaces that as before.
        let discoveryDoc: CodeburnDiscoveryDoc | undefined
        try {
          discoveryDoc = await fetchDiscoveryDoc(config.baseUrl)
          refreshServerCapabilities(config, discoveryDoc)
        } catch { /* handled at send time */ }
        const detailLevel = effectiveLevelFor(config, discoveryDoc?.detail_levels ?? config.detailLevels)
        const wireDetailLevel = wireDetailLevelFor(config, discoveryDoc?.detail_levels ?? config.detailLevels)

        if (opts.dryRun) {
          process.stderr.write(`[dry-run] Auth: valid (Bearer token obtained)\n`)
        }

        // Collect data
        const { parseAllSessions } = await import('../parser.js')
        const { getDateRange } = await import('../cli-date.js')

        // Map --since to a parser period. Strict: unknown values are an error.
        const sinceToPeriod: Record<string, string> = {
          'today': 'today',
          '7d': 'week', 'week': 'week',
          '30d': '30days', '30days': '30days',
          'month': 'month',
          'all': 'all', // up to 6 months (parser retention limit)
        }
        const period = sinceToPeriod[opts.since]
        if (!period) {
          process.stderr.write(`Unknown --since value "${opts.since}". Valid: today, 7d, 30d, month, all.\n`)
          process.exit(1)
        }
        const { range } = getDateRange(period)
        // No provider scope, so parseAllSessions applies the shared
        // aggregate-only rule: gateway daily aggregates are not pushed unless
        // the user opted in. The backend would double count them exactly the
        // way a local headline would. Payload schema is unchanged either way.
        const projects = (await parseAllSessions(range))
          .map(p => ({ ...p, project: wireProjectName(p.projectPath, p.project) }))

        // Local-only inputs to the CB-3 fields: configured plans decide
        // ai.subscription_covered; the daily-cache watermark stamps
        // codeburn.coverage_through (only when a complete parse finalized it).
        const { readPlans } = await import('../config.js')
        const plans = await readPlans()
        const { loadDailyCache } = await import('../daily-cache.js')
        const dailyCache = await loadDailyCache()
        const coverageThrough = dailyCache.complete === true && dailyCache.watermarkTrusted === true && dailyCache.lastComputedDate
          ? dailyCache.lastComputedDate
          : undefined

        // Flatten + filter against sent-ledger
        const { allCalls, unsent, held, frozen } = collectUnsentCalls(projects, Date.now(), { plans })

        // Plugin socket: load declared sync attribute keys once for the dry-run
        // disclosure and the real-push wire guard. Loader is directory-stat only
        // when no plugins are installed, so the no-plugin case is byte-identical
        // to before the socket shipped.
        const pluginLoads: PluginLoad[] = await loadPlugins()
        const pluginKeys = declaredSyncAttributes(pluginLoads)
        const pluginAttributeKeys: ReadonlySet<string> = new Set(pluginKeys.keys())

        // Attribution records (opt-in): session→commit correlation computed
        // locally from the same parsed projects. Reuses the yield engine.
        let attributionUnsent: Awaited<ReturnType<typeof collectUnsentAttribution>>['unsent'] = []
        let attributionTotal = 0
        if (opts.attribution && detailLevel === 'summary') {
          process.stderr.write('Skipping --attribution: it links sessions to commits and needs the sessions detail level (codeburn sync config detail sessions).\n')
        } else if (opts.attribution) {
          const { computeAttributionRecords } = await import('../yield.js')
          const records = computeAttributionRecords(projects, range, process.cwd())
          const collected = collectUnsentAttribution(records)
          attributionUnsent = collected.unsent
          attributionTotal = collected.allItems.length
        }

        if (opts.dryRun) {
          const toPushCount = Math.min(unsent.length, MAX_PER_PUSH)
          const cost = unsent.slice(0, MAX_PER_PUSH).reduce((s, c) => s + c.call.costUSD, 0)
          process.stderr.write(`[dry-run] Window: ${opts.since} — ${allCalls.length} calls total, ${allCalls.length - unsent.length - held.length - frozen.length} already synced\n`)
          if (held.length > 0) {
            process.stderr.write(`[dry-run] ${held.length} calls held: their session is still reconciling and its values can still change (#988). They push once it settles.\n`)
          }
          if (frozen.length > 0) {
            process.stderr.write(`[dry-run] ${frozen.length} Copilot calls frozen: their sessions were already synced in the other shape (rollup vs per-request), and a usage span cannot be retracted. See docs/sync/README.md.\n`)
          }
          process.stderr.write(`[dry-run] Detail level: ${detailLevel}${detailLevel === 'summary' ? ' (no session ids, tools or durations; hour-rounded times)' : ''}; findings sharing: ${config.shareFindings && (discoveryDoc?.findings_path ?? config.findingsPath) ? 'on' : 'off'}; coaching stats sharing: ${config.shareCoaching && (discoveryDoc?.coaching_path ?? config.coachingPath) ? 'on' : 'off'}\n`)
          process.stderr.write(`[dry-run] Would push ${toPushCount} calls ($${cost.toFixed(2)}) to ${config.baseUrl}${config.tracesPath}\n`)
          const toPushList = unsent.slice(0, MAX_PER_PUSH)
          const withLineage = toPushList.filter(c => c.session?.workUnitId !== undefined).length
          const withCacheTokens = toPushList.filter(c =>
            Math.max(c.call.usage.cacheReadInputTokens, c.call.usage.cachedInputTokens) > 0
            || c.call.usage.cacheCreationInputTokens > 0).length
          const covered = toPushList.filter(c => c.session?.subscriptionCovered === true).length
          const uncovered = toPushList.filter(c => c.session?.subscriptionCovered === false).length
          process.stderr.write(`[dry-run] Fields: ${withLineage}/${toPushCount} spans carry lineage (ai.work_unit_id/session_role/lineage_evidence), ${withCacheTokens} carry cache tokens, ai.subscription_covered true on ${covered} / false on ${uncovered} / omitted on ${toPushCount - covered - uncovered}; codeburn.coverage_through: ${coverageThrough ?? 'unavailable'}\n`)

          // Plugin socket disclosure (teams issue #3): a member sees every
          // loaded plugin and every declared sync attribute, so a plugin
          // cannot widen the wire silently. Empty socket => line is omitted.
          const loadedPlugins = pluginLoads.filter(l => l.status === 'loaded')
          const rejectedPlugins = pluginLoads.filter(l => l.status === 'rejected')
          if (loadedPlugins.length > 0 || rejectedPlugins.length > 0) {
            const loadedSummary = loadedPlugins.map(l => {
              const attrs = l.manifest.capabilities.syncAttributes
              return attrs.length > 0
                ? `${l.manifest.name}@${l.manifest.version} [${attrs.map(a => `${a.key} - ${a.disclosure}`).join('; ')}]`
                : `${l.manifest.name}@${l.manifest.version} (no sync attributes declared)`
            }).join(' | ')
            process.stderr.write(`[dry-run] Plugins loaded: ${loadedPlugins.length} (${loadedSummary})\n`)
            if (rejectedPlugins.length > 0) {
              const rejectedSummary = rejectedPlugins.map(l => `${l.name} (${l.reason})`).join('; ')
              process.stderr.write(`[dry-run] Plugins rejected: ${rejectedPlugins.length} (${rejectedSummary})\n`)
            }
          }

          // Plugin exporter disclosure: show which loaded plugins have exporters
          // and what they would contribute
          const pluginEnrichmentDry = await collectPluginEnrichment(pluginLoads, toPushList)
          const { stat: statFn } = await import('fs/promises')
          const exporterPlugins: Array<PluginLoad & { status: 'loaded' }> = []
          for (const l of loadedPlugins) {
            try {
              await statFn(`${l.dir}/exporters/sync.mjs`)
              exporterPlugins.push(l as PluginLoad & { status: 'loaded' })
            } catch {
              // no exporter
            }
          }
          if (exporterPlugins.length > 0) {
            const exporterSummary = exporterPlugins.map(l => {
              const callCount = pluginEnrichmentDry.perCall.size
              const spanCount = pluginEnrichmentDry.extraSpans.length
              return `${l.manifest.name} would contribute attributes for ${callCount} calls and ${spanCount} extra spans`
            }).join('; ')
            process.stderr.write(`[dry-run] Plugin exporters: ${exporterSummary}\n`)
          }
          if (unsent.length > MAX_PER_PUSH) {
            process.stderr.write(`[dry-run] ${unsent.length - MAX_PER_PUSH} more calls exceed the ${MAX_PER_PUSH} safety limit — a second push would be needed\n`)
          }
          if (opts.attribution) {
            const toPushAttr = attributionUnsent.slice(0, MAX_ATTRIBUTION_PER_PUSH)
            const commits = toPushAttr.filter(i => i.kind === 'commit').length
            const sessions = toPushAttr.filter(i => i.kind === 'session').length
            process.stderr.write(`[dry-run] Attribution: ${attributionTotal} facts total, would push ${toPushAttr.length} (${sessions} sessions, ${commits} commits)\n`)
            if (attributionUnsent.length > MAX_ATTRIBUTION_PER_PUSH) {
              process.stderr.write(`[dry-run] ${attributionUnsent.length - MAX_ATTRIBUTION_PER_PUSH} more attribution facts exceed the ${MAX_ATTRIBUTION_PER_PUSH} safety limit — a second push would be needed\n`)
            }
          }
          return
        }

        if (unsent.length === 0 && attributionUnsent.length === 0) {
          const pendingNote = [
            held.length > 0 ? `${held.length} held while their session is still reconciling` : '',
            frozen.length > 0 ? `${frozen.length} frozen behind an already-synced rollup` : '',
          ].filter(Boolean).join(', ')
          process.stderr.write(pendingNote
            ? `Nothing to push yet (${allCalls.length - held.length - frozen.length} calls already synced, ${pendingNote}).\n`
            : `Nothing to push (${allCalls.length} calls already synced).\n`)
          updateLastSync()
          await maybeSendFindings({ config, findingsPath: discoveryDoc?.findings_path, bearer: tokens.access_token, log: msg => process.stderr.write(`${msg}\n`) })
          await maybeSendCoaching({ config, coachingPath: discoveryDoc?.coaching_path, bearer: tokens.access_token, log: msg => process.stderr.write(`${msg}\n`) })
          const buildNotice = teamBuildNotice(config)
          if (buildNotice) process.stderr.write(buildNotice)
          return
        }

        // Safety valve (not a routine cap — pushes run to completion)
        const toPush = unsent.slice(0, MAX_PER_PUSH)
        if (unsent.length > MAX_PER_PUSH) {
          process.stderr.write(`${unsent.length} unsent calls exceed the ${MAX_PER_PUSH} safety limit. Pushing first ${MAX_PER_PUSH}; run again to continue.\n`)
        }

        // Batch and send (loops until done; waits out 429 rate limits)
        const sendDiscovery = discoveryDoc ?? await fetchDiscoveryDoc(config.baseUrl)
        const endpoint = `${config.baseUrl}${config.tracesPath}`

        let result: PushResult = { outcome: 'complete', totalSent: 0, totalRejected: 0, totalCostSent: 0 }
        if (toPush.length > 0) {
          const batches = batchCalls(toPush, sendDiscovery.max_batch_size)

          // Collect per-call attributes and extra spans from plugin exporters
          const pluginEnrichment = await collectPluginEnrichment(pluginLoads, toPush)

          result = await sendBatches({
            endpoint,
            accessToken: tokens.access_token,
            batches,
            ...(wireDetailLevel ? { detailLevel: wireDetailLevel } : {}),
            ...(coverageThrough ? { coverageThrough } : {}),
            // Empty values array is the no-plugin-runtime case: the wire guard
            // in otlp.ts drops everything when `values` is empty, so the wire
            // is byte-identical until a real plugin supplies attrs.
            pluginAttributes: { keys: pluginAttributeKeys, values: [] },
            ...(pluginEnrichment.perCall.size > 0 || pluginEnrichment.extraSpans.length > 0 ? { pluginEnrichment } : {}),
            log: msg => process.stderr.write(`${msg}\n`),
          })
        }

        if (result.outcome === 'auth-rejected') {
          process.stderr.write(`${reauthMessage(config)}\n`)
          process.exit(1)
        }
        if (result.outcome === 'rate-limited') {
          process.stderr.write(`Rate limited — gave up after repeated retries. Remaining calls will be sent on the next push.\n`)
        }
        if (result.outcome === 'server-error') {
          process.stderr.write(`Server error (HTTP ${result.httpStatus}). Remaining calls will be sent on the next push.\n`)
        }

        // Attribution spans ride the same endpoint after the usage push
        // completes. Skipped when the usage push hit rate limits or server
        // errors — the endpoint is already unhappy; both retry on next push.
        let attrResult: PushResult | null = null
        if (opts.attribution && attributionUnsent.length > 0) {
          if (result.outcome === 'complete') {
            // Safety valve, mirroring the usage-call cap
            const attrToPush = attributionUnsent.slice(0, MAX_ATTRIBUTION_PER_PUSH)
            if (attributionUnsent.length > MAX_ATTRIBUTION_PER_PUSH) {
              process.stderr.write(`${attributionUnsent.length} attribution facts exceed the ${MAX_ATTRIBUTION_PER_PUSH} safety limit. Pushing first ${MAX_ATTRIBUTION_PER_PUSH}; run again to continue.\n`)
            }
            const attrBatches = batchAttributionItems(attrToPush, sendDiscovery.max_batch_size)
            attrResult = await sendAttributionBatches({
              endpoint,
              accessToken: tokens.access_token,
              batches: attrBatches,
              log: msg => process.stderr.write(`${msg}\n`),
            })
            if (attrResult.outcome === 'auth-rejected') {
              process.stderr.write(`${reauthMessage(config, ' during attribution push')}\n`)
              process.exit(1)
            }
            if (attrResult.outcome === 'rate-limited') {
              process.stderr.write(`Rate limited during attribution push — gave up after repeated retries. Remaining facts will be sent on the next push.\n`)
            }
            if (attrResult.outcome === 'server-error') {
              process.stderr.write(`Server error (HTTP ${attrResult.httpStatus}) during attribution push. Remaining facts will be sent on the next push.\n`)
            }
          } else {
            process.stderr.write(`Skipping attribution push (${attributionUnsent.length} facts) — will retry on next push.\n`)
          }
        }

        // Update lastSync
        updateLastSync()

        // Findings ride after a successful usage push, at most once a day.
        if (result.outcome === 'complete') {
          await maybeSendFindings({ config, findingsPath: sendDiscovery.findings_path, bearer: tokens.access_token, log: msg => process.stderr.write(`${msg}\n`) })
          await maybeSendCoaching({ config, coachingPath: sendDiscovery.coaching_path, bearer: tokens.access_token, log: msg => process.stderr.write(`${msg}\n`) })
        }

        // Summary
        process.stderr.write(`\nSynced ${result.totalSent} calls ($${result.totalCostSent.toFixed(2)}) to ${config.baseUrl}\n`)
        if (attrResult) {
          const attrSuffix = attrResult.outcome !== 'complete'
            ? ` (push incomplete — remainder retries next push)`
            : attrResult.totalRejected > 0 ? `, ${attrResult.totalRejected} rejected (will retry)` : ''
          process.stderr.write(`  Attribution: ${attrResult.totalSent} facts synced${attrSuffix}\n`)
        }
        if (result.totalRejected > 0) {
          process.stderr.write(`  ${result.totalRejected} spans rejected (will retry on next push)\n`)
        }
        if (unsent.length > MAX_PER_PUSH) {
          process.stderr.write(`  ${unsent.length - MAX_PER_PUSH} calls remaining (safety limit). Run \`codeburn sync push\` again.\n`)
        }
        const pendingAcceptance = pendingAutoAcceptance(config, pluginKeys)
        if (pendingAcceptance) process.stderr.write(autoAcceptanceNotice(pendingAcceptance))
        const buildNotice = teamBuildNotice(config)
        if (buildNotice) process.stderr.write(buildNotice)

        // Non-zero exit when the push did not complete, so cron/scripts can
        // detect it. Ledgered progress is kept; next push resumes.
        if (result.outcome !== 'complete' || (attrResult !== null && attrResult.outcome !== 'complete')) {
          process.exitCode = 1
        }
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`)
        process.exit(1)
      }
    })

  // --- auto (parent) ---
  const auto = sync
    .command('auto')
    .description('Manage automatic scheduled pushes')

  // --- auto enable ---
  auto
    .command('enable')
    .description('Enable automatic scheduled pushes (requires --accept to proceed)')
    .option('--cadence <cadence>', 'Schedule frequency: daily or hourly', 'daily')
    .option('--attribution', 'Also send work-matching data (session-to-commit links)')
    .option('--accept', 'Accept the disclosure and enable automatic sync')
    .action(async (opts: { cadence?: string; attribution?: boolean; accept?: boolean }) => {
      const config = readSyncConfig()
      if (!config) {
        process.stderr.write('Sync not configured. Run `codeburn sync setup <url>` first.\n')
        process.exit(1)
      }

      const cadence = opts.cadence as 'daily' | 'hourly'
      if (cadence !== 'daily' && cadence !== 'hourly') {
        process.stderr.write('Invalid --cadence. Use: daily or hourly\n')
        process.exit(1)
      }

      try {
        const pluginLoads: PluginLoad[] = await loadPlugins()
        const pluginKeys = declaredSyncAttributes(pluginLoads)
        const allKeys = outboundKeysFor(config, pluginKeys)

        const fieldList = allKeys.map(key => {
          const plugin = pluginKeys.get(key)
          const disclosure = plugin?.disclosure ?? CORE_SYNC_FIELD_MEANINGS.get(key) ?? '(no description)'
          return { key, disclosure }
        })

        const workMatching = opts.attribution ?? false
        const fingerprintInput = buildAcceptanceFingerprintInput(config, allKeys, workMatching, cadence)
        const fingerprint = computeAcceptanceFingerprint(fingerprintInput)

        const disclosureInput: DisclosureInput = {
          destination: config.clientId,
          destinationUrl: config.baseUrl,
          cadence,
          outboundFields: fieldList,
          workMatching,
          scopeSinceDays: 7,
          detailLevel: fingerprintInput.detailLevel,
          shareFindings: fingerprintInput.shareFindings,
          shareCoaching: fingerprintInput.shareCoaching,
        }

        const disclosure = buildDisclosure(disclosureInput)
        process.stdout.write(disclosure + '\n\n')

        if (!opts.accept) {
          process.stderr.write('Re-run with --accept to consent to exactly this.\n')
          process.exit(1)
        }

        config.auto = {
          accepted: {
            fingerprint,
            acceptedAt: new Date().toISOString(),
            cadence,
            disclosure,
            attribution: workMatching,
            input: fingerprintInput,
          },
          killed: false,
        }
        delete config.auto.killed
        writeSyncConfig(config)

        try {
          await installSchedule(cadence, process.execPath, process.argv[1])
          process.stdout.write(`Automatic sync enabled (${cadence}). Fingerprint: ${fingerprint}\n`)
        } catch (schedErr) {
          process.stderr.write(`Warning: ${(schedErr as Error).message}\n`)
          process.stderr.write(`Acceptance was stored and will take effect, but the schedule could not be installed.\n`)
          process.stderr.write(`Run: codeburn sync auto enable --cadence ${cadence} --attribution${opts.attribution ? '' : ''}\n`)
          process.stderr.write(`Or install manually: ${manualScheduleHint()}\n`)
          process.exit(1)
        }
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`)
        process.exit(1)
      }
    })

  // --- auto updates ---
  auto
    .command('updates [state]')
    .description('Show, or turn on/off, installing the team build before each scheduled push')
    .action((state?: string) => {
      const config = readSyncConfig()
      if (!config) {
        process.stderr.write('Sync is not configured. Run: codeburn sync setup <url> --token <token>\n')
        process.exitCode = 1
        return
      }
      if (state !== undefined) {
        if (state !== 'on' && state !== 'off') {
          process.stderr.write('Usage: codeburn sync auto updates [on|off]\n')
          process.exitCode = 1
          return
        }
        config.autoUpdate = state === 'on'
        writeSyncConfig(config)
      }
      const applies = config.authMode === 'enrollment'
      process.stdout.write(`Automatic CLI updates: ${config.autoUpdate === false ? 'off' : 'on'}${applies ? '' : ' (only applies to team-server enrollments)'}\n`)
    })

  // --- auto disable ---
  auto
    .command('disable')
    .description('Disable automatic scheduled pushes (kill switch)')
    .action(async () => {
      const config = readSyncConfig()
      if (!config) {
        process.stderr.write('Sync not configured.\n')
        return
      }

      if (!config.auto?.accepted) {
        process.stdout.write('Automatic sync was not enabled.\n')
        return
      }

      config.auto.killed = true
      writeSyncConfig(config)

      try {
        await removeSchedule()
      } catch {
        // Best effort
      }

      process.stdout.write('Automatic sync disabled.\n')
    })

  // --- auto status ---
  auto
    .command('status')
    .description('Show automatic sync status and recent receipts')
    .option('--json', 'Output as machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const config = readSyncConfig()

      let currentMatches: boolean | undefined
      let changed: string[] = []
      const accepted = config?.auto?.accepted

      // Recompute fingerprint to check for changes
      if (accepted) {
        try {
          const pluginLoads: PluginLoad[] = await loadPlugins()
          const pluginKeys = declaredSyncAttributes(pluginLoads)
          const allKeys = outboundKeysFor(config, pluginKeys)

          const fingerprintInput = buildAcceptanceFingerprintInput(config, allKeys, accepted.attribution, accepted.cadence)
          const currentFingerprint = computeAcceptanceFingerprint(fingerprintInput)
          currentMatches = currentFingerprint === accepted.fingerprint
          if (!currentMatches) {
            changed = detectFingerprintChanges(accepted.input, fingerprintInput)
          }
        } catch {
          currentMatches = undefined
        }
      }

      if (opts.json) {
        const result: Record<string, unknown> = {
          configured: !!accepted,
          killed: config?.auto?.killed ?? false,
        }

        if (accepted) {
          result.accepted = {
            fingerprint: accepted.fingerprint,
            acceptedAt: accepted.acceptedAt,
            cadence: accepted.cadence,
            attribution: accepted.attribution,
          }
          if (currentMatches !== undefined) {
            result.currentMatches = currentMatches
            if (!currentMatches) {
              result.changed = changed
            }
          }
        }

        const receipts = readReceipts(5)
        result.receipts = receipts
        try { result.schedule = await getScheduleStatus() } catch { /* best effort */ }

        process.stdout.write(JSON.stringify(result, null, 0) + '\n')
        return
      }

      if (!config?.auto?.accepted) {
        process.stdout.write('Automatic sync is not configured.\n')
        return
      }

      const acceptedRecord = config.auto.accepted
      if (typeof acceptedRecord.fingerprint !== 'string' || typeof acceptedRecord.acceptedAt !== 'string') {
        process.stdout.write('Automatic sync acceptance record is damaged. Run: codeburn sync auto enable --cadence <daily|hourly> --accept\n')
        process.exit(1)
        return
      }

      process.stdout.write(`Accepted fingerprint: ${acceptedRecord.fingerprint}\n`)
      process.stdout.write(`Accepted at: ${acceptedRecord.acceptedAt}\n`)
      process.stdout.write(`Cadence: ${acceptedRecord.cadence}\n`)

      if (currentMatches === true) {
        process.stdout.write('Current fingerprint: MATCHES\n')
      } else if (currentMatches === false) {
        process.stdout.write(`Current fingerprint: DIFFERS (${changed.join(', ')})\n`)
      } else {
        process.stdout.write('Current fingerprint: unable to recompute\n')
      }

      process.stdout.write(`Killed: ${config.auto.killed ? 'yes' : 'no'}\n`)
      try {
        const sched = await getScheduleStatus()
        process.stdout.write(`Schedule: ${sched.installed ? 'installed' : 'not installed'} (${sched.mechanism}${sched.detail ? `: ${sched.detail}` : ''})\n`)
      } catch { /* best effort */ }

      const receipts = readReceipts(5)
      if (receipts.length > 0) {
        process.stdout.write('\nLast 5 receipts:\n')
        for (const r of receipts) {
          process.stdout.write(`  ${r.at} - ${r.result}\n`)
        }
      }
    })

  // --- auto run ---
  auto
    .command('run')
    .description('Run automatic push (invoked by scheduler)')
    .option('--no-update', 'Do not install the team build first')
    .action(async (opts: { update?: boolean }) => {
      const config = readSyncConfig()
      const at = new Date().toISOString()

      if (config?.auto?.killed) {
        appendReceipt(buildReceipt(at, undefined, { result: 'killed' }))
        return
      }

      if (!config?.auto?.accepted) {
        appendReceipt(buildReceipt(at, undefined, { result: 'not-accepted' }))
        return
      }

      const accepted = config.auto.accepted

      try {
        // Refresh server capabilities first: the fingerprint must describe what
        // this run will actually send, and the server may now allow more.
        const discoveryDoc = await fetchDiscoveryDoc(config.baseUrl)
        refreshServerCapabilities(config, discoveryDoc)

        // A team server owns the CLI build: install its current one before pushing, then rerun on the new
        // files (this process still holds the old code). The rerun passes --no-update, so it cannot loop.
        if (opts.update !== false) {
          const installed = currentCliVersion()
          const outcome = await autoUpdateBeforeSync(config, installed, args => runSelf(args))
          if (outcome.action === 'updated') {
            appendReceipt(buildReceipt(at, undefined, { result: 'updated', from: outcome.from, to: outcome.to }))
            const rerun = await runSelf(['sync', 'auto', 'run', '--no-update'], { inherit: true })
            process.exitCode = rerun.code ?? 1
            return
          }
          if (outcome.action === 'failed') {
            // Keep syncing on the build we have; a stuck update must not stop usage from reaching the server.
            appendReceipt(buildReceipt(at, undefined, { result: 'update-failed', from: outcome.from, to: outcome.to, reason: outcome.reason }))
          }
        }

        // Recompute fingerprint
        const pluginLoads: PluginLoad[] = await loadPlugins()
        const pluginKeys = declaredSyncAttributes(pluginLoads)
        const allKeys = outboundKeysFor(config, pluginKeys)

        const fingerprintInput = buildAcceptanceFingerprintInput(config, allKeys, accepted.attribution, accepted.cadence)
        const currentFingerprint = computeAcceptanceFingerprint(fingerprintInput)

        if (currentFingerprint !== accepted.fingerprint && isReductionOnly(accepted.input, fingerprintInput)) {
          // Sending less (lower level / findings off) needs no new consent: refresh the stored acceptance silently.
          accepted.fingerprint = currentFingerprint
          accepted.input = fingerprintInput
          writeSyncConfig(config)
        }

        if (currentFingerprint !== accepted.fingerprint) {
          const changed = detectFingerprintChanges(accepted.input, fingerprintInput)
          appendReceipt(buildReceipt(
            at,
            currentFingerprint,
            { result: 'acceptance-required', changed }
          ))
          return
        }

        // Collect data - 7 day window. Sent-ledger prevents duplicates across runs,
        // so daily/hourly rescans don't lose anything.
        const { parseAllSessions } = await import('../parser.js')
        const { getDateRange } = await import('../cli-date.js')

        const range = getDateRange('week').range
        // No provider scope, so parseAllSessions applies the shared
        // aggregate-only rule: gateway daily aggregates are not pushed unless
        // the user opted in. The backend would double count them exactly the
        // way a local headline would. Payload schema is unchanged either way.
        const projects = (await parseAllSessions(range))
          .map(p => ({ ...p, project: wireProjectName(p.projectPath, p.project) }))

        const { readPlans } = await import('../config.js')
        const plans = await readPlans()

        const { loadDailyCache } = await import('../daily-cache.js')
        const dailyCache = await loadDailyCache()
        const coverageThrough = dailyCache.complete === true && dailyCache.watermarkTrusted === true && dailyCache.lastComputedDate
          ? dailyCache.lastComputedDate
          : undefined

        const { unsent } = collectUnsentCalls(projects, Date.now(), { plans })

        if (unsent.length === 0) {
          appendReceipt(buildReceipt(at, currentFingerprint, { result: 'pushed', spans: 0 }))
          return
        }

        const store = createCredentialStore()
        const rt = store.retrieve()
        if (!rt) {
          appendReceipt(buildReceipt(at, currentFingerprint, { result: 'error', reason: 'no auth token' }))
          return
        }

        const tokens = await resolveAccessToken(config, store, rt)

        // Collect attribution if enabled (sessions level only; executePush enforces too)
        let attributionUnsent: Awaited<ReturnType<typeof collectUnsentAttribution>>['unsent'] = []
        if (accepted.attribution && effectiveLevelFor(config) === 'sessions') {
          const { computeAttributionRecords } = await import('../yield.js')
          const records = computeAttributionRecords(projects, range, process.cwd())
          const collected = collectUnsentAttribution(records)
          attributionUnsent = collected.unsent
        }

        // Use shared push helper
        const pluginAttributeKeys: ReadonlySet<string> = new Set(pluginKeys.keys())
        const { result, attrFacts } = await executePush({
          config,
          unsent,
          attributionUnsent,
          pluginAttributeKeys,
          coverageThrough,
          tokens,
          silent: true,
          discoveryDoc,
        })

        if (result.outcome === 'complete') {
          const receipt: Record<string, unknown> = { result: 'pushed', spans: result.totalSent }
          if (attrFacts > 0) {
            receipt.attributionFacts = attrFacts
          }
          appendReceipt(buildReceipt(at, currentFingerprint, receipt as any))
        } else {
          appendReceipt(buildReceipt(at, currentFingerprint, { result: 'error', reason: result.outcome }))
        }
      } catch (err) {
        appendReceipt(buildReceipt(
          at,
          undefined,
          { result: 'error', reason: err instanceof Error ? err.message : String(err) }
        ))
      }
    })
}
