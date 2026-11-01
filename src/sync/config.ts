/**
 * codeburn sync — config file management.
 *
 * Stores non-secret sync configuration at ~/.config/codeburn/sync.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import type { AutoSyncConfig } from './consent.js'
import { parseClientPackage, type ClientPackageInfo, type DetailLevel } from './discovery.js'

export interface SyncConfig {
  baseUrl: string
  clientId: string
  tracesPath: string
  issuer: string
  lastSync?: string
  /** 'enrollment' = team server device credential; absent/'oidc' = OIDC refresh token. */
  authMode?: 'enrollment' | 'oidc'
  enrollPath?: string
  /** Detail levels the server advertised at setup/last discovery. */
  detailLevels?: DetailLevel[]
  findingsPath?: string
  orgName?: string
  /** CLI build advertised by the team server at last discovery; `codeburn update` installs it. */
  clientPackage?: ClientPackageInfo
  /** Client-chosen detail level (clamped to detailLevels). Absent: summary for enrollment, the legacy full span set for OIDC. */
  detailLevel?: DetailLevel
  /** Whether to share optimize findings (needs findingsPath). Default off. */
  shareFindings?: boolean
  /** YYYY-MM-DD (UTC) of the last successful findings upload. */
  lastFindingsSent?: string
  /** Team enrollments install the server's CLI build before a scheduled push. Default on; false turns it off. */
  autoUpdate?: boolean
  auto?: AutoSyncConfig
}

function configDir(): string {
  return join(homedir(), '.config', 'codeburn')
}

function configPath(): string {
  return join(configDir(), 'sync.json')
}

export function receiptsPath(): string {
  return join(configDir(), 'receipts.jsonl')
}

export function readSyncConfig(): SyncConfig | null {
  const path = configPath()
  if (!existsSync(path)) return null

  try {
    const raw = readFileSync(path, 'utf-8')
    const data = JSON.parse(raw) as Record<string, unknown>

    if (typeof data.baseUrl !== 'string' || typeof data.clientId !== 'string') {
      return null
    }

    return {
      baseUrl: data.baseUrl,
      clientId: data.clientId,
      tracesPath: typeof data.tracesPath === 'string' ? data.tracesPath : '/v1/traces',
      issuer: typeof data.issuer === 'string' ? data.issuer : '',
      lastSync: typeof data.lastSync === 'string' ? data.lastSync : undefined,
      ...(data.authMode === 'enrollment' || data.authMode === 'oidc' ? { authMode: data.authMode } : {}),
      ...(typeof data.enrollPath === 'string' ? { enrollPath: data.enrollPath } : {}),
      ...(Array.isArray(data.detailLevels)
        ? { detailLevels: data.detailLevels.filter((l): l is DetailLevel => l === 'summary' || l === 'sessions') }
        : {}),
      ...(typeof data.findingsPath === 'string' ? { findingsPath: data.findingsPath } : {}),
      ...(typeof data.orgName === 'string' ? { orgName: data.orgName } : {}),
      ...(parseClientPackage(data.clientPackage) ? { clientPackage: parseClientPackage(data.clientPackage)! } : {}),
      ...(data.detailLevel === 'summary' || data.detailLevel === 'sessions' ? { detailLevel: data.detailLevel } : {}),
      ...(typeof data.shareFindings === 'boolean' ? { shareFindings: data.shareFindings } : {}),
      ...(typeof data.lastFindingsSent === 'string' ? { lastFindingsSent: data.lastFindingsSent } : {}),
      ...(typeof data.autoUpdate === 'boolean' ? { autoUpdate: data.autoUpdate } : {}),
      auto: typeof data.auto === 'object' && data.auto ? (data.auto as AutoSyncConfig) : undefined,
    }
  } catch {
    return null
  }
}

export function writeSyncConfig(config: SyncConfig): void {
  const dir = configDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n')
}

export function updateLastSync(): void {
  const config = readSyncConfig()
  if (!config) return
  config.lastSync = new Date().toISOString()
  writeSyncConfig(config)
}

export function deleteSyncConfig(): void {
  try { unlinkSync(configPath()) } catch { /* may not exist */ }
}

export function readReceipts(limit?: number): Array<Record<string, unknown>> {
  const path = receiptsPath()
  if (!existsSync(path)) return []

  try {
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.trim().split('\n').filter(Boolean)
    const entries = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    if (limit && limit > 0) return entries.slice(-limit)
    return entries
  } catch {
    return []
  }
}

export function appendReceipt(receipt: Record<string, unknown>): void {
  const dir = configDir()
  mkdirSync(dir, { recursive: true })
  const path = receiptsPath()
  // Ensure directory exists immediately before write (handles race conditions)
  mkdirSync(dir, { recursive: true })
  const line = JSON.stringify(receipt) + '\n'
  writeFileSync(path, line, { flag: 'a' })
}
