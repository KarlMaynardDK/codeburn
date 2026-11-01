import { describe, expect, it, vi } from 'vitest'

import { autoUpdateBeforeSync, autoUpdateWanted } from '../src/sync/auto-update.js'

const pkg = { version: '2.0.0', sha256: 'a'.repeat(64), path: '/install/codeburn-team-2.0.0.tgz' }
const team = { authMode: 'enrollment' as const, clientPackage: pkg }
const done = JSON.stringify({ type: 'step', component: 'cli', state: 'done' })

describe('autoUpdateWanted', () => {
  it('wants the server build when it differs from the installed one, either direction', () => {
    expect(autoUpdateWanted(team, '1.0.0', {})).toBe('2.0.0')
    expect(autoUpdateWanted(team, '3.0.0', {})).toBe('2.0.0')
  })

  it('does nothing when versions match, there is no package, or it is not a team enrollment', () => {
    expect(autoUpdateWanted(team, '2.0.0', {})).toBeNull()
    expect(autoUpdateWanted({ authMode: 'enrollment' }, '1.0.0', {})).toBeNull()
    expect(autoUpdateWanted({ authMode: 'oidc', clientPackage: pkg }, '1.0.0', {})).toBeNull()
    expect(autoUpdateWanted({ clientPackage: pkg }, '1.0.0', {})).toBeNull()
  })

  it('honours the config switch and the environment opt-out', () => {
    expect(autoUpdateWanted({ ...team, autoUpdate: false }, '1.0.0', {})).toBeNull()
    expect(autoUpdateWanted({ ...team, autoUpdate: true }, '1.0.0', {})).toBe('2.0.0')
    expect(autoUpdateWanted(team, '1.0.0', { CODEBURN_NO_AUTO_UPDATE: '1' })).toBeNull()
  })
})

describe('autoUpdateBeforeSync', () => {
  it('does not run anything when up to date', async () => {
    const run = vi.fn()
    expect(await autoUpdateBeforeSync(team, '2.0.0', run, {})).toEqual({ action: 'none' })
    expect(run).not.toHaveBeenCalled()
  })

  it('reports an install only when update --cli really replaced the CLI', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: `${done}\n`, stderr: '' })
    expect(await autoUpdateBeforeSync(team, '1.0.0', run, {})).toEqual({ action: 'updated', from: '1.0.0', to: '2.0.0' })
    expect(run).toHaveBeenCalledWith(['update', '--cli', '--json'])
  })

  it('treats a skipped update (exit 0, nothing installed) as a failure to keep the old build', async () => {
    const skipped = JSON.stringify({ type: 'step', component: 'cli', state: 'skipped', message: 'managed' })
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: `${skipped}\n`, stderr: '' })
    expect(await autoUpdateBeforeSync(team, '1.0.0', run, {})).toMatchObject({ action: 'failed' })
  })

  it('surfaces the update step error message on a non-zero exit', async () => {
    const err = JSON.stringify({ type: 'step', component: 'cli', state: 'error', message: 'checksum does not match' })
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: `${err}\n`, stderr: '' })
    expect(await autoUpdateBeforeSync(team, '1.0.0', run, {})).toEqual({
      action: 'failed', from: '1.0.0', to: '2.0.0', reason: 'checksum does not match',
    })
  })

  it('turns a spawn error into a failure instead of throwing', async () => {
    const run = vi.fn().mockRejectedValue(new Error('spawn ENOENT'))
    expect(await autoUpdateBeforeSync(team, '1.0.0', run, {})).toMatchObject({ action: 'failed', reason: 'spawn ENOENT' })
  })
})
