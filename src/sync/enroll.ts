/**
 * codeburn sync — team-server enrollment.
 *
 * Exchanges a one-time enrollment token for a long-lived device credential
 * (POST {enroll_path}). The credential is then used directly as the Bearer on
 * /v1/traces: there is no refresh grant and no IdP.
 */

import { hostname } from 'os'
import { assertHttps, fetchDiscoveryDoc } from './discovery.js'
import { getDeviceId } from './otlp.js'

export class EnrollError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnrollError'
  }
}

export interface EnrollResult {
  credential: string
  deviceId?: string
  person?: { name?: string; email?: string }
}

export async function enrollDevice(baseUrl: string, enrollPath: string, token: string): Promise<EnrollResult> {
  const url = `${baseUrl.replace(/\/$/, '')}${enrollPath}`
  assertHttps(url, 'Enroll endpoint')

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, label: hostname(), device_id: getDeviceId() }),
    })
  } catch (err) {
    throw new EnrollError(`Cannot reach ${url}: ${(err as Error).message}`)
  }

  if (response.status === 401) {
    throw new EnrollError('Enrollment token is invalid, expired or already used. Ask your admin for a new one.')
  }
  if (!response.ok) {
    throw new EnrollError(`Enrollment failed: ${url} returned HTTP ${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new EnrollError(`Enrollment failed: ${url} returned invalid JSON`)
  }
  const doc = (body ?? {}) as Record<string, unknown>
  if (typeof doc.credential !== 'string' || !doc.credential) {
    throw new EnrollError('Enrollment failed: server response had no credential')
  }
  const person = doc.person && typeof doc.person === 'object' ? doc.person as Record<string, unknown> : undefined
  return {
    credential: doc.credential,
    ...(typeof doc.device_id === 'string' ? { deviceId: doc.device_id } : {}),
    ...(person ? {
      person: {
        ...(typeof person.name === 'string' ? { name: person.name } : {}),
        ...(typeof person.email === 'string' ? { email: person.email } : {}),
      },
    } : {}),
  }
}

/**
 * Revokes this device's credential on the team server (POST {revoke_path}).
 * 'unsupported' when the server predates self-revocation; 'unknown' when it
 * no longer accepts the credential (already revoked). Throws when unreachable.
 */
export async function revokeDevice(baseUrl: string, credential: string): Promise<'revoked' | 'unknown' | 'unsupported'> {
  const discovery = await fetchDiscoveryDoc(baseUrl)
  if (!discovery.revoke_path) return 'unsupported'
  const url = `${baseUrl.replace(/\/$/, '')}${discovery.revoke_path}`
  assertHttps(url, 'Revoke endpoint')
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${credential}` } })
  } catch (err) {
    throw new EnrollError(`Cannot reach ${url}: ${(err as Error).message}`)
  }
  if (response.status === 401) return 'unknown'
  if (!response.ok) throw new EnrollError(`${url} returned HTTP ${response.status}`)
  return 'revoked'
}
